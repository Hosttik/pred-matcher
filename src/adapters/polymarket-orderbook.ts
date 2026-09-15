import { fetchJson, postJson } from "./http.js";
import type {
  MarketFee,
  NormalizedMarket,
  OrderBookLevel,
  OutcomeOrderBook,
  OutcomeSide
} from "../core/types.js";

interface BookLevelRaw {
  price?: string;
  size?: string;
}

interface OrderBookRaw {
  asset_id?: string;
  timestamp?: string;
  bids?: BookLevelRaw[];
  asks?: BookLevelRaw[];
}

interface ClobFeeDetailsRaw {
  r?: number;
  e?: number;
  to?: boolean;
}

interface ClobMarketInfoRaw {
  mos?: number;
  mts?: number;
  fd?: ClobFeeDetailsRaw | null;
}

interface TokenRef {
  marketId: string;
  tokenId: string;
  side: OutcomeSide;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function parseLevels(levels: readonly BookLevelRaw[] | undefined, direction: "ASC" | "DESC"): OrderBookLevel[] {
  const parsed = (levels ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) =>
      Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
      Number.isFinite(level.size) && level.size > 0
    );
  return parsed.sort((a, b) => direction === "ASC" ? a.price - b.price : b.price - a.price);
}

function timestampIso(raw?: string): string {
  if (raw) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
      const date = new Date(millis);
      if (!Number.isNaN(date.valueOf())) return date.toISOString();
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function tokenRefs(markets: readonly NormalizedMarket[], marketIds: ReadonlySet<string>): TokenRef[] {
  const refs: TokenRef[] = [];
  for (const market of markets) {
    if (market.venue !== "polymarket" || !marketIds.has(market.id)) continue;
    for (const token of market.tokens ?? []) refs.push({ marketId: market.id, tokenId: token.tokenId, side: token.side });
  }
  return refs;
}

function applyBook(market: NormalizedMarket, side: OutcomeSide, book: OrderBookRaw): NormalizedMarket {
  const asks = parseLevels(book.asks, "ASC");
  const bids = parseLevels(book.bids, "DESC");
  const capturedAt = timestampIso(book.timestamp);
  const sideBook: OutcomeOrderBook = {
    asks,
    bids,
    capturedAt,
    ...(book.timestamp ? { sourceTimestamp: book.timestamp } : {})
  };
  const bestAsk = asks[0];
  const bestBid = bids[0];

  const prices = side === "YES"
    ? {
        ...market.prices,
        ...(bestAsk ? { yesAsk: bestAsk.price, yesAskSize: bestAsk.size } : {}),
        ...(bestBid ? { yesBid: bestBid.price, yesBidSize: bestBid.size } : {})
      }
    : {
        ...market.prices,
        ...(bestAsk ? { noAsk: bestAsk.price, noAskSize: bestAsk.size } : {}),
        ...(bestBid ? { noBid: bestBid.price, noBidSize: bestBid.size } : {})
      };

  return {
    ...market,
    prices,
    books: { ...(market.books ?? {}), [side]: sideBook }
  };
}

function clobFee(info: ClobMarketInfoRaw, fallback?: MarketFee): MarketFee | undefined {
  if (info.fd === undefined) return fallback;
  if (info.fd === null) {
    return { enabled: false, model: "POLYMARKET_CURVE", rate: 0, takerOnly: true, source: "clob" };
  }
  const rate = Number(info.fd.r);
  if (!Number.isFinite(rate) || rate < 0) {
    return { enabled: true, model: "UNSUPPORTED", source: "clob" };
  }
  const exponent = Number(info.fd.e);
  return {
    enabled: rate > 0,
    model: "POLYMARKET_CURVE",
    rate,
    source: "clob",
    ...(Number.isFinite(exponent) ? { exponent } : {}),
    ...(info.fd.to !== undefined ? { takerOnly: info.fd.to } : {})
  };
}

async function hydrateMarketInfo(market: NormalizedMarket): Promise<NormalizedMarket> {
  if (market.venue !== "polymarket" || !market.conditionId) return market;
  try {
    const info = await fetchJson<ClobMarketInfoRaw>(
      new URL(`https://clob.polymarket.com/clob-markets/${encodeURIComponent(market.conditionId)}`)
    );
    const fee = clobFee(info, market.fee);
    return {
      ...market,
      ...(fee ? { fee } : {}),
      execution: {
        ...(market.execution ?? {}),
        ...(Number.isFinite(info.mos) && (info.mos ?? 0) > 0 ? { minOrderSize: info.mos } : {}),
        ...(Number.isFinite(info.mts) && (info.mts ?? 0) > 0 ? { tickSize: info.mts } : {})
      }
    };
  } catch {
    return market;
  }
}

export async function hydratePolymarketOrderBooks(
  markets: readonly NormalizedMarket[],
  marketIds: ReadonlySet<string>
): Promise<NormalizedMarket[]> {
  const refs = tokenRefs(markets, marketIds);
  if (refs.length === 0) return [...markets];

  const refByToken = new Map(refs.map((ref) => [ref.tokenId, ref]));
  const updated = new Map(markets.map((market) => [market.id, market]));

  for (const batch of chunks(refs, 100)) {
    try {
      const books = await postJson<OrderBookRaw[]>(
        new URL("https://clob.polymarket.com/books"),
        batch.map((ref) => ({ token_id: ref.tokenId }))
      );
      for (const book of books) {
        if (!book.asset_id) continue;
        const ref = refByToken.get(book.asset_id);
        if (!ref) continue;
        const market = updated.get(ref.marketId);
        if (!market) continue;
        updated.set(ref.marketId, applyBook(market, ref.side, book));
      }
    } catch {
      // Fail closed later: markets without full depth do not become executable opportunities.
    }
  }

  const relevant = [...updated.values()].filter((market) => market.venue === "polymarket" && marketIds.has(market.id));
  for (const batch of chunks(relevant, 20)) {
    const hydrated = await Promise.all(batch.map(hydrateMarketInfo));
    for (const market of hydrated) updated.set(market.id, market);
  }

  return markets.map((market) => updated.get(market.id) ?? market);
}
