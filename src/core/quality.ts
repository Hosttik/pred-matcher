import type { MarketRelation, RelationType } from "./types.js";

export type RelationDirection = NonNullable<MarketRelation["direction"]>;
export type RelationLabelType = RelationType | "NONE";
export type RelationLabelSource = "MANUAL" | "ADJUDICATED" | "PSEUDO";

export interface RelationLabel {
  leftId: string;
  rightId: string;
  type: RelationLabelType;
  direction?: RelationDirection;
  source: RelationLabelSource;
  labeledAt: string;
  notes?: string;
}

export interface MatcherMetricBucket {
  support: number;
  predicted: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface MatcherQualityReport {
  labeledPairs: number;
  predictedPairs: number;
  unlabeledPredictions: number;
  duplicatePredictions: number;
  exactMatches: number;
  wrongTypeOrDirection: number;
  missingPredictions: number;
  evaluatedArbPredictions: number;
  falseArbPredictions: number;
  falseArbRate: number | null;
  micro: Pick<MatcherMetricBucket, "truePositive" | "falsePositive" | "falseNegative" | "precision" | "recall" | "f1">;
  byType: Record<RelationType, MatcherMetricBucket>;
  evaluatedAt: string;
}

const RELATION_TYPES: RelationType[] = [
  "EQUIVALENT",
  "SIMILAR",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
];

const ARB_ELIGIBLE = new Set<RelationType>([
  "EQUIVALENT",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);

function invertDirection(direction: RelationDirection | undefined): RelationDirection | undefined {
  if (direction === "LEFT_IMPLIES_RIGHT") return "RIGHT_IMPLIES_LEFT";
  if (direction === "RIGHT_IMPLIES_LEFT") return "LEFT_IMPLIES_RIGHT";
  return undefined;
}

export function relationPairKey(leftId: string, rightId: string): string {
  return JSON.stringify(leftId <= rightId ? [leftId, rightId] : [rightId, leftId]);
}

export function normalizeRelationLabel(label: RelationLabel): RelationLabel {
  if (label.leftId <= label.rightId) {
    return {
      leftId: label.leftId,
      rightId: label.rightId,
      type: label.type,
      source: label.source,
      labeledAt: label.labeledAt,
      ...(label.direction ? { direction: label.direction } : {}),
      ...(label.notes ? { notes: label.notes } : {})
    };
  }
  const direction = invertDirection(label.direction);
  return {
    leftId: label.rightId,
    rightId: label.leftId,
    type: label.type,
    source: label.source,
    labeledAt: label.labeledAt,
    ...(direction ? { direction } : {}),
    ...(label.notes ? { notes: label.notes } : {})
  };
}

interface NormalizedRelation {
  leftId: string;
  rightId: string;
  type: RelationType;
  direction?: RelationDirection;
  confidence: number;
}

function normalizeRelation(relation: MarketRelation): NormalizedRelation {
  if (relation.leftId <= relation.rightId) {
    return {
      leftId: relation.leftId,
      rightId: relation.rightId,
      type: relation.type,
      confidence: relation.confidence,
      ...(relation.direction ? { direction: relation.direction } : {})
    };
  }
  const direction = invertDirection(relation.direction);
  return {
    leftId: relation.rightId,
    rightId: relation.leftId,
    type: relation.type,
    confidence: relation.confidence,
    ...(direction ? { direction } : {})
  };
}

function directionMatters(type: RelationLabelType): boolean {
  return type === "THRESHOLD_NESTED" || type === "TIME_NESTED" || type === "IMPLIES";
}

function matches(prediction: NormalizedRelation, label: RelationLabel): boolean {
  if (prediction.type !== label.type) return false;
  if (!directionMatters(label.type)) return true;
  return prediction.direction === label.direction;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
}

function bucket(): MatcherMetricBucket {
  return {
    support: 0,
    predicted: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    precision: null,
    recall: null,
    f1: null
  };
}

function finalize(value: MatcherMetricBucket): MatcherMetricBucket {
  const precision = ratio(value.truePositive, value.truePositive + value.falsePositive);
  const recall = ratio(value.truePositive, value.truePositive + value.falseNegative);
  return { ...value, precision, recall, f1: f1(precision, recall) };
}

export function evaluateMatcherQuality(
  predictions: readonly MarketRelation[],
  labels: readonly RelationLabel[]
): MatcherQualityReport {
  const normalizedLabels = labels.map(normalizeRelationLabel);
  const labelsByPair = new Map(normalizedLabels.map((label) => [relationPairKey(label.leftId, label.rightId), label]));
  const predictionsByPair = new Map<string, NormalizedRelation>();
  let duplicatePredictions = 0;

  for (const relation of predictions.map(normalizeRelation)) {
    const key = relationPairKey(relation.leftId, relation.rightId);
    const existing = predictionsByPair.get(key);
    if (existing) {
      duplicatePredictions += 1;
      if (existing.confidence >= relation.confidence) continue;
    }
    predictionsByPair.set(key, relation);
  }

  const byType = Object.fromEntries(RELATION_TYPES.map((type) => [type, bucket()])) as Record<RelationType, MatcherMetricBucket>;
  let exactMatches = 0;
  let wrongTypeOrDirection = 0;
  let missingPredictions = 0;
  let falseArbPredictions = 0;
  let evaluatedArbPredictions = 0;
  let microTp = 0;
  let microFp = 0;
  let microFn = 0;

  for (const [key, label] of labelsByPair) {
    const prediction = predictionsByPair.get(key);
    if (label.type !== "NONE") byType[label.type].support += 1;

    if (!prediction) {
      if (label.type !== "NONE") {
        byType[label.type].falseNegative += 1;
        microFn += 1;
        missingPredictions += 1;
      }
      continue;
    }

    byType[prediction.type].predicted += 1;
    if (ARB_ELIGIBLE.has(prediction.type)) evaluatedArbPredictions += 1;

    if (label.type !== "NONE" && matches(prediction, label)) {
      byType[prediction.type].truePositive += 1;
      microTp += 1;
      exactMatches += 1;
      continue;
    }

    byType[prediction.type].falsePositive += 1;
    microFp += 1;
    if (ARB_ELIGIBLE.has(prediction.type)) falseArbPredictions += 1;

    if (label.type !== "NONE") {
      byType[label.type].falseNegative += 1;
      microFn += 1;
      wrongTypeOrDirection += 1;
    }
  }

  const unlabeledPredictions = [...predictionsByPair.keys()].filter((key) => !labelsByPair.has(key)).length;
  const finalized = Object.fromEntries(
    RELATION_TYPES.map((type) => [type, finalize(byType[type])])
  ) as Record<RelationType, MatcherMetricBucket>;
  const precision = ratio(microTp, microTp + microFp);
  const recall = ratio(microTp, microTp + microFn);

  return {
    labeledPairs: labelsByPair.size,
    predictedPairs: predictionsByPair.size,
    unlabeledPredictions,
    duplicatePredictions,
    exactMatches,
    wrongTypeOrDirection,
    missingPredictions,
    evaluatedArbPredictions,
    falseArbPredictions,
    falseArbRate: ratio(falseArbPredictions, evaluatedArbPredictions),
    micro: {
      truePositive: microTp,
      falsePositive: microFp,
      falseNegative: microFn,
      precision,
      recall,
      f1: f1(precision, recall)
    },
    byType: finalized,
    evaluatedAt: new Date().toISOString()
  };
}
