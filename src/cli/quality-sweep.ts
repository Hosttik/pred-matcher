import { calibrateMatcher } from "../core/calibration.js";
import { DatasetRepository } from "../service/dataset-repository.js";
import { QualityRepository } from "../service/quality-repository.js";

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function probability(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function csvProbabilities(name: string): number[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  return values.length > 0 ? values : undefined;
}

const datasetPath = process.env.PRED_MATCHER_DATASET_DB_PATH?.trim() || "./data/pred-matcher-dataset.sqlite";
const qualityPath = process.env.PRED_MATCHER_QUALITY_DB_PATH?.trim() || "./data/pred-matcher-quality.sqlite";
const dataset = new DatasetRepository(datasetPath);
const quality = new QualityRepository(qualityPath);

try {
  const frameLimit = positiveInt("PRED_MATCHER_CALIBRATION_FRAMES", 500);
  const frames = dataset.loadFrames({ limit: frameLimit });
  const includePseudo = process.env.PRED_MATCHER_CALIBRATION_INCLUDE_PSEUDO === "true";
  const labels = quality.listLabels().filter((label) => includePseudo || label.source !== "PSEUDO");

  if (frames.length === 0) throw new Error("calibration_dataset_empty");
  if (labels.length === 0) throw new Error("calibration_labels_empty");

  const candidateScores = csvProbabilities("PRED_MATCHER_CALIBRATION_CANDIDATE_SCORES");
  const arbConfidenceThresholds = csvProbabilities("PRED_MATCHER_CALIBRATION_ARB_CONFIDENCES");
  const report = calibrateMatcher(frames, labels, {
    ...(candidateScores ? { candidateScores } : {}),
    ...(arbConfidenceThresholds ? { arbConfidenceThresholds } : {}),
    policy: {
      maxFalseArbRate: probability("PRED_MATCHER_CALIBRATION_MAX_FALSE_ARB_RATE", 0),
      minimumMicroRecall: probability("PRED_MATCHER_CALIBRATION_MIN_RECALL", 0),
      minimumArbPredictions: positiveInt("PRED_MATCHER_CALIBRATION_MIN_ARB_PREDICTIONS", 1),
      minimumLabeledPairs: positiveInt("PRED_MATCHER_CALIBRATION_MIN_LABELED_PAIRS", 1)
    }
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  dataset.close();
  quality.close();
}
