import { OpenAISemanticVerifier } from "../adapters/openai-semantic-verifier.js";
import { DEFAULT_TYPESAFE_MODEL, TypeSafeSemanticVerifier } from "../adapters/typesafe-semantic-verifier.js";
import type { SemanticVerifier } from "../core/semantic-verifier.js";
import { DatasetRepository } from "../service/dataset-repository.js";
import { QualityRepository } from "../service/quality-repository.js";
import { ShadowExperimentRunner } from "../service/shadow-experiment.js";

type Provider = "openai" | "typesafe";
interface ModelSpec { provider: Provider; model: string; }

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

function defaultProvider(): Provider {
  const raw = process.env.PRED_MATCHER_SHADOW_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "openai") return "openai";
  if (raw === "typesafe") return "typesafe";
  throw new Error("unsupported_shadow_provider:" + raw);
}

function modelSpecs(): ModelSpec[] {
  const provider = defaultProvider();
  const fallbackModel = provider === "typesafe" ? DEFAULT_TYPESAFE_MODEL : "gpt-5.6-luna";
  const raw = process.env.PRED_MATCHER_SHADOW_MODELS?.trim() ||
    process.env.PRED_MATCHER_SHADOW_MODEL?.trim() ||
    fallbackModel;
  const specs = raw.split(",").map((value) => value.trim()).filter(Boolean).map((entry): ModelSpec => {
    const separator = entry.indexOf(":");
    if (separator > 0) {
      const prefix = entry.slice(0, separator).trim().toLowerCase();
      const model = entry.slice(separator + 1).trim();
      if (!model) throw new Error("shadow_model_required:" + entry);
      if (prefix === "openai" || prefix === "typesafe") return { provider: prefix, model };
      throw new Error("unsupported_shadow_provider:" + prefix);
    }
    return { provider, model: entry };
  });
  const unique = new Map(specs.map((spec) => [spec.provider + ":" + spec.model, spec]));
  return [...unique.values()];
}

function buildVerifier(spec: ModelSpec): SemanticVerifier {
  const timeoutMs = positiveInt("PRED_MATCHER_SHADOW_TIMEOUT_MS", 45_000, 300_000);
  if (spec.provider === "typesafe") {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for TypeSafe shadow backfill");
    return new TypeSafeSemanticVerifier({
      apiKey,
      model: spec.model,
      baseUrl: "https://api.typesafe.ai/v1",
      timeoutMs
    });
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI shadow backfill");
  return new OpenAISemanticVerifier({
    apiKey,
    model: spec.model,
    baseUrl: "https://api.openai.com/v1",
    timeoutMs
  });
}

const datasetPath = process.env.PRED_MATCHER_DATASET_DB_PATH?.trim() || "./data/pred-matcher-dataset.sqlite";
const qualityPath = process.env.PRED_MATCHER_QUALITY_DB_PATH?.trim() || "./data/pred-matcher-quality.sqlite";
const dataset = new DatasetRepository(datasetPath, positiveInt("PRED_MATCHER_DATASET_MAX_SNAPSHOTS", 576, 100_000));
const quality = new QualityRepository(qualityPath);
const verifiers = modelSpecs().map(buildVerifier);

try {
  const runner = new ShadowExperimentRunner(dataset, quality, verifiers);
  const experiment = await runner.runHistorical({
    snapshotLimit: positiveInt("PRED_MATCHER_SHADOW_BACKFILL_FRAMES", 50, 5_000),
    maxPairs: positiveInt("PRED_MATCHER_SHADOW_BACKFILL_MAX_PAIRS", 200, 5_000),
    batchSize: positiveInt("PRED_MATCHER_SHADOW_BATCH_SIZE", 10, 50),
    minimumCandidateScore: probability("PRED_MATCHER_SHADOW_MIN_CANDIDATE_SCORE", 0.2)
  });
  process.stdout.write(JSON.stringify(experiment, null, 2) + "\n");
} finally {
  dataset.close();
  quality.close();
}
