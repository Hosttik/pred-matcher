import { estimateTypeSafeCostUsd, TYPESAFE_PRICING_SNAPSHOT } from "../core/typesafe-pricing.js";
import {
  emptySemanticVerifierUsage,
  mergeSemanticVerifierUsage,
  type SemanticVerifier,
  type SemanticVerifierBatchResult,
  type SemanticVerifierDecision,
  type SemanticVerifierPair,
  type SemanticVerifierUsage
} from "../core/semantic-verifier.js";
import type { NormalizedMarket } from "../core/types.js";

export const TYPESAFE_SEMANTIC_PROMPT_VERSION = "typesafe-semantic-contract-v1";
export const DEFAULT_TYPESAFE_MODEL = "jev-1.13.0";

const RELATION_THRESHOLD = 0.85;
const SIMILAR_THRESHOLD = 0.6;
const NESTED_THRESHOLD = 0.75;
const MATERIAL_DIFFERENCE_MAX = 0.25;
const DIRECTION_MARGIN = 0.2;
const NESTED_MARGIN = 0.1;

type AtomicQuestion =
  | "same_event"
  | "equivalent"
  | "left_implies_right"
  | "right_implies_left"
  | "threshold_nested"
  | "time_nested"
  | "material_difference";

interface AtomicScores {
  sameEvent: number;
  equivalent: number;
  leftImpliesRight: number;
  rightImpliesLeft: number;
  thresholdNested: number;
  timeNested: number;
  materialDifference: number;
}

interface TypeSafeResponseBody {
  model?: unknown;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  error?: unknown;
  detail?: unknown;
}

interface TypeSafeNoulAnswer {
  type?: unknown;
  noul?: unknown;
}

export interface TypeSafeSemanticVerifierOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  maxPairsPerRequest?: number;
  fetchImpl?: typeof fetch;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : value.slice(0, max) + "…";
}

function marketDocument(market: NormalizedMarket): Record<string, unknown> {
  return {
    id: market.id,
    venue: market.venue,
    title: market.title,
    subtitle: truncate(market.subtitle, 1_000) ?? null,
    rules: truncate(market.rules, 3_000) ?? null,
    resolutionSource: truncate(market.resolutionSource, 1_000) ?? null,
    closeTime: market.closeTime ?? null,
    structure: market.structure ?? null
  };
}

function probability(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(6));
}

function minimum(...values: number[]): number {
  return probability(Math.min(...values));
}

function scoreText(value: number): string {
  return probability(value).toFixed(6);
}

function questionId(index: number, name: AtomicQuestion): string {
  return "p" + index + "_" + name;
}

function statePath(index: number): string {
  const tick = String.fromCharCode(96);
  return tick + "pairs[" + index + "]" + tick;
}

function buildQuestions(pairs: readonly SemanticVerifierPair[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  pairs.forEach((_pair, index) => {
    const path = statePath(index);
    questions[questionId(index, "same_event")] = {
      type: "noul",
      instructions: "Considering only " + path + ", do left and right concern the same underlying real-world subject/event and outcome concept, rather than merely related topics?"
    };
    questions[questionId(index, "equivalent")] = {
      type: "noul",
      instructions: "Considering only " + path + ", are the contractual YES conditions logically equivalent, so they have the same truth value in every possible state under materially compatible settlement rules?"
    };
    questions[questionId(index, "left_implies_right")] = {
      type: "noul",
      instructions: "Considering only " + path + ", is it logically guaranteed that whenever left resolves YES, right must also resolve YES under the stated settlement rules?"
    };
    questions[questionId(index, "right_implies_left")] = {
      type: "noul",
      instructions: "Considering only " + path + ", is it logically guaranteed that whenever right resolves YES, left must also resolve YES under the stated settlement rules?"
    };
    questions[questionId(index, "threshold_nested")] = {
      type: "noul",
      instructions: "Considering only " + path + ", is any safe one-way implication primarily caused by a numeric threshold/comparator nesting on the same measured quantity and time window?"
    };
    questions[questionId(index, "time_nested")] = {
      type: "noul",
      instructions: "Considering only " + path + ", is any safe one-way implication primarily caused by a deadline or time-window nesting for the same event condition?"
    };
    questions[questionId(index, "material_difference")] = {
      type: "noul",
      instructions: "Considering only " + path + ", is there a material difference in resolution source, cutoff/timezone, settlement mechanism, cancellation/invalid rules, exceptions, early close, comparator, or other contract semantics that makes equivalence or implication unsafe for arbitrage?"
    };
  });
  return questions;
}

function noulAnswer(body: TypeSafeResponseBody, id: string): number {
  const raw = body.answers?.[id];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("typesafe_semantic_verifier_missing_answer:" + id);
  }
  const answer = raw as TypeSafeNoulAnswer;
  if (answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error("typesafe_semantic_verifier_invalid_answer:" + id);
  }
  return probability(answer.noul);
}

function scoresFor(body: TypeSafeResponseBody, index: number): AtomicScores {
  return {
    sameEvent: noulAnswer(body, questionId(index, "same_event")),
    equivalent: noulAnswer(body, questionId(index, "equivalent")),
    leftImpliesRight: noulAnswer(body, questionId(index, "left_implies_right")),
    rightImpliesLeft: noulAnswer(body, questionId(index, "right_implies_left")),
    thresholdNested: noulAnswer(body, questionId(index, "threshold_nested")),
    timeNested: noulAnswer(body, questionId(index, "time_nested")),
    materialDifference: noulAnswer(body, questionId(index, "material_difference"))
  };
}

function evidence(scores: AtomicScores, resolvedModel: string): string[] {
  return [
    "jev_model=" + resolvedModel,
    "jev_same_event=" + scoreText(scores.sameEvent),
    "jev_equivalent=" + scoreText(scores.equivalent),
    "jev_left_implies_right=" + scoreText(scores.leftImpliesRight),
    "jev_right_implies_left=" + scoreText(scores.rightImpliesLeft),
    "jev_threshold_nested=" + scoreText(scores.thresholdNested),
    "jev_time_nested=" + scoreText(scores.timeNested),
    "jev_material_difference=" + scoreText(scores.materialDifference)
  ];
}

function classify(
  pair: SemanticVerifierPair,
  scores: AtomicScores,
  resolvedModel: string
): SemanticVerifierDecision {
  const safeFactor = 1 - scores.materialDifference;
  const arbCompatible = scores.sameEvent >= RELATION_THRESHOLD && scores.materialDifference <= MATERIAL_DIFFERENCE_MAX;
  const materialDifferences: string[] = [];
  if (scores.materialDifference > MATERIAL_DIFFERENCE_MAX) {
    materialDifferences.push("jev_material_contract_difference_probability=" + scoreText(scores.materialDifference));
  }

  if (arbCompatible && scores.equivalent >= RELATION_THRESHOLD) {
    return {
      pairKey: pair.pairKey,
      leftId: pair.left.id,
      rightId: pair.right.id,
      type: "EQUIVALENT",
      confidence: minimum(scores.sameEvent, scores.equivalent, safeFactor),
      evidence: evidence(scores, resolvedModel),
      materialDifferences
    };
  }

  const leftDirection = scores.leftImpliesRight >= RELATION_THRESHOLD &&
    scores.leftImpliesRight - scores.rightImpliesLeft >= DIRECTION_MARGIN;
  const rightDirection = scores.rightImpliesLeft >= RELATION_THRESHOLD &&
    scores.rightImpliesLeft - scores.leftImpliesRight >= DIRECTION_MARGIN;

  if (arbCompatible && (leftDirection || rightDirection)) {
    const direction = leftDirection ? "LEFT_IMPLIES_RIGHT" as const : "RIGHT_IMPLIES_LEFT" as const;
    const implication = leftDirection ? scores.leftImpliesRight : scores.rightImpliesLeft;
    const thresholdClear = scores.thresholdNested >= NESTED_THRESHOLD &&
      scores.thresholdNested - scores.timeNested >= NESTED_MARGIN;
    const timeClear = scores.timeNested >= NESTED_THRESHOLD &&
      scores.timeNested - scores.thresholdNested >= NESTED_MARGIN;

    if (thresholdClear) {
      return {
        pairKey: pair.pairKey,
        leftId: pair.left.id,
        rightId: pair.right.id,
        type: "THRESHOLD_NESTED",
        direction,
        confidence: minimum(scores.sameEvent, implication, safeFactor, scores.thresholdNested),
        evidence: evidence(scores, resolvedModel),
        materialDifferences
      };
    }
    if (timeClear) {
      return {
        pairKey: pair.pairKey,
        leftId: pair.left.id,
        rightId: pair.right.id,
        type: "TIME_NESTED",
        direction,
        confidence: minimum(scores.sameEvent, implication, safeFactor, scores.timeNested),
        evidence: evidence(scores, resolvedModel),
        materialDifferences
      };
    }
    return {
      pairKey: pair.pairKey,
      leftId: pair.left.id,
      rightId: pair.right.id,
      type: "IMPLIES",
      direction,
      confidence: minimum(scores.sameEvent, implication, safeFactor),
      evidence: evidence(scores, resolvedModel),
      materialDifferences
    };
  }

  if (
    scores.leftImpliesRight >= RELATION_THRESHOLD &&
    scores.rightImpliesLeft >= RELATION_THRESHOLD &&
    scores.equivalent < RELATION_THRESHOLD
  ) {
    materialDifferences.push("jev_mutual_implication_without_equivalence");
  }

  if (scores.sameEvent >= SIMILAR_THRESHOLD) {
    return {
      pairKey: pair.pairKey,
      leftId: pair.left.id,
      rightId: pair.right.id,
      type: "SIMILAR",
      confidence: probability(scores.sameEvent),
      evidence: evidence(scores, resolvedModel),
      materialDifferences
    };
  }

  return {
    pairKey: pair.pairKey,
    leftId: pair.left.id,
    rightId: pair.right.id,
    type: "NONE",
    confidence: probability(1 - scores.sameEvent),
    evidence: evidence(scores, resolvedModel),
    materialDifferences
  };
}

function responseError(body: TypeSafeResponseBody): string {
  if (typeof body.error === "string") return body.error;
  if (typeof body.error === "object" && body.error !== null && !Array.isArray(body.error)) {
    const message = (body.error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (typeof body.detail === "string") return body.detail;
  return "unknown_error";
}

function parseBody(raw: string): TypeSafeResponseBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as TypeSafeResponseBody
      : {};
  } catch {
    return {};
  }
}

function retryDelayMs(response: Response, attempt: number, baseMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
  }
  return Math.min(5_000, baseMs * 2 ** attempt);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}

export class TypeSafeSemanticVerifier implements SemanticVerifier {
  readonly provider = "typesafe";
  readonly model: string;
  readonly promptVersion = TYPESAFE_SEMANTIC_PROMPT_VERSION;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxPairsPerRequest: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TypeSafeSemanticVerifierOptions) {
    if (!options.apiKey.trim()) throw new Error("typesafe_api_key_required");
    this.model = options.model?.trim() || DEFAULT_TYPESAFE_MODEL;
    this.baseUrl = (options.baseUrl?.trim() || "https://api.typesafe.ai/v1").replace(/\/+$/, "");
    this.timeoutMs = positiveInt(options.timeoutMs, 45_000, 300_000);
    this.maxRetries = nonNegativeInt(options.maxRetries, 3, 10);
    this.retryBaseMs = nonNegativeInt(options.retryBaseMs, 250, 5_000);
    this.maxPairsPerRequest = positiveInt(options.maxPairsPerRequest, 10, 20);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verify(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierDecision[]> {
    return (await this.verifyDetailed(pairs)).decisions;
  }

  async verifyDetailed(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierBatchResult> {
    if (pairs.length === 0) {
      return {
        decisions: [],
        usage: {
          ...emptySemanticVerifierUsage(),
          pricingSnapshot: TYPESAFE_PRICING_SNAPSHOT
        }
      };
    }

    const decisions: SemanticVerifierDecision[] = [];
    let usage = emptySemanticVerifierUsage();
    for (let offset = 0; offset < pairs.length; offset += this.maxPairsPerRequest) {
      const chunk = pairs.slice(offset, offset + this.maxPairsPerRequest);
      const result = await this.verifyChunk(chunk);
      decisions.push(...result.decisions);
      usage = mergeSemanticVerifierUsage(usage, result.usage);
    }
    return { decisions, usage };
  }

  private async verifyChunk(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierBatchResult> {
    const state = {
      pairs: pairs.map((pair) => ({
        pairKey: pair.pairKey,
        left: marketDocument(pair.left),
        right: marketDocument(pair.right)
      }))
    };
    const questions = buildQuestions(pairs);
    const started = Date.now();

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.baseUrl + "/systemone", {
          method: "POST",
          headers: {
            authorization: "Bearer " + this.options.apiKey,
            "content-type": "application/json"
          },
          body: JSON.stringify({ state, model: this.model, questions }),
          signal: controller.signal
        });
        const raw = await response.text();
        const body = parseBody(raw);

        if ((response.status === 429 || response.status === 529) && attempt < this.maxRetries) {
          await delay(retryDelayMs(response, attempt, this.retryBaseMs));
          continue;
        }
        if (!response.ok) {
          throw new Error(
            "typesafe_semantic_verifier_http_" + response.status + ":" + responseError(body)
          );
        }
        if (typeof body.model !== "string" || !body.model.trim()) {
          throw new Error("typesafe_semantic_verifier_missing_model");
        }
        if (/^jev-\d/.test(this.model) && body.model !== this.model) {
          throw new Error("typesafe_semantic_verifier_model_mismatch:" + body.model);
        }
        if (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) {
          throw new Error("typesafe_semantic_verifier_missing_answers");
        }

        const resolvedModel = body.model;
        const chunkDecisions = pairs.map((pair, index) => classify(pair, scoresFor(body, index), resolvedModel));
        const inputTokens = typeof body.usage?.input_tokens === "number" && Number.isFinite(body.usage.input_tokens)
          ? Math.max(0, Math.floor(body.usage.input_tokens))
          : 0;
        const outputTokens = typeof body.usage?.output_tokens === "number" && Number.isFinite(body.usage.output_tokens)
          ? Math.max(0, Math.floor(body.usage.output_tokens))
          : 0;
        const chunkUsage: SemanticVerifierUsage = {
          requests: 1,
          inputTokens,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          latencyMs: Date.now() - started,
          estimatedCostUsd: estimateTypeSafeCostUsd(this.model, inputTokens),
          pricingSnapshot: TYPESAFE_PRICING_SNAPSHOT
        };
        return { decisions: chunkDecisions, usage: chunkUsage };
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("typesafe_semantic_verifier_retry_exhausted");
  }
}
