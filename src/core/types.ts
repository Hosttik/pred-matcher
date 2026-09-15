export type Venue = "polymarket" | "kalshi";
export type OutcomeSide = "YES" | "NO";

export interface MarketPrices {
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  yesBidSize?: number;
  yesAskSize?: number;
  noBidSize?: number;
  noAskSize?: number;
  last?: number;
}

export interface MarketToken {
  side: OutcomeSide;
  tokenId: string;
}

export interface MarketFee {
  enabled: boolean;
  rate?: number;
  exponent?: number;
  takerOnly?: boolean;
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
  tokens?: MarketToken[];
  fee?: MarketFee;
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

export type OpportunityType = "EQUIVALENT_ARB" | "IMPLICATION_ARB";

export interface OpportunityLeg {
  marketId: string;
  venue: Venue;
  side: OutcomeSide;
  ask: number;
  availableShares?: number;
}

export interface OpportunityFeeAssessment {
  status: "NOT_INCLUDED";
  reason: string;
}

export interface MarketOpportunity {
  id: string;
  type: OpportunityType;
  relationType: RelationType;
  relationConfidence: number;
  legs: [OpportunityLeg, OpportunityLeg];
  grossCostPerShare: number;
  guaranteedPayoutPerShare: 1;
  grossEdgePerShare: number;
  grossEdgePercent: number;
  maxShares?: number;
  grossProfitAtTop?: number;
  fees: OpportunityFeeAssessment;
}

export interface SyncResult {
  fetched: Record<Venue, number>;
  totalMarkets: number;
  candidatePairs: number;
  relations: number;
  opportunities: number;
  syncedAt: string;
}
