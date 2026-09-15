import { fetchJson } from "./http.js";
import type {
  MarketFee,
  NormalizedMarket,
  OrderBookLevel,
  OutcomeOrderBook
} from "../core/types.js";

interface KalshiOrderBookRaw {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

interface KalshiEventRaw {
  event?: {
    series_ticker?: string;
    fee_type_override?: string;
    fee_multiplier_override?: number;
  };
}

interface KalshiSeriesRaw {
  series?: {
    ticker?: string;
    fee_type?: string;
    fee_multiplier?: number;
  };
}

interface EventFeeInfo {
  seriesTicker?: string;
  feeTypeOverride?: string;
  feeMultiplierOverride?: number;
}

interface SeriesFeeInfo {
  feeType?: string;
  feeMultiplier?: number;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function parseBidLevels(raw: readonly [string, string][] | undefined): OrderBookLevel[] {
  return (raw ?? [])
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter((level) =>
      Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
      Number.isFinite(level.size) && level.size > 0
    )
    .sort((a, b) => b.price - a.price);
}

function asksFromOppositeBids(bids: readonly OrderBookLevel[]): OrderBookLevel[] {
  return bids
    .map((level) => ({ price: 1 - level.price, size: level.size }))
    .sort((a, b) => a.price - b.price);
}

async function fetchEvent(eventId: string): Promise<EventFeeInfo> {
  try {
    const response = await fetchJson<KalshiEventRaw>(
      new URL(`https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(eventId)}`)
    );
    const event = response.event;
    return {
      ...(event?.series_ticker ? { seriesTicker: event.series_ticker } : {}),
      ...(event?.fee_type_override ? { feeTypeOverride: event.fee_type_override } : {}),
      ...(Number.isFinite(event?.fee_multiplier_override) ? { feeMultiplierOverride: event?.fee_multiplier_override } : {})
    };
  } catch {
    return {};
  }
}

async function fetchSeries(seriesTicker: string): Promise<SeriesFeeInfo> {
  try {
    const response = await fetchJson<KalshiSeriesRaw>(
      new URL(`https://external-api.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`)
    );
    const series = response.series;
    return {
      ...(series?.fee_type ? { feeType: series.fee_type } : {}),
      ...(Number.isFinite(series?.fee_multiplier) ? { feeMultiplier: series?.fee_multiplier } : {})
    };
  } catch {
    return {};
  }
}

function feeFromMetadata(event: EventFeeInfo, series: SeriesFeeInfo | undefined): MarketFee {
  const feeType = event.feeTypeOverride ?? series?.feeType;
  const multiplier = event.feeMultiplierOverride ?? series?.feeMultiplier;
  const source = event.feeTypeOverride !== undefined || event.feeMultiplierOverride !== undefined
    ? "event_override" as const
    : "series" as const;

  if (
    (feeType === "quadratic" || feeType === "quadratic_with_maker_fees") &&
    multiplier !== undefined && Number.isFinite(multiplier) && multiplier >= 0
  ) {
    return {
      enabled: multiplier > 0,
      model: "KALSHI_QUADRATIC",
      rate: 0.07,
      multiplier,
      feeType,
      takerOnly: true,
      source
    };
  }

  return {
    enabled: true,
    model: "UNSUPPORTED",
    ...(feeType ? { feeType } : {}),
    ...(multiplier !== undefined && Number.isFinite(multiplier) ? { multiplier } : {}),
    source
  };
}

async function hydrateOrderBook(market: NormalizedMarket): Promise<NormalizedMarket> {
  try {
    const url = new URL(`https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(market.externalId)}/orderbook`);
    url.searchParams.set("depth", "100");
    const response = await fetchJson<KalshiOrderBookRaw>(url);
    const capturedAt = new Date().toISOString();
    const yesBids = parseBidLevels(response.orderbook_fp?.yes_dollars);
    const noBids = parseBidLevels(response.orderbook_fp?.no_dollars);
    const yesAsks = asksFromOppositeBids(noBids);
    const noAsks = asksFromOppositeBids(yesBids);
    const yesBook: OutcomeOrderBook = { asks: yesAsks, bids: yesBids, capturedAt };
    const noBook: OutcomeOrderBook = { asks: noAsks, bids: noBids, capturedAt };
    const bestYesAsk = yesAsks[0];
    const bestNoAsk = noAsks[0];
    const bestYesBid = yesBids[0];
    const bestNoBid = noBids[0];

    return {
      ...market,
      books: { YES: yesBook, NO: noBook },
      prices: {
        ...market.prices,
        ...(bestYesAsk ? { yesAsk: bestYesAsk.price, yesAskSize: bestYesAsk.size } : {}),
        ...(bestNoAsk ? { noAsk: bestNoAsk.price, noAskSize: bestNoAsk.size } : {}),
        ...(bestYesBid ? { yesBid: bestYesBid.price, yesBidSize: bestYesBid.size } : {}),
        ...(bestNoBid ? { noBid: bestNoBid.price, noBidSize: bestNoBid.size } : {})
      }
    };
  } catch {
    return market;
  }
}

export async function hydrateKalshiExecutionData(
  markets: readonly NormalizedMarket[],
  marketIds: ReadonlySet<string>
): Promise<NormalizedMarket[]> {
  const relevant = markets.filter((market) => market.venue === "kalshi" && marketIds.has(market.id));
  if (relevant.length === 0) return [...markets];

  const eventIds = [...new Set(relevant.map((market) => market.eventId).filter((value): value is string => Boolean(value)))];
  const events = new Map<string, EventFeeInfo>();
  for (const batch of chunks(eventIds, 20)) {
    const results = await Promise.all(batch.map(async (eventId) => [eventId, await fetchEvent(eventId)] as const));
    for (const [eventId, info] of results) events.set(eventId, info);
  }

  const seriesTickers = [...new Set([...events.values()].map((info) => info.seriesTicker).filter((value): value is string => Boolean(value)))];
  const series = new Map<string, SeriesFeeInfo>();
  for (const batch of chunks(seriesTickers, 20)) {
    const results = await Promise.all(batch.map(async (ticker) => [ticker, await fetchSeries(ticker)] as const));
    for (const [ticker, info] of results) series.set(ticker, info);
  }

  const updated = new Map(markets.map((market) => [market.id, market]));
  for (const batch of chunks(relevant, 20)) {
    const hydrated = await Promise.all(batch.map(hydrateOrderBook));
    for (const market of hydrated) {
      const event = market.eventId ? events.get(market.eventId) ?? {} : {};
      const seriesTicker = event.seriesTicker;
      const fee = feeFromMetadata(event, seriesTicker ? series.get(seriesTicker) : undefined);
      updated.set(market.id, {
        ...market,
        fee,
        ...(seriesTicker ? { seriesTicker } : {})
      });
    }
  }

  return markets.map((market) => updated.get(market.id) ?? market);
}
