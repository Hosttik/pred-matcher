import { fetchJson } from "./http.js";
import type { NormalizedMarket } from "../core/types.js";

interface PolyMarketRaw {
  id?: string;
  conditionId?: string;
  slug?: string;
  question?: string;
  description?: string;
  endDate?: string;
  endDateIso?: string;
  bestBid?: number | string;
  bestAsk?: number | string;
  lastTradePrice?: number | string;
  outcomePrices?: string | string[];
}

interface PolyPage {
  markets?: PolyMarketRaw[];
  next_cursor?: string;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseOutcomePrices(value: PolyMarketRaw["outcomePrices"]): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function normalize(raw: PolyMarketRaw): NormalizedMarket | undefined {
  const externalId = raw.id ?? raw.conditionId;
  const title = raw.question?.trim();
  if (!externalId || !title) return undefined;

  const outcomePrices = parseOutcomePrices(raw.outcomePrices);
  const yesBid = numberOrUndefined(raw.bestBid);
  const yesAsk = numberOrUndefined(raw.bestAsk);
  const last = numberOrUndefined(raw.lastTradePrice) ?? outcomePrices[0];
  const closeTime = raw.endDateIso ?? raw.endDate;

  return {
    id: `polymarket:${externalId}`,
    venue: "polymarket",
    externalId,
    title,
    prices: {
      ...(yesBid !== undefined ? { yesBid } : {}),
      ...(yesAsk !== undefined ? { yesAsk } : {}),
      ...(last !== undefined ? { last } : {})
    },
    ...(raw.description ? { rules: raw.description } : {}),
    ...(closeTime ? { closeTime } : {}),
    ...(raw.slug ? { sourceUrl: `https://polymarket.com/market/${raw.slug}` } : {})
  };
}

export interface PolymarketOptions {
  pageSize?: number;
  maxPages?: number;
}

export async function fetchPolymarketMarkets(options: PolymarketOptions = {}): Promise<NormalizedMarket[]> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 500, 1), 500);
  const maxPages = Math.max(options.maxPages ?? 20, 1);
  const markets: NormalizedMarket[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("https://gamma-api.polymarket.com/markets/keyset");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("after_cursor", cursor);

    const response = await fetchJson<PolyPage>(url);
    for (const raw of response.markets ?? []) {
      const market = normalize(raw);
      if (market) markets.push(market);
    }
    cursor = response.next_cursor;
    if (!cursor || (response.markets?.length ?? 0) === 0) break;
  }

  return markets;
}
