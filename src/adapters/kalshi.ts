import { fetchJson } from "./http.js";
import type { MarketStructure, NormalizedMarket } from "../core/types.js";

interface KalshiMarketRaw {
  ticker?: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  rules_primary?: string;
  rules_secondary?: string;
  close_time?: string;
  expected_expiration_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  functional_strike?: string;
  early_close_condition?: string;
}

interface KalshiPage {
  markets?: KalshiMarketRaw[];
  cursor?: string;
}

function price(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function structure(raw: KalshiMarketRaw): MarketStructure | undefined {
  const value: MarketStructure = {
    ...(raw.strike_type ? { strikeType: raw.strike_type } : {}),
    ...(Number.isFinite(raw.floor_strike) ? { floorStrike: raw.floor_strike } : {}),
    ...(Number.isFinite(raw.cap_strike) ? { capStrike: raw.cap_strike } : {}),
    ...(raw.functional_strike ? { functionalStrike: raw.functional_strike } : {}),
    ...(raw.early_close_condition ? { earlyCloseCondition: raw.early_close_condition } : {})
  };
  return Object.keys(value).length > 0 ? value : undefined;
}

function normalize(raw: KalshiMarketRaw): NormalizedMarket | undefined {
  const externalId = raw.ticker?.trim();
  const title = raw.title?.trim();
  if (!externalId || !title) return undefined;

  const rules = [raw.rules_primary, raw.rules_secondary].filter(Boolean).join("\n\n") || undefined;
  const subtitle = raw.subtitle ?? raw.yes_sub_title;
  const closeTime = raw.expected_expiration_time ?? raw.close_time;
  const yesBid = price(raw.yes_bid_dollars);
  const yesAsk = price(raw.yes_ask_dollars);
  const noBid = price(raw.no_bid_dollars);
  const noAsk = price(raw.no_ask_dollars);
  const last = price(raw.last_price_dollars);
  const marketStructure = structure(raw);

  return {
    id: `kalshi:${externalId}`,
    venue: "kalshi",
    externalId,
    ...(raw.event_ticker ? { eventId: raw.event_ticker } : {}),
    title,
    prices: {
      ...(yesBid !== undefined ? { yesBid } : {}),
      ...(yesAsk !== undefined ? { yesAsk } : {}),
      ...(noBid !== undefined ? { noBid } : {}),
      ...(noAsk !== undefined ? { noAsk } : {}),
      ...(last !== undefined ? { last } : {})
    },
    ...(subtitle ? { subtitle } : {}),
    ...(rules ? { rules } : {}),
    ...(closeTime ? { closeTime } : {}),
    ...(marketStructure ? { structure: marketStructure } : {})
  };
}

export interface KalshiOptions {
  pageSize?: number;
  maxPages?: number;
}

export async function fetchKalshiMarkets(options: KalshiOptions = {}): Promise<NormalizedMarket[]> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 1000, 1), 1000);
  const maxPages = Math.max(options.maxPages ?? 20, 1);
  const markets: NormalizedMarket[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("https://external-api.kalshi.com/trade-api/v2/markets");
    url.searchParams.set("status", "open");
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetchJson<KalshiPage>(url);
    for (const raw of response.markets ?? []) {
      const market = normalize(raw);
      if (market) markets.push(market);
    }
    cursor = response.cursor;
    if (!cursor || (response.markets?.length ?? 0) === 0) break;
  }

  return markets;
}
