import { readFile } from "node:fs/promises";
import { compareQualityRegression, evaluateMatcherOnFrames, type MatcherCalibrationConfig, type RegressionPolicy } from "../core/calibration.js";
import { evaluateMatcherQuality, type RelationLabel } from "../core/quality.js";
import type { HistoricalDatasetFrame } from "../core/dataset.js";
import type { MarketRelation } from "../core/types.js";

interface RegressionFixture {
  frames: HistoricalDatasetFrame[];
  labels: RelationLabel[];
  baselinePredictions: MarketRelation[];
  candidateConfig?: MatcherCalibrationConfig;
  policy?: RegressionPolicy;
}

function isFixture(value: unknown): value is RegressionFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.frames) && Array.isArray(record.labels) && Array.isArray(record.baselinePredictions);
}

const fixturePath = process.env.PRED_MATCHER_QUALITY_GATE_FIXTURE?.trim() || "./config/quality-regression-fixture.json";
const raw = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
if (!isFixture(raw)) throw new Error("invalid_quality_regression_fixture");

const baseline = evaluateMatcherQuality(raw.baselinePredictions, raw.labels);
const evaluated = evaluateMatcherOnFrames(
  raw.frames,
  raw.labels,
  raw.candidateConfig ?? { minimumCandidateScore: 0.2, minimumArbConfidence: 0 }
);
const result = compareQualityRegression(baseline, evaluated.report, raw.policy ?? {
  maxFalseArbRate: 0,
  maxFalseArbRateIncrease: 0,
  maxMicroPrecisionDrop: 0,
  maxMicroRecallDrop: 0,
  minimumLabeledPairs: raw.labels.length,
  minimumArbPredictions: 1
});

process.stdout.write(`${JSON.stringify({
  fixture: fixturePath,
  candidatePairs: evaluated.candidatePairs,
  predictedRelations: evaluated.predictions.length,
  ...result
}, null, 2)}\n`);

if (!result.pass) process.exitCode = 1;
