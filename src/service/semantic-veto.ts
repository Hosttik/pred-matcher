import { relationPairKey } from "../core/quality.js";
import {
  emptySemanticVerifierUsage,
  heuristicSignature,
  mergeSemanticVerifierUsage,
  semanticDecisionSignature,
  semanticPair,
  verifySemanticBatch,
  type SemanticVerifier,
  type SemanticVerifierUsage
} from "../core/semantic-verifier.js";
import type { MarketRelation, NormalizedMarket, RelationType } from "../core/types.js";
import type { PromotionGateProvider } from "./promotion-gate.js";

const ARB_ELIGIBLE = new Set<RelationType>([
  "EQUIVALENT",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);

export type SemanticProductionMode = "OFF" | "VETO_ONLY";

export interface SemanticVetoOptions {
  mode: SemanticProductionMode;
  batchSize: number;
  maximumRelations: number;
  minimumSemanticConfidence: number;
}

export interface SemanticVetoStatus {
  mode: SemanticProductionMode;
  configured: boolean;
  model?: string;
  promptVersion?: string;
  promotionEligible: boolean;
  promotionReasons: string[];
  minimumSemanticConfidence: number;
  maximumRelations: number;
}

export interface SemanticVetoResult {
  relations: MarketRelation[];
  checkedRelations: number;
  vetoedRelations: number;
  confirmedRelations: number;
  usage: SemanticVerifierUsage;
  model: string;
  promptVersion: string;
}

export class SemanticVetoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function positiveInt(value: number, fallback: number, max: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function probability(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

export class SemanticVetoService {
  private readonly options: SemanticVetoOptions;

  constructor(
    private readonly verifier: SemanticVerifier | undefined,
    private readonly promotionGate: PromotionGateProvider,
    options: SemanticVetoOptions
  ) {
    this.options = {
      mode: options.mode,
      batchSize: positiveInt(options.batchSize, 10, 50),
      maximumRelations: positiveInt(options.maximumRelations, 500, 5000),
      minimumSemanticConfidence: probability(options.minimumSemanticConfidence, 0.8)
    };
  }

  get mode(): SemanticProductionMode {
    return this.options.mode;
  }

  getStatus(): SemanticVetoStatus {
    const promotion = this.promotionGate.evaluate();
    const pinned = Boolean(
      this.verifier &&
      this.verifier.model === promotion.model &&
      this.verifier.promptVersion === promotion.promptVersion
    );
    return {
      mode: this.options.mode,
      configured: pinned,
      ...(this.verifier ? { model: this.verifier.model } : {}),
      ...(this.verifier?.promptVersion ? { promptVersion: this.verifier.promptVersion } : {}),
      promotionEligible: pinned && promotion.eligible,
      promotionReasons: pinned
        ? promotion.reasons
        : [...promotion.reasons, "runtime_model_or_prompt_not_pinned"],
      minimumSemanticConfidence: this.options.minimumSemanticConfidence,
      maximumRelations: this.options.maximumRelations
    };
  }

  async apply(
    markets: readonly NormalizedMarket[],
    relations: readonly MarketRelation[]
  ): Promise<SemanticVetoResult | undefined> {
    if (this.options.mode === "OFF") return undefined;
    if (!this.verifier) throw new SemanticVetoError("semantic_veto_not_configured");

    const promotion = this.promotionGate.evaluate();
    if (this.verifier.model !== promotion.model || this.verifier.promptVersion !== promotion.promptVersion) {
      throw new SemanticVetoError("semantic_veto_runtime_pin_mismatch");
    }
    if (!promotion.eligible) throw new SemanticVetoError("semantic_promotion_gate_not_passed");

    const arbRelations = relations.filter((relation) => ARB_ELIGIBLE.has(relation.type));
    if (arbRelations.length > this.options.maximumRelations) {
      throw new SemanticVetoError("semantic_veto_relation_limit_exceeded");
    }

    const marketById = new Map(markets.map((market) => [market.id, market]));
    const relationByPair = new Map<string, MarketRelation>();
    const pairs = arbRelations.map((relation) => {
      const left = marketById.get(relation.leftId);
      const right = marketById.get(relation.rightId);
      if (!left || !right) throw new SemanticVetoError("semantic_veto_market_missing");
      const pair = semanticPair(left, right);
      relationByPair.set(pair.pairKey, relation);
      return pair;
    });

    let usage = emptySemanticVerifierUsage();
    const confirmed = new Map<string, MarketRelation>();
    for (let offset = 0; offset < pairs.length; offset += this.options.batchSize) {
      const batch = pairs.slice(offset, offset + this.options.batchSize);
      const result = await verifySemanticBatch(this.verifier, batch);
      usage = mergeSemanticVerifierUsage(usage, result.usage);
      for (const decision of result.decisions) {
        const relation = relationByPair.get(decision.pairKey);
        if (!relation) throw new SemanticVetoError("semantic_veto_unknown_pair");
        if (
          decision.confidence >= this.options.minimumSemanticConfidence &&
          semanticDecisionSignature(decision) === heuristicSignature(relation)
        ) {
          confirmed.set(decision.pairKey, {
            ...relation,
            evidence: [
              ...relation.evidence,
              `semantic_veto_confirmed=${this.verifier.model}@${this.verifier.promptVersion ?? "unversioned"}:${decision.confidence}`
            ]
          });
        }
      }
    }

    const filtered = relations.filter((relation) => {
      if (!ARB_ELIGIBLE.has(relation.type)) return true;
      return confirmed.has(relationPairKey(relation.leftId, relation.rightId));
    });

    return {
      relations: filtered,
      checkedRelations: arbRelations.length,
      vetoedRelations: arbRelations.length - confirmed.size,
      confirmedRelations: confirmed.size,
      usage,
      model: this.verifier.model,
      promptVersion: this.verifier.promptVersion ?? "unversioned"
    };
  }
}
