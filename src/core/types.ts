export type Venue = "polymarket" | "kalshi";

export interface MarketPrices {
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  last?: number;
}

export interface MarketStructure {
  strikeType?: string;
  floorStrike?: number;
  capStrike?: number;
  functionalStrike?: string;
  earlyCloseCondition?: string;
}

export interface NormalizedMarket {
  id: string;
  venue: Venue;
  externalId: string;
  eventId?: string;
  title: string;
  subtitle?: string;
  rules?: string;
  resolutionSource?: string;
  closeTime?: string;
  prices: MarketPrices;
  structure?: MarketStructure;
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

export type ContractFieldSource = "venue" | "text" | "fallback";

export interface ContractSpec {
  subjectText: string;
  predicateText: string;
  threshold?: number;
  comparator?: Comparator;
  deadline?: string;
  resolutionSource?: string;
  earlyCloseCondition?: string;
  rulesText?: string;
  fieldSources: {
    threshold?: ContractFieldSource;
    comparator?: ContractFieldSource;
    deadline?: ContractFieldSource;
    resolutionSource?: ContractFieldSource;
  };
}

export type ResolutionCompatibility = "MATCH" | "MISMATCH" | "UNKNOWN";

export interface ContractComparison {
  subjectSimilarity: number;
  rulesSimilarity: number | null;
  resolutionCompatibility: ResolutionCompatibility;
  differences: string[];
}

export type RelationType =
  | "EQUIVALENT"
  | "SIMILAR"
  | "THRESHOLD_NESTED"
  | "TIME_NESTED"
  | "IMPLIES";

export interface MarketRelation {
  leftId: string;
  rightId: string;
  type: RelationType;
  confidence: number;
  evidence: string[];
  direction?: "LEFT_IMPLIES_RIGHT" | "RIGHT_IMPLIES_LEFT";
  comparison?: ContractComparison;
}

export interface SyncResult {
  fetched: Record<Venue, number>;
  totalMarkets: number;
  candidatePairs: number;
  relations: number;
  syncedAt: string;
}
