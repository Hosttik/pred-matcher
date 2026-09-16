import { OpenAISemanticVerifier } from "../adapters/openai-semantic-verifier.js";
import { DatasetRepository } from "../service/dataset-repository.js";
import { QualityRepository } from "../service/quality-repository.js";
import { ShadowExperimentRunner } from "../service/shadow-experiment.js";

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function probability(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function models(): string[] {
  const raw = process.env.PRED_MATCHER_SHADOW_MODELS?.trim() || process.env.PRED_MATCHER_SHADOW_MODEL?.trim() || "gpt-5.6-luna";
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("OPENAI_API_KEY is required for shadow backfill");

const datasetPath = process.env.PRED_MATCHER_DATASET_DB_PATH?.trim() || "./data/pred-matcher-dataset.sqlite";
const qualityPath = process.env.PRED_MATCHER_QUALITY_DB_PATH?.trim() || "./data/pred-matcher-quality.sqlite";
const dataset = new DatasetRepository(datasetPath, positiveInt("PRED_MATCHER_DATASET_MAX_SNAPSHOTS", 576, 100_000));
const quality = new QualityRepository(qualityPath);
const verifiers = models().map((model) => new OpenAISemanticVerifier({
  apiKey,
  model,
  baseUrl: "https://api.openai.com/v1",
  timeoutMs: positiveInt("PRED_MATCHER_SHADOW_TIMEOUT_MS", 45_000, 300_000)
}));

try {
  const runner = new ShadowExperimentRunner(dataset, quality, verifiers);
  const experiment = await runner.runHistorical({
    snapshotLimit: positiveInt("PRED_MATCHER_SHADOW_BACKFILL_FRAMES", 50, 5_000),
    maxPairs: positiveInt("PRED_MATCHER_SHADOW_BACKFILL_MAX_PAIRS", 200, 5_000),
    batchSize: positiveInt("PRED_MATCHER_SHADOW_BATCH_SIZE", 10, 50),
    minimumCandidateScore: probability("PRED_MATCHER_SHADOW_MIN_CANDIDATE_SCORE", 0.2)
  });
  process.stdout.write(`${JSON.stringify(experiment, null, 2)}\n`);
} finally {
  dataset.close();
  quality.close();
}
