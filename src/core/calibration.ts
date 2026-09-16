import { DEFAULT_MINIMUM_CANDIDATE_SCORE, matchMarkets } from "./matcher.js";
import { evaluateMatcherQuality, type MatcherQualityReport, type RelationLabel } from "./quality.js";
import type { HistoricalDatasetFrame } from "./dataset.js";
import type { MarketRelation, RelationType } from "./types.js";

const ARB_ELIGIBLE = new Set<RelationType>([
  "EQUIVALENT",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);

export interface MatcherCalibrationConfig {
  minimumCandidateScore: number;
  minimumArbConfidence: number;
}

export interface CalibrationPolicy {
  maxFalseArbRate?: number;
  minimumMicroRecall?: number;
  minimumArbPredictions?: number;
  minimumLabeledPairs?: number;
}

export interface CalibrationPoint {
  config: MatcherCalibrationConfig;
  candidatePairs: number;
  predictedRelations: number;
  report: MatcherQualityReport;
  eligible: boolean;
}

export interface CalibrationReport {
  frames: number;
  labels: number;
  candidateScores: number[];
  arbConfidenceThresholds: number[];
  points: CalibrationPoint[];
  pareto: CalibrationPoint[];
  recommended: CalibrationPoint | null;
  generatedAt: string;
}

export interface RegressionPolicy {
  maxFalseArbRate?: number;
  maxFalseArbRateIncrease?: number;
  maxMicroPrecisionDrop?: number;
  maxMicroRecallDrop?: number;
  minimumLabeledPairs?: number;
  minimumArbPredictions?: number;
}

export interface RegressionGateResult {
  pass: boolean;
  baseline: MatcherQualityReport;
  candidate: MatcherQualityReport;
  policy: Required<RegressionPolicy>;
  deltas: {
    falseArbRate: number | null;
    microPrecision: number | null;
    microRecall: number | null;
  };
  reasons: string[];
  evaluatedAt: string;
}

export interface MatcherEvaluationResult {
  candidatePairs: number;
  predictions: MarketRelation[];
  report: MatcherQualityReport;
}

const DEFAULT_CANDIDATE_SCORES = [0.2, 0.26, DEFAULT_MINIMUM_CANDIDATE_SCORE, 0.38, 0.44];
const DEFAULT_ARB_CONFIDENCE_THRESHOLDS = [0, 0.72, 0.76, 0.8, 0.84, 0.88, 0.92];

function boundedProbability(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function uniqueSorted(values: readonly number[], fallback: readonly number[]): number[] {
  const normalized = values
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    .map((value) => Number(value.toFixed(6)));
  return [...new Set(normalized.length > 0 ? normalized : fallback)].sort((a, b) => a - b);
}

function confidenceFilter(relations: readonly MarketRelation[], minimumArbConfidence: number): MarketRelation[] {
  return relations.filter((relation) => {
    if (!ARB_ELIGIBLE.has(relation.type)) return true;
    return relation.confidence >= minimumArbConfidence;
  });
}

export function evaluateMatcherOnFrames(
  frames: readonly HistoricalDatasetFrame[],
  labels: readonly RelationLabel[],
  config: MatcherCalibrationConfig = {
    minimumCandidateScore: DEFAULT_MINIMUM_CANDIDATE_SCORE,
    minimumArbConfidence: 0
  }
): MatcherEvaluationResult {
  const minimumCandidateScore = boundedProbability(config.minimumCandidateScore, DEFAULT_MINIMUM_CANDIDATE_SCORE);
  const minimumArbConfidence = boundedProbability(config.minimumArbConfidence, 0);
  const predictions: MarketRelation[] = [];
  let candidatePairs = 0;

  for (const frame of frames) {
    const matched = matchMarkets(frame.markets, minimumCandidateScore);
    candidatePairs += matched.candidatePairs;
    predictions.push(...confidenceFilter(matched.relations, minimumArbConfidence));
  }

  return {
    candidatePairs,
    predictions,
    report: evaluateMatcherQuality(predictions, labels)
  };
}

function calibrationEligible(report: MatcherQualityReport, policy: Required<CalibrationPolicy>): boolean {
  if (report.labeledPairs < policy.minimumLabeledPairs) return false;
  if (report.evaluatedArbPredictions < policy.minimumArbPredictions) return false;
  if (report.falseArbRate === null || report.falseArbRate > policy.maxFalseArbRate) return false;
  if (report.micro.recall === null || report.micro.recall < policy.minimumMicroRecall) return false;
  return true;
}

function dominates(left: CalibrationPoint, right: CalibrationPoint): boolean {
  const leftFalseArb = left.report.falseArbRate ?? 1;
  const rightFalseArb = right.report.falseArbRate ?? 1;
  const leftRecall = left.report.micro.recall ?? 0;
  const rightRecall = right.report.micro.recall ?? 0;
  const leftPrecision = left.report.micro.precision ?? 0;
  const rightPrecision = right.report.micro.precision ?? 0;

  const noWorse = leftFalseArb <= rightFalseArb && leftRecall >= rightRecall && leftPrecision >= rightPrecision;
  const strictlyBetter = leftFalseArb < rightFalseArb || leftRecall > rightRecall || leftPrecision > rightPrecision;
  return noWorse && strictlyBetter;
}

function recommendation(points: readonly CalibrationPoint[]): CalibrationPoint | null {
  const eligible = points.filter((point) => point.eligible);
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => {
    const recall = (b.report.micro.recall ?? 0) - (a.report.micro.recall ?? 0);
    if (recall !== 0) return recall;
    const precision = (b.report.micro.precision ?? 0) - (a.report.micro.precision ?? 0);
    if (precision !== 0) return precision;
    const arbPredictions = b.report.evaluatedArbPredictions - a.report.evaluatedArbPredictions;
    if (arbPredictions !== 0) return arbPredictions;
    return b.config.minimumArbConfidence - a.config.minimumArbConfidence;
  })[0] ?? null;
}

export function calibrateMatcher(
  frames: readonly HistoricalDatasetFrame[],
  labels: readonly RelationLabel[],
  options: {
    candidateScores?: readonly number[];
    arbConfidenceThresholds?: readonly number[];
    policy?: CalibrationPolicy;
  } = {}
): CalibrationReport {
  const candidateScores = uniqueSorted(options.candidateScores ?? [], DEFAULT_CANDIDATE_SCORES);
  const arbConfidenceThresholds = uniqueSorted(
    options.arbConfidenceThresholds ?? [],
    DEFAULT_ARB_CONFIDENCE_THRESHOLDS
  );
  const policy: Required<CalibrationPolicy> = {
    maxFalseArbRate: boundedProbability(options.policy?.maxFalseArbRate ?? 0, 0),
    minimumMicroRecall: boundedProbability(options.policy?.minimumMicroRecall ?? 0, 0),
    minimumArbPredictions: Math.max(0, Math.floor(options.policy?.minimumArbPredictions ?? 1)),
    minimumLabeledPairs: Math.max(0, Math.floor(options.policy?.minimumLabeledPairs ?? 1))
  };

  const points: CalibrationPoint[] = [];
  for (const minimumCandidateScore of candidateScores) {
    for (const minimumArbConfidence of arbConfidenceThresholds) {
      const evaluated = evaluateMatcherOnFrames(frames, labels, {
        minimumCandidateScore,
        minimumArbConfidence
      });
      points.push({
        config: { minimumCandidateScore, minimumArbConfidence },
        candidatePairs: evaluated.candidatePairs,
        predictedRelations: evaluated.predictions.length,
        report: evaluated.report,
        eligible: calibrationEligible(evaluated.report, policy)
      });
    }
  }

  const pareto = points.filter((point) => !points.some((other) => other !== point && dominates(other, point)));
  return {
    frames: frames.length,
    labels: labels.length,
    candidateScores,
    arbConfidenceThresholds,
    points,
    pareto,
    recommended: recommendation(points),
    generatedAt: new Date().toISOString()
  };
}

function metricDelta(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  return Number((candidate - baseline).toFixed(6));
}

export function compareQualityRegression(
  baseline: MatcherQualityReport,
  candidate: MatcherQualityReport,
  policy: RegressionPolicy = {}
): RegressionGateResult {
  const resolved: Required<RegressionPolicy> = {
    maxFalseArbRate: boundedProbability(policy.maxFalseArbRate ?? 0, 0),
    maxFalseArbRateIncrease: boundedProbability(policy.maxFalseArbRateIncrease ?? 0, 0),
    maxMicroPrecisionDrop: boundedProbability(policy.maxMicroPrecisionDrop ?? 0, 0),
    maxMicroRecallDrop: boundedProbability(policy.maxMicroRecallDrop ?? 0, 0),
    minimumLabeledPairs: Math.max(0, Math.floor(policy.minimumLabeledPairs ?? 1)),
    minimumArbPredictions: Math.max(0, Math.floor(policy.minimumArbPredictions ?? 1))
  };
  const reasons: string[] = [];

  if (candidate.labeledPairs < resolved.minimumLabeledPairs) {
    reasons.push(`insufficient_labeled_pairs:${candidate.labeledPairs}<${resolved.minimumLabeledPairs}`);
  }
  if (candidate.evaluatedArbPredictions < resolved.minimumArbPredictions) {
    reasons.push(`insufficient_arb_predictions:${candidate.evaluatedArbPredictions}<${resolved.minimumArbPredictions}`);
  }

  if (candidate.falseArbRate === null) {
    reasons.push("candidate_false_arb_rate_unavailable");
  } else {
    if (candidate.falseArbRate > resolved.maxFalseArbRate) {
      reasons.push(`false_arb_rate_above_cap:${candidate.falseArbRate}>${resolved.maxFalseArbRate}`);
    }
    const baselineRate = baseline.falseArbRate ?? 0;
    if (candidate.falseArbRate - baselineRate > resolved.maxFalseArbRateIncrease) {
      reasons.push(
        `false_arb_rate_regression:${Number((candidate.falseArbRate - baselineRate).toFixed(6))}>${resolved.maxFalseArbRateIncrease}`
      );
    }
  }

  if (baseline.micro.precision !== null) {
    if (candidate.micro.precision === null) {
      reasons.push("candidate_micro_precision_unavailable");
    } else if (baseline.micro.precision - candidate.micro.precision > resolved.maxMicroPrecisionDrop) {
      reasons.push(
        `micro_precision_regression:${Number((baseline.micro.precision - candidate.micro.precision).toFixed(6))}>${resolved.maxMicroPrecisionDrop}`
      );
    }
  }

  if (baseline.micro.recall !== null) {
    if (candidate.micro.recall === null) {
      reasons.push("candidate_micro_recall_unavailable");
    } else if (baseline.micro.recall - candidate.micro.recall > resolved.maxMicroRecallDrop) {
      reasons.push(
        `micro_recall_regression:${Number((baseline.micro.recall - candidate.micro.recall).toFixed(6))}>${resolved.maxMicroRecallDrop}`
      );
    }
  }

  return {
    pass: reasons.length === 0,
    baseline,
    candidate,
    policy: resolved,
    deltas: {
      falseArbRate: metricDelta(baseline.falseArbRate, candidate.falseArbRate),
      microPrecision: metricDelta(baseline.micro.precision, candidate.micro.precision),
      microRecall: metricDelta(baseline.micro.recall, candidate.micro.recall)
    },
    reasons,
    evaluatedAt: new Date().toISOString()
  };
}
