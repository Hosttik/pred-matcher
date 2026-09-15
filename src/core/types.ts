export type Venue = "polymarket" | "kalshi";
export type OutcomeSide = "YES" | "NO";

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OutcomeOrderBook {
  asks: OrderBookLevel[];
  bids?: OrderBookLevel[];
  capturedAt: string;
  sourceTimestamp?: string;
}

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

export type FeeModel = "POLYMARKET_CURVE" | "KALSHI_QUADRATIC" | "UNSUPPORTED";

export interface MarketFee {
  enabled: boolean;
  model?: FeeModel;
  rate?: number;
  exponent?: number;
  multiplier?: number;
  feeType?: string;
  takerOnly?: boolean;
  source?: "gamma" | "clob" | "series" | "event_override";
}

export interface MarketExecutionMetadata {
  minOrderSize?: number;
  tickSize?: number;
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
  conditionId?: string;
  eventId?: string;
  seriesTicker?: string;
  title: string;
  subtitle?: string;
  rules?: string;
  resolutionSource?: string;
  closeTime?: string;
  prices: MarketPrices;
  books?: Partial<Record<OutcomeSide, OutcomeOrderBook>>;
  tokens?: MarketToken[];
  fee?: MarketFee;
  execution?: MarketExecutionMetadata;
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

export interface ExecutedLegQuote {
  marketId: string;
  venue: Venue;
  side: OutcomeSide;
  shares: number;
  positionCost: number;
  fee: number;
  totalCost: number;
  vwap: number;
  worstPrice: number;
}

export interface ExecutionQuote {
  shares: number;
  legs: [ExecutedLegQuote, ExecutedLegQuote];
  grossPositionCost: number;
  totalFees: number;
  netCost: number;
  guaranteedPayout: number;
  netProfit: number;
  netEdgePerShare: number;
  netEdgePercent: number;
}

export interface OpportunityFeeAssessment {
  status: "INCLUDED";
  models: [FeeModel, FeeModel];
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
  maxExecutableShares: number;
  maxProfitableShares: number;
  bestExecution: ExecutionQuote;
  targetExecution?: ExecutionQuote;
  oldestQuoteAt: string;
  quoteAgeMs: number;
  staleAfterMs: number;
  isStale: boolean;
  fees: OpportunityFeeAssessment;
}

export type OpportunityHistoryKind = "OPEN" | "UPDATE" | "CLOSE";

export interface OpportunityHistoryEvent {
  sequence: number;
  kind: OpportunityHistoryKind;
  opportunityId: string;
  capturedAt: string;
  type: OpportunityType;
  relationType: RelationType;
  netEdgePerShare: number;
  netProfit: number;
  maxProfitableShares: number;
  quoteAgeMs: number;
}

export type LiveConnectionStatus = "DISCONNECTED" | "CONNECTING" | "LIVE" | "DEGRADED" | "ERROR";

export interface LiveVenueState {
  venue: Venue;
  status: LiveConnectionStatus;
  subscribedMarkets: number;
  connections?: number;
  lastMessageAt?: string;
  reconnects: number;
  error?: string;
  reason?: string;
}

export interface LiveScannerStatus {
  running: boolean;
  startedAt?: string;
  updatesApplied: number;
  recomputations: number;
  venues: Record<Venue, LiveVenueState>;
}

export interface IncrementalUpdateResult {
  marketId: string;
  affectedRelations: number;
  opportunities: MarketOpportunity[];
  history: OpportunityHistoryEvent[];
  persistenceError?: string;
}

export interface SyncResult {
  fetched: Record<Venue, number>;
  totalMarkets: number;
  candidatePairs: number;
  relations: number;
  opportunities: number;
  syncedAt: string;
}
