import { relationPairKey, type MatcherQualityReport, type RelationDirection } from "./quality.js";
import type { MarketRelation, NormalizedMarket, RelationType } from "./types.js";

export type SemanticRelationType = RelationType | "NONE";

export interface SemanticVerifierPair {
  pairKey: string;
  left: NormalizedMarket;
  right: NormalizedMarket;
}

export interface SemanticVerifierDecision {
  pairKey: string;
  leftId: string;
  rightId: string;
  type: SemanticRelationType;
  direction?: RelationDirection;
  confidence: number;
  evidence: string[];
  materialDifferences: string[];
}

export interface SemanticVerifier {
  readonly provider: string;
  readonly model: string;
  verify(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierDecision[]>;
}

export type ShadowRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface ShadowVerificationObservation extends SemanticVerifierDecision {
  runId: string;
  provider: string;
  model: string;
  observedAt: string;
  heuristicType: RelationType | null;
  heuristicConfidence: number | null;
  heuristicDirection?: RelationDirection;
}

export interface ShadowRunRecord {
  runId: string;
  status: ShadowRunStatus;
  provider: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  retrievedPairs: number;
  selectedPairs: number;
  verifiedPairs: number;
  labeledPairs: number;
  disagreements: number;
  heuristicReport?: MatcherQualityReport;
  shadowReport?: MatcherQualityReport;
  error?: string;
}

export function semanticDecisionToRelation(decision: SemanticVerifierDecision): MarketRelation | undefined {
  if (decision.type === "NONE") return undefined;
  return {
    leftId: decision.leftId,
    rightId: decision.rightId,
    type: decision.type,
    confidence: decision.confidence,
    evidence: [
      ...decision.evidence.map((value) => `shadow_evidence=${value}`),
      ...decision.materialDifferences.map((value) => `shadow_difference=${value}`)
    ],
    ...(decision.direction ? { direction: decision.direction } : {})
  };
}

export function semanticDecisionSignature(decision: SemanticVerifierDecision): string {
  return `${decision.type}:${decision.direction ?? "NONE"}`;
}

export function heuristicSignature(relation: MarketRelation | undefined): string {
  return relation ? `${relation.type}:${relation.direction ?? "NONE"}` : "NONE:NONE";
}

export function semanticPair(left: NormalizedMarket, right: NormalizedMarket): SemanticVerifierPair {
  return {
    pairKey: relationPairKey(left.id, right.id),
    left,
    right
  };
}
