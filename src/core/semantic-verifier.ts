import { relationPairKey, type MatcherQualityReport, type RelationDirection } from "./quality.js";
import type { MarketRelation, NormalizedMarket, RelationType } from "./types.js";

export type SemanticRelationType = RelationType | "NONE";
export type ShadowRunSource = "LIVE" | "HISTORICAL";
export type ShadowExperimentStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

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

export interface SemanticVerifierUsage {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCostUsd: number | null;
  pricingSnapshot?: string;
}

export interface SemanticVerifierBatchResult {
  decisions: SemanticVerifierDecision[];
  usage: SemanticVerifierUsage;
}

export interface SemanticVerifier {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion?: string;
  verify(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierDecision[]>;
  verifyDetailed?(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierBatchResult>;
}

export type ShadowRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface ShadowVerificationObservation extends SemanticVerifierDecision {
  runId: string;
  provider: string;
  model: string;
  promptVersion?: string;
  matcherVersion?: string;
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
  promptVersion?: string;
  matcherVersion?: string;
  source?: ShadowRunSource;
  experimentId?: string;
  startedAt: string;
  completedAt?: string;
  retrievedPairs: number;
  selectedPairs: number;
  verifiedPairs: number;
  labeledPairs: number;
  disagreements: number;
  snapshots?: number;
  usage?: SemanticVerifierUsage;
  heuristicReport?: MatcherQualityReport;
  shadowReport?: MatcherQualityReport;
  error?: string;
}

export interface ShadowModelComparison {
  leftModel: string;
  rightModel: string;
  comparedPairs: number;
  disagreements: number;
  agreementRate: number | null;
}

export interface ShadowExperimentRecord {
  experimentId: string;
  status: ShadowExperimentStatus;
  promptVersion: string;
  matcherVersion?: string;
  source: "HISTORICAL";
  startedAt: string;
  completedAt?: string;
  snapshots: number;
  uniquePairs: number;
  models: string[];
  runIds: string[];
  comparisons: ShadowModelComparison[];
  reviewCandidates: number;
  usage: SemanticVerifierUsage;
  error?: string;
}

export interface ShadowReviewCandidate {
  experimentId: string;
  pairKey: string;
  leftId: string;
  rightId: string;
  priority: number;
  reason: "MODEL_DISAGREEMENT" | "HEURISTIC_DISAGREEMENT" | "GOLD_LABEL_DISAGREEMENT";
  heuristicSignature: string;
  modelSignatures: Record<string, string>;
  models: string[];
  createdAt: string;
}

export function emptySemanticVerifierUsage(): SemanticVerifierUsage {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    estimatedCostUsd: 0
  };
}

export function mergeSemanticVerifierUsage(left: SemanticVerifierUsage, right: SemanticVerifierUsage): SemanticVerifierUsage {
  const cost = left.estimatedCostUsd === null || right.estimatedCostUsd === null
    ? null
    : Number((left.estimatedCostUsd + right.estimatedCostUsd).toFixed(8));
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    latencyMs: left.latencyMs + right.latencyMs,
    estimatedCostUsd: cost,
    ...(left.pricingSnapshot && left.pricingSnapshot === right.pricingSnapshot
      ? { pricingSnapshot: left.pricingSnapshot }
      : right.pricingSnapshot && left.requests === 0
        ? { pricingSnapshot: right.pricingSnapshot }
        : {})
  };
}

export async function verifySemanticBatch(verifier: SemanticVerifier, pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierBatchResult> {
  if (verifier.verifyDetailed) return verifier.verifyDetailed(pairs);
  const started = Date.now();
  const decisions = await verifier.verify(pairs);
  return {
    decisions,
    usage: {
      requests: pairs.length > 0 ? 1 : 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: Date.now() - started,
      estimatedCostUsd: null
    }
  };
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
  return { pairKey: relationPairKey(left.id, right.id), left, right };
}
