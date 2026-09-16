import { PromotionGateService } from "../service/promotion-gate.js";
import { QualityRepository } from "../service/quality-repository.js";

function positiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function probability(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function nonNegative(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positive(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const model = process.env.PRED_MATCHER_PROMOTED_MODEL?.trim();
const promptVersion = process.env.PRED_MATCHER_PROMOTED_PROMPT_VERSION?.trim();
if (!model || !promptVersion) {
  console.error("PRED_MATCHER_PROMOTED_MODEL and PRED_MATCHER_PROMOTED_PROMPT_VERSION are required");
  process.exitCode = 2;
} else {
  const path = process.env.PRED_MATCHER_QUALITY_DB_PATH?.trim() || "./data/pred-matcher-quality.sqlite";
  const repository = new QualityRepository(path);
  try {
    const gate = new PromotionGateService(repository, {
      model,
      promptVersion,
      minimumLabeledPairs: positiveInt("PRED_MATCHER_PROMOTION_MIN_LABELED_PAIRS", 100),
      minimumRetainedArbPredictions: positiveInt("PRED_MATCHER_PROMOTION_MIN_ARB_PREDICTIONS", 75),
      maximumFalseArbRateUpperBound: probability("PRED_MATCHER_PROMOTION_MAX_FALSE_ARB_UCB", 0.05),
      minimumArbPrecisionGain: nonNegative("PRED_MATCHER_PROMOTION_MIN_ARB_PRECISION_GAIN", 0.001),
      minimumMicroPrecisionDelta: nonNegative("PRED_MATCHER_PROMOTION_MIN_MICRO_PRECISION_DELTA", 0),
      minimumRecallDelta: nonNegative("PRED_MATCHER_PROMOTION_MIN_RECALL_DELTA", 0),
      minimumSemanticConfidence: probability("PRED_MATCHER_PROMOTION_MIN_SEMANTIC_CONFIDENCE", 0.8),
      confidenceZ: positive("PRED_MATCHER_PROMOTION_CONFIDENCE_Z", 1.96)
    });
    const report = gate.evaluate();
    console.log(JSON.stringify(report, null, 2));
    if (!report.eligible) process.exitCode = 1;
  } finally {
    repository.close();
  }
}
