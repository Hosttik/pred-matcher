export type Venue = "polymarket" | "kalshi";

export interface MarketPrices {
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  last?: number;
}

export interface NormalizedMarket {
  id: string;
  venue: Venue;
  externalId: string;
  eventId?: string;
  title: string;
  subtitle?: string;
  rules?: string;
  closeTime?: string;
  prices: MarketPrices;
  sourceUrl?: string;
}

export type Comparator = ">" | ">=" | "<" | "<=";

export interface MarketFeatures {
  normalizedText: string;
  tokens: string[];
  subjectText: string;
  threshold?: number;
  comparator?: Comparator;
  deadline?: string;
}

export type RelationType =
  | "EQUIVALENT"
  | "THRESHOLD_NESTED"
  | "TIME_NESTED";

export interface MarketRelation {
  leftId: string;
  rightId: string;
  type: RelationType;
  confidence: number;
  evidence: string[];
  direction?: "LEFT_IMPLIES_RIGHT" | "RIGHT_IMPLIES_LEFT";
}

export interface SyncResult {
  fetched: Record<Venue, number>;
  totalMarkets: number;
  candidatePairs: number;
  relations: number;
  syncedAt: string;
}
