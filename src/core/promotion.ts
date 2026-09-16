import { evaluateMatcherQuality, relationPairKey, type MatcherQualityReport, type RelationLabel } from "./quality.js";
import { heuristicSignature, semanticDecisionSignature, type ShadowVerificationObservation } from "./semantic-verifier.js";
import type { MarketRelation, RelationType } from "./types.js";

const ARB_ELIGIBLE = new Set<RelationType>([
  "EQUIVALENT",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);

export interface SemanticPromotionPolicy {
  model: string;
  promptVersion: string;
  matcherVersion: string;
  maximumEvidenceAgeMs: number;
  minimumLabeledPairs: number;
  minimumRetainedArbPredictions: number;
  maximumFalseArbRateUpperBound: number;
  minimumArbPrecisionGain: number;
  minimumMicroPrecisionDelta: number;
  minimumRecallDelta: number;
  minimumSemanticConfidence: number;
  confidenceZ: number;
}

export interface SemanticPromotionReport {
  eligible: boolean;
  model: string;
  promptVersion: string;
  matcherVersion: string;
  evaluatedAt: string;
  evidenceCutoffAt: string;
  oldestEvidenceAt: string | null;
  newestEvidenceAt: string | null;
  newestEvidenceAgeMs: number | null;
  historicalRuns: number;
  observations: number;
  labeledPairs: number;
  retainedArbPredictions: number;
  baselineArbPrecision: number | null;
  candidateArbPrecision: number | null;
  arbPrecisionGain: number | null;
  falseArbRateUpperBound: number | null;
  baseline: MatcherQualityReport;
  candidate: MatcherQualityReport;
  policy: SemanticPromotionPolicy;
  reasons: string[];
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function wilsonUpperBound(failures: number, trials: number, z = 1.96): number | null {
  if (!Number.isFinite(failures) || !Number.isFinite(trials) || trials <= 0 || failures < 0 || failures > trials) {
    return null;
  }
  const p = failures / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return round(Math.min(1, center + margin));
}

function heuristicRelation(observation: ShadowVerificationObservation): MarketRelation | undefined {
  if (!observation.heuristicType) return undefined;
  return {
    leftId: observation.leftId,
    rightId: observation.rightId,
    type: observation.heuristicType,
    confidence: observation.heuristicConfidence ?? 0,
    evidence: ["promotion_baseline=shadow_observation"],
    ...(observation.heuristicDirection ? { direction: observation.heuristicDirection } : {})
  };
}

function vetoCandidate(
  observation: ShadowVerificationObservation,
  minimumSemanticConfidence: number
): MarketRelation | undefined {
  const heuristic = heuristicRelation(observation);
  if (!heuristic) return undefined;
  if (!ARB_ELIGIBLE.has(heuristic.type)) return heuristic;
  if (observation.confidence < minimumSemanticConfidence) return undefined;
  if (semanticDecisionSignature(observation) !== heuristicSignature(heuristic)) return undefined;
  return heuristic;
}

function arbPrecision(report: MatcherQualityReport): number | null {
  if (report.evaluatedArbPredictions === 0 || report.falseArbRate === null) return null;
  return round(1 - report.falseArbRate);
}

function delta(candidate: number | null, baseline: number | null): number | null {
  if (candidate === null || baseline === null) return null;
  return round(candidate - baseline);
}

function validTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function latestObservationsByPair(
  observations: readonly ShadowVerificationObservation[]
): ShadowVerificationObservation[] {
  const latest = new Map<string, ShadowVerificationObservation>();
  for (const observation of observations) {
    const key = relationPairKey(observation.leftId, observation.rightId);
    const existing = latest.get(key);
    if (!existing || observation.observedAt > existing.observedAt) latest.set(key, observation);
  }
  return [...latest.values()].sort((a, b) => a.pairKey.localeCompare(b.pairKey));
}

export function evaluateSemanticPromotion(
  observations: readonly ShadowVerificationObservation[],
  labels: readonly RelationLabel[],
  policy: SemanticPromotionPolicy,
  historicalRuns: number,
  nowMs = Date.now()
): SemanticPromotionReport {
  const maximumEvidenceAgeMs = Number.isFinite(policy.maximumEvidenceAgeMs) && policy.maximumEvidenceAgeMs > 0
    ? policy.maximumEvidenceAgeMs
    : 1;
  const cutoffMs = nowMs - maximumEvidenceAgeMs;
  const matching = observations.filter((observation) =>
    observation.model === policy.model &&
    observation.promptVersion === policy.promptVersion &&
    observation.matcherVersion === policy.matcherVersion
  );
  const fresh = matching.filter((observation) => {
    const observedAt = validTimestamp(observation.observedAt);
    return observedAt !== undefined && observedAt >= cutoffMs && observedAt <= nowMs;
  });
  const latest = latestObservationsByPair(fresh);
  const observationKeys = new Set(latest.map((observation) => relationPairKey(observation.leftId, observation.rightId)));
  const evaluatedLabels = labels.filter((label) =>
    label.source !== "PSEUDO" && observationKeys.has(relationPairKey(label.leftId, label.rightId))
  );
  const labeledKeys = new Set(evaluatedLabels.map((label) => relationPairKey(label.leftId, label.rightId)));
  const labeledObservations = latest.filter((observation) => labeledKeys.has(relationPairKey(observation.leftId, observation.rightId)));

  const baselinePredictions = labeledObservations.flatMap((observation) => {
    const relation = heuristicRelation(observation);
    return relation ? [relation] : [];
  });
  const candidatePredictions = labeledObservations.flatMap((observation) => {
    const relation = vetoCandidate(observation, policy.minimumSemanticConfidence);
    return relation ? [relation] : [];
  });

  const baseline = evaluateMatcherQuality(baselinePredictions, evaluatedLabels);
  const candidate = evaluateMatcherQuality(candidatePredictions, evaluatedLabels);
  const baselineArbPrecision = arbPrecision(baseline);
  const candidateArbPrecision = arbPrecision(candidate);
  const arbPrecisionGain = delta(candidateArbPrecision, baselineArbPrecision);
  const falseArbRateUpperBound = wilsonUpperBound(
    candidate.falseArbPredictions,
    candidate.evaluatedArbPredictions,
    policy.confidenceZ
  );
  const microPrecisionDelta = delta(candidate.micro.precision, baseline.micro.precision);
  const recallDelta = delta(candidate.micro.recall, baseline.micro.recall);
  const evidenceTimes = latest
    .map((observation) => validTimestamp(observation.observedAt))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const oldestEvidenceMs = evidenceTimes[0];
  const newestEvidenceMs = evidenceTimes.at(-1);
  const reasons: string[] = [];

  if (historicalRuns < 1) reasons.push("no_completed_historical_runs");
  if (matching.length === 0) reasons.push("no_matcher_pinned_evidence");
  else if (fresh.length === 0) reasons.push("promotion_evidence_expired");
  if (evaluatedLabels.length < policy.minimumLabeledPairs) {
    reasons.push(`insufficient_labeled_pairs:${evaluatedLabels.length}<${policy.minimumLabeledPairs}`);
  }
  if (candidate.evaluatedArbPredictions < policy.minimumRetainedArbPredictions) {
    reasons.push(`insufficient_retained_arb_predictions:${candidate.evaluatedArbPredictions}<${policy.minimumRetainedArbPredictions}`);
  }
  if (falseArbRateUpperBound === null || falseArbRateUpperBound > policy.maximumFalseArbRateUpperBound) {
    reasons.push(`false_arb_upper_bound_exceeded:${falseArbRateUpperBound ?? "null"}>${policy.maximumFalseArbRateUpperBound}`);
  }
  if (arbPrecisionGain === null || arbPrecisionGain < policy.minimumArbPrecisionGain) {
    reasons.push(`arb_precision_gain_too_small:${arbPrecisionGain ?? "null"}<${policy.minimumArbPrecisionGain}`);
  }
  if (microPrecisionDelta === null || microPrecisionDelta < policy.minimumMicroPrecisionDelta) {
    reasons.push(`micro_precision_regression:${microPrecisionDelta ?? "null"}<${policy.minimumMicroPrecisionDelta}`);
  }
  if (recallDelta === null || recallDelta < policy.minimumRecallDelta) {
    reasons.push(`recall_regression:${recallDelta ?? "null"}<${policy.minimumRecallDelta}`);
  }
  if (
    baseline.falseArbRate !== null &&
    candidate.falseArbRate !== null &&
    candidate.falseArbRate > baseline.falseArbRate
  ) {
    reasons.push(`false_arb_rate_regression:${candidate.falseArbRate}>${baseline.falseArbRate}`);
  }

  return {
    eligible: reasons.length === 0,
    model: policy.model,
    promptVersion: policy.promptVersion,
    matcherVersion: policy.matcherVersion,
    evaluatedAt: new Date(nowMs).toISOString(),
    evidenceCutoffAt: new Date(cutoffMs).toISOString(),
    oldestEvidenceAt: oldestEvidenceMs === undefined ? null : new Date(oldestEvidenceMs).toISOString(),
    newestEvidenceAt: newestEvidenceMs === undefined ? null : new Date(newestEvidenceMs).toISOString(),
    newestEvidenceAgeMs: newestEvidenceMs === undefined ? null : Math.max(0, nowMs - newestEvidenceMs),
    historicalRuns,
    observations: latest.length,
    labeledPairs: evaluatedLabels.length,
    retainedArbPredictions: candidate.evaluatedArbPredictions,
    baselineArbPrecision,
    candidateArbPrecision,
    arbPrecisionGain,
    falseArbRateUpperBound,
    baseline,
    candidate,
    policy,
    reasons
  };
}
