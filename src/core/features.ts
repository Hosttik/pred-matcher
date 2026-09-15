import type { Comparator, MarketFeatures, NormalizedMarket } from "./types.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "before", "by", "for", "from",
  "in", "is", "of", "on", "or", "the", "to", "will", "with"
]);

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11
};

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[$€£,]/g, "")
    .replace(/[^a-z0-9.%<>+=-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function parseCompactNumber(raw: string, suffix?: string): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (!suffix) return value;
  const multiplier = suffix.toLowerCase() === "k" ? 1_000
    : suffix.toLowerCase() === "m" ? 1_000_000
      : suffix.toLowerCase() === "b" ? 1_000_000_000
        : 1;
  return value * multiplier;
}

export function extractThreshold(text: string): { threshold?: number; comparator?: Comparator } {
  const normalized = normalizeText(text);
  const symbolMatch = normalized.match(/(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (symbolMatch?.[1] && symbolMatch[2]) {
    const threshold = parseCompactNumber(symbolMatch[2], symbolMatch[3]);
    if (threshold !== undefined) {
      return { threshold, comparator: symbolMatch[1] as Comparator };
    }
  }

  const phraseMatch = normalized.match(/\b(above|over|exceed(?:s|ed)?|greater than|below|under|less than)\s+(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (phraseMatch?.[1] && phraseMatch[2]) {
    const threshold = parseCompactNumber(phraseMatch[2], phraseMatch[3]);
    if (threshold !== undefined) {
      const lower = phraseMatch[1].toLowerCase();
      return { threshold, comparator: ["below", "under", "less than"].includes(lower) ? "<" : ">" };
    }
  }

  return {};
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month, day, 23, 59, 59));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function extractDeadline(text: string, fallback?: string): string | undefined {
  const normalized = text.toLowerCase();
  const monthDate = normalized.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(20\d{2})\b/i);
  if (monthDate?.[1] && monthDate[2] && monthDate[3]) {
    const month = MONTHS[monthDate[1].toLowerCase()];
    if (month !== undefined) return isoDate(Number(monthDate[3]), month, Number(monthDate[2]));
  }

  const endOfYear = normalized.match(/(?:before|by)\s+(20\d{2})\b/i);
  if (endOfYear?.[1]) return isoDate(Number(endOfYear[1]), 11, 31);

  if (fallback) {
    const parsed = new Date(fallback);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return undefined;
}

function removeStructuralTokens(tokens: string[]): string[] {
  return tokens.filter((token) => !/^\d+(?:\.\d+)?[kmb]?$/.test(token) && !(token in MONTHS));
}

export function extractFeatures(market: NormalizedMarket): MarketFeatures {
  const source = [market.title, market.subtitle ?? "", market.rules ?? ""].join(" ");
  const normalizedText = normalizeText(source);
  const tokens = tokenize(source);
  const threshold = extractThreshold(source);
  const deadline = extractDeadline(source, market.closeTime);
  const subjectText = [...new Set(removeStructuralTokens(tokenize(market.title)))].sort().join(" ");

  return {
    normalizedText,
    tokens,
    subjectText,
    ...(threshold.threshold !== undefined ? { threshold: threshold.threshold } : {}),
    ...(threshold.comparator !== undefined ? { comparator: threshold.comparator } : {}),
    ...(deadline !== undefined ? { deadline } : {})
  };
}
