import type {
  SemanticRelationType,
  SemanticVerifier,
  SemanticVerifierDecision,
  SemanticVerifierPair
} from "../core/semantic-verifier.js";
import type { NormalizedMarket } from "../core/types.js";

const RELATION_TYPES: SemanticRelationType[] = [
  "NONE",
  "EQUIVALENT",
  "SIMILAR",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
];
const DIRECTIONS = ["NONE", "LEFT_IMPLIES_RIGHT", "RIGHT_IMPLIES_LEFT"] as const;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "pairKey",
          "leftId",
          "rightId",
          "type",
          "direction",
          "confidence",
          "evidence",
          "materialDifferences"
        ],
        properties: {
          pairKey: { type: "string" },
          leftId: { type: "string" },
          rightId: { type: "string" },
          type: { type: "string", enum: RELATION_TYPES },
          direction: { type: "string", enum: DIRECTIONS },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" } },
          materialDifferences: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
} as const;

const SYSTEM_PROMPT = `You verify semantic relations between binary prediction-market contracts.
Classify ONLY the contractual YES conditions and settlement semantics. Ignore market prices and trading signals.

Relation definitions:
- EQUIVALENT: both YES outcomes are true and false in exactly the same states under materially identical resolution rules.
- THRESHOLD_NESTED: same underlying event/window/source, but one numeric threshold logically implies the other.
- TIME_NESTED: same event condition/source, but one deadline/window logically implies the other.
- IMPLIES: one contract's YES condition logically implies the other due to multiple or non-threshold constraints.
- SIMILAR: topically related, but no safe logical equivalence/implication can be guaranteed.
- NONE: not meaningfully the same proposition.

For directed relations, LEFT_IMPLIES_RIGHT means left YES => right YES; RIGHT_IMPLIES_LEFT means the reverse.
Use direction NONE for EQUIVALENT, SIMILAR, and NONE.
Treat differences in cutoff time/timezone, resolution source, settlement mechanism, cancellation/invalid rules, official announcement vs actual action, exceptions, early close, rounding, and numeric comparator as potentially material.
If material information is missing, prefer SIMILAR or NONE over an arb-eligible relation.
Return concise factual evidence only; do not provide hidden reasoning or chain-of-thought.`;

interface OpenAIResponseBody {
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { message?: string };
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
}

interface ParsedDecision {
  pairKey: unknown;
  leftId: unknown;
  rightId: unknown;
  type: unknown;
  direction: unknown;
  confidence: unknown;
  evidence: unknown;
  materialDifferences: unknown;
}

interface ParsedOutput {
  decisions?: unknown;
}

export interface OpenAISemanticVerifierOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function marketDocument(market: NormalizedMarket): Record<string, unknown> {
  return {
    id: market.id,
    venue: market.venue,
    title: market.title,
    subtitle: truncate(market.subtitle, 2_000) ?? null,
    rules: truncate(market.rules, 8_000) ?? null,
    resolutionSource: market.resolutionSource ?? null,
    closeTime: market.closeTime ?? null,
    structure: market.structure ?? null
  };
}

function outputText(body: OpenAIResponseBody): string {
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "refusal") throw new Error(`semantic_verifier_refusal:${content.refusal ?? "refused"}`);
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("semantic_verifier_missing_output_text");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateDecision(value: unknown, expected: SemanticVerifierPair): SemanticVerifierDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("semantic_verifier_invalid_decision");
  }
  const decision = value as ParsedDecision;
  if (decision.pairKey !== expected.pairKey || decision.leftId !== expected.left.id || decision.rightId !== expected.right.id) {
    throw new Error("semantic_verifier_pair_mismatch");
  }
  if (typeof decision.type !== "string" || !RELATION_TYPES.includes(decision.type as SemanticRelationType)) {
    throw new Error("semantic_verifier_invalid_relation_type");
  }
  const type = decision.type as SemanticRelationType;
  if (typeof decision.direction !== "string" || !DIRECTIONS.includes(decision.direction as typeof DIRECTIONS[number])) {
    throw new Error("semantic_verifier_invalid_direction");
  }
  const directed = type === "THRESHOLD_NESTED" || type === "TIME_NESTED" || type === "IMPLIES";
  if (directed && decision.direction === "NONE") throw new Error("semantic_verifier_missing_direction");
  if (!directed && decision.direction !== "NONE") throw new Error("semantic_verifier_unexpected_direction");
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    throw new Error("semantic_verifier_invalid_confidence");
  }
  if (!isStringArray(decision.evidence) || !isStringArray(decision.materialDifferences)) {
    throw new Error("semantic_verifier_invalid_evidence");
  }
  const direction = decision.direction === "NONE"
    ? undefined
    : decision.direction as "LEFT_IMPLIES_RIGHT" | "RIGHT_IMPLIES_LEFT";
  return {
    pairKey: expected.pairKey,
    leftId: expected.left.id,
    rightId: expected.right.id,
    type,
    confidence: Number(decision.confidence.toFixed(6)),
    evidence: decision.evidence.slice(0, 12).map((item) => item.slice(0, 500)),
    materialDifferences: decision.materialDifferences.slice(0, 12).map((item) => item.slice(0, 500)),
    ...(direction ? { direction } : {})
  };
}

export class OpenAISemanticVerifier implements SemanticVerifier {
  readonly provider = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAISemanticVerifierOptions) {
    if (!options.apiKey.trim()) throw new Error("openai_api_key_required");
    this.model = options.model?.trim() || "gpt-5.6-luna";
    this.baseUrl = (options.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verify(pairs: readonly SemanticVerifierPair[]): Promise<SemanticVerifierDecision[]> {
    if (pairs.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          store: false,
          input: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                pairs: pairs.map((pair) => ({
                  pairKey: pair.pairKey,
                  left: marketDocument(pair.left),
                  right: marketDocument(pair.right)
                }))
              })
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "prediction_market_relation_verification",
              strict: true,
              schema: RESPONSE_SCHEMA
            }
          },
          max_output_tokens: Math.max(2_000, pairs.length * 700)
        }),
        signal: controller.signal
      });
      const body = await response.json() as OpenAIResponseBody;
      if (!response.ok) {
        throw new Error(`semantic_verifier_http_${response.status}:${body.error?.message ?? "unknown_error"}`);
      }
      if (body.status === "incomplete") {
        throw new Error(`semantic_verifier_incomplete:${body.incomplete_details?.reason ?? "unknown"}`);
      }
      const parsed = JSON.parse(outputText(body)) as ParsedOutput;
      if (!Array.isArray(parsed.decisions)) throw new Error("semantic_verifier_invalid_output");
      if (parsed.decisions.length !== pairs.length) throw new Error("semantic_verifier_incomplete_decisions");
      const expected = new Map(pairs.map((pair) => [pair.pairKey, pair]));
      const seen = new Set<string>();
      const decisions = parsed.decisions.map((value) => {
        const pairKey = typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as { pairKey?: unknown }).pairKey
          : undefined;
        if (typeof pairKey !== "string" || seen.has(pairKey)) throw new Error("semantic_verifier_duplicate_or_unknown_pair");
        const pair = expected.get(pairKey);
        if (!pair) throw new Error("semantic_verifier_duplicate_or_unknown_pair");
        seen.add(pairKey);
        return validateDecision(value, pair);
      });
      return decisions;
    } finally {
      clearTimeout(timeout);
    }
  }
}
