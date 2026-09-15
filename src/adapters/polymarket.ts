import { fetchJson } from "./http.js";
import type { MarketFee, MarketToken, NormalizedMarket, OutcomeSide } from "../core/types.js";

interface PolyFeeScheduleRaw {
  exponent?: number;
  rate?: number;
  takerOnly?: boolean;
}

interface PolyMarketRaw {
  id?: string;
  conditionId?: string;
  slug?: string;
  question?: string;
  description?: string;
  resolutionSource?: string;
  endDate?: string;
  endDateIso?: string;
  bestBid?: number | string;
  bestAsk?: number | string;
  lastTradePrice?: number | string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  feesEnabled?: boolean;
  feeSchedule?: PolyFeeScheduleRaw;
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

function parseStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseOutcomePrices(value: PolyMarketRaw["outcomePrices"]): number[] {
  return parseStringArray(value).map(Number).filter(Number.isFinite);
}

function outcomeSide(value: string): OutcomeSide | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") return "YES";
  if (normalized === "no") return "NO";
  return undefined;
}

function parseTokens(raw: PolyMarketRaw): MarketToken[] | undefined {
  const outcomes = parseStringArray(raw.outcomes);
  const tokenIds = parseStringArray(raw.clobTokenIds);
  const tokens: MarketToken[] = [];

  for (let index = 0; index < Math.min(outcomes.length, tokenIds.length); index += 1) {
    const side = outcomeSide(outcomes[index] ?? "");
    const tokenId = tokenIds[index]?.trim();
    if (side && tokenId) tokens.push({ side, tokenId });
  }

  return tokens.length > 0 ? tokens : undefined;
}

function parseFee(raw: PolyMarketRaw): MarketFee | undefined {
  if (raw.feesEnabled === undefined && !raw.feeSchedule) return undefined;
  const rate = numberOrUndefined(raw.feeSchedule?.rate);
  const exponent = numberOrUndefined(raw.feeSchedule?.exponent);
  return {
    enabled: raw.feesEnabled ?? rate !== undefined,
    ...(rate !== undefined ? { rate } : {}),
    ...(exponent !== undefined ? { exponent } : {}),
    ...(raw.feeSchedule?.takerOnly !== undefined ? { takerOnly: raw.feeSchedule.takerOnly } : {})
  };
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
  const tokens = parseTokens(raw);
  const fee = parseFee(raw);

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
    ...(raw.resolutionSource ? { resolutionSource: raw.resolutionSource } : {}),
    ...(closeTime ? { closeTime } : {}),
    ...(tokens ? { tokens } : {}),
    ...(fee ? { fee } : {}),
    ...(raw.slug ? { sourceUrl: `https://polymarket.com/market/${raw.slug}` } : {})
  };
}

export interface PolymarketOptions {
  pageSize?: number;
  maxPages?: number;
}

export async function fetchPolymarketMarkets(options: PolymarketOptions = {}): Promise<NormalizedMarket[]> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  const maxPages = Math.max(options.maxPages ?? 100, 1);
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
