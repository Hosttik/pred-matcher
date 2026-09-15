import { postJson } from "./http.js";
import type { MarketPrices, NormalizedMarket, OutcomeSide } from "../core/types.js";

interface BookLevelRaw {
  price?: string;
  size?: string;
}

interface OrderBookRaw {
  asset_id?: string;
  bids?: BookLevelRaw[];
  asks?: BookLevelRaw[];
}

interface TokenRef {
  marketId: string;
  tokenId: string;
  side: OutcomeSide;
}

interface TopLevel {
  price: number;
  size: number;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function topLevel(levels: readonly BookLevelRaw[] | undefined, best: "MIN" | "MAX"): TopLevel | undefined {
  const parsed = (levels ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0);
  if (parsed.length === 0) return undefined;

  const price = best === "MIN"
    ? Math.min(...parsed.map((level) => level.price))
    : Math.max(...parsed.map((level) => level.price));
  const size = parsed
    .filter((level) => level.price === price)
    .reduce((sum, level) => sum + level.size, 0);
  return { price, size };
}

function tokenRefs(markets: readonly NormalizedMarket[], marketIds: ReadonlySet<string>): TokenRef[] {
  const refs: TokenRef[] = [];
  for (const market of markets) {
    if (market.venue !== "polymarket" || !marketIds.has(market.id)) continue;
    for (const token of market.tokens ?? []) {
      refs.push({ marketId: market.id, tokenId: token.tokenId, side: token.side });
    }
  }
  return refs;
}

function applyBook(prices: MarketPrices, side: OutcomeSide, book: OrderBookRaw): MarketPrices {
  const ask = topLevel(book.asks, "MIN");
  const bid = topLevel(book.bids, "MAX");

  if (side === "YES") {
    return {
      ...prices,
      ...(ask ? { yesAsk: ask.price, yesAskSize: ask.size } : {}),
      ...(bid ? { yesBid: bid.price, yesBidSize: bid.size } : {})
    };
  }

  return {
    ...prices,
    ...(ask ? { noAsk: ask.price, noAskSize: ask.size } : {}),
    ...(bid ? { noBid: bid.price, noBidSize: bid.size } : {})
  };
}

export async function hydratePolymarketOrderBooks(
  markets: readonly NormalizedMarket[],
  marketIds: ReadonlySet<string>
): Promise<NormalizedMarket[]> {
  const refs = tokenRefs(markets, marketIds);
  if (refs.length === 0) return [...markets];

  const refByToken = new Map(refs.map((ref) => [ref.tokenId, ref]));
  const marketById = new Map(markets.map((market) => [market.id, market]));
  const updates = new Map<string, MarketPrices>();

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
        const market = marketById.get(ref.marketId);
        if (!market) continue;
        const current = updates.get(ref.marketId) ?? market.prices;
        updates.set(ref.marketId, applyBook(current, ref.side, book));
      }
    } catch {
      // Keep Gamma top-of-book data when one CLOB batch is temporarily unavailable.
    }
  }

  return markets.map((market) => {
    const prices = updates.get(market.id);
    return prices ? { ...market, prices } : market;
  });
}
