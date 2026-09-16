import type { SemanticPromotionReport } from "../core/promotion.js";
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
import type {
  MarketRelation,
  NormalizedMarket,
  RelationType,
  SemanticCircuitBreakerState,
  SemanticOpportunityImpact,
  SemanticRolloutMode
} from "../core/types.js";
import { MATCHER_VERSION } from "../core/version.js";
import type { PromotionGateProvider } from "./promotion-gate.js";

const ARB_ELIGIBLE = new Set<RelationType>([
  "EQUIVALENT",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);

export type SemanticProductionMode = SemanticRolloutMode;

export interface SemanticVetoOptions {
  mode: SemanticProductionMode;
  batchSize: number;
  maximumRelations: number;
  minimumSemanticConfidence: number;
  maximumVetoRate: number;
  minimumOpportunityRetentionRate: number;
  initialCircuit?: Omit<SemanticCircuitBreakerState, "trippedThisSync">;
}

export interface SemanticVetoStatus {
  requestedMode: SemanticProductionMode;
  effectiveMode: SemanticProductionMode;
  configured: boolean;
  model?: string;
  promptVersion?: string;
  matcherVersion: string;
  promotionEligible: boolean;
  promotionReasons: string[];
  promotionEvaluatedAt: string;
  promotionNewestEvidenceAt: string | null;
  minimumSemanticConfidence: number;
  maximumRelations: number;
  maximumVetoRate: number;
  minimumOpportunityRetentionRate: number;
  circuitBreaker: Omit<SemanticCircuitBreakerState, "trippedThisSync">;
}

export interface SemanticVetoEvaluation {
  proposedRelations: MarketRelation[];
  promotion: SemanticPromotionReport;
  gateEligible: boolean;
  guardReasons: string[];
  checkedRelations: number;
  vetoedRelations: number;
  confirmedRelations: number;
  vetoRate: number;
  usage: SemanticVerifierUsage;
  model?: string;
  promptVersion?: string;
  matcherVersion: string;
  providerError?: string;
}

export interface SemanticRolloutDecision {
  effectiveMode: "DRY_RUN" | "ENFORCED";
  guardReasons: string[];
  circuitBreaker: SemanticCircuitBreakerState;
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

function round(value: number): number {
  return Number(value.toFixed(6));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SemanticVetoService {
  private readonly options: SemanticVetoOptions;
  private circuitOpen = false;
  private circuitReasons: string[] = [];
  private circuitOpenedAt: string | undefined;

  constructor(
    private readonly verifier: SemanticVerifier | undefined,
    private readonly promotionGate: PromotionGateProvider,
    options: SemanticVetoOptions
  ) {
    this.options = {
      mode: options.mode,
      batchSize: positiveInt(options.batchSize, 10, 50),
      maximumRelations: positiveInt(options.maximumRelations, 500, 5000),
      minimumSemanticConfidence: probability(options.minimumSemanticConfidence, 0.8),
      maximumVetoRate: probability(options.maximumVetoRate, 0.35),
      minimumOpportunityRetentionRate: probability(options.minimumOpportunityRetentionRate, 0.5),
      ...(options.initialCircuit ? { initialCircuit: options.initialCircuit } : {})
    };
    if (options.initialCircuit?.open) {
      this.circuitOpen = true;
      this.circuitReasons = [...new Set(options.initialCircuit.reasons)];
      this.circuitOpenedAt = options.initialCircuit.openedAt;
    }
  }

  get mode(): SemanticProductionMode {
    return this.options.mode;
  }

  private pinsMatch(promotion: SemanticPromotionReport): boolean {
    return Boolean(
      this.verifier &&
      this.verifier.model === promotion.model &&
      this.verifier.promptVersion === promotion.promptVersion &&
      promotion.matcherVersion === MATCHER_VERSION
    );
  }

  private openCircuit(reasons: readonly string[]): boolean {
    if (reasons.length === 0) return false;
    const wasOpen = this.circuitOpen;
    this.circuitOpen = true;
    this.circuitReasons = [...new Set([...this.circuitReasons, ...reasons])];
    if (!this.circuitOpenedAt) this.circuitOpenedAt = new Date().toISOString();
    return !wasOpen;
  }

  private circuitSnapshot(trippedThisSync: boolean): SemanticCircuitBreakerState {
    return {
      open: this.circuitOpen,
      trippedThisSync,
      reasons: [...this.circuitReasons],
      ...(this.circuitOpenedAt ? { openedAt: this.circuitOpenedAt } : {})
    };
  }

  resetCircuit(): SemanticVetoStatus {
    this.circuitOpen = false;
    this.circuitReasons = [];
    this.circuitOpenedAt = undefined;
    return this.getStatus();
  }

  getStatus(): SemanticVetoStatus {
    const promotion = this.promotionGate.evaluate();
    const pinned = this.pinsMatch(promotion);
    const promotionEligible = pinned && promotion.eligible;
    const requestedMode = this.options.mode;
    const effectiveMode: SemanticProductionMode = requestedMode === "OFF"
      ? "OFF"
      : requestedMode === "DRY_RUN"
        ? "DRY_RUN"
        : !this.circuitOpen && promotionEligible
          ? "ENFORCED"
          : "DRY_RUN";
    return {
      requestedMode,
      effectiveMode,
      configured: this.verifier !== undefined,
      ...(this.verifier ? { model: this.verifier.model } : {}),
      ...(this.verifier?.promptVersion ? { promptVersion: this.verifier.promptVersion } : {}),
      matcherVersion: MATCHER_VERSION,
      promotionEligible,
      promotionReasons: pinned
        ? promotion.reasons
        : [...promotion.reasons, "runtime_model_prompt_or_matcher_not_pinned"],
      promotionEvaluatedAt: promotion.evaluatedAt,
      promotionNewestEvidenceAt: promotion.newestEvidenceAt,
      minimumSemanticConfidence: this.options.minimumSemanticConfidence,
      maximumRelations: this.options.maximumRelations,
      maximumVetoRate: this.options.maximumVetoRate,
      minimumOpportunityRetentionRate: this.options.minimumOpportunityRetentionRate,
      circuitBreaker: {
        open: this.circuitOpen,
        reasons: [...this.circuitReasons],
        ...(this.circuitOpenedAt ? { openedAt: this.circuitOpenedAt } : {})
      }
    };
  }

  private skippedEvaluation(
    relations: readonly MarketRelation[],
    promotion: SemanticPromotionReport,
    reasons: string[],
    providerError?: string
  ): SemanticVetoEvaluation {
    return {
      proposedRelations: [...relations],
      promotion,
      gateEligible: this.pinsMatch(promotion) && promotion.eligible,
      guardReasons: reasons,
      checkedRelations: 0,
      vetoedRelations: 0,
      confirmedRelations: 0,
      vetoRate: 0,
      usage: emptySemanticVerifierUsage(),
      ...(this.verifier ? { model: this.verifier.model } : {}),
      ...(this.verifier?.promptVersion ? { promptVersion: this.verifier.promptVersion } : {}),
      matcherVersion: MATCHER_VERSION,
      ...(providerError ? { providerError } : {})
    };
  }

  async evaluate(
    markets: readonly NormalizedMarket[],
    relations: readonly MarketRelation[]
  ): Promise<SemanticVetoEvaluation | undefined> {
    if (this.options.mode === "OFF") return undefined;

    const promotion = this.promotionGate.evaluate();
    const pinned = this.pinsMatch(promotion);
    const gateEligible = pinned && promotion.eligible;
    const promotionReasons = pinned
      ? promotion.reasons
      : [...promotion.reasons, "runtime_model_prompt_or_matcher_not_pinned"];

    if (this.options.mode === "ENFORCED" && !gateEligible) {
      const reasons = ["promotion_gate_not_eligible", ...promotionReasons];
      this.openCircuit(reasons);
      return this.skippedEvaluation(relations, promotion, reasons);
    }
    if (!this.verifier) {
      const reasons = ["semantic_provider_not_configured"];
      if (this.options.mode === "ENFORCED") this.openCircuit(reasons);
      return this.skippedEvaluation(relations, promotion, reasons, "semantic_provider_not_configured");
    }

    const arbRelations = relations.filter((relation) => ARB_ELIGIBLE.has(relation.type));
    if (arbRelations.length > this.options.maximumRelations) {
      const reason = `semantic_relation_limit_exceeded:${arbRelations.length}>${this.options.maximumRelations}`;
      if (this.options.mode === "ENFORCED") this.openCircuit([reason]);
      return this.skippedEvaluation(relations, promotion, [reason]);
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
    try {
      for (let offset = 0; offset < pairs.length; offset += this.options.batchSize) {
        const batch = pairs.slice(offset, offset + this.options.batchSize);
        const expected = new Map(batch.map((pair) => [pair.pairKey, pair]));
        const result = await verifySemanticBatch(this.verifier, batch);
        usage = mergeSemanticVerifierUsage(usage, result.usage);
        if (result.decisions.length !== batch.length) throw new SemanticVetoError("semantic_veto_incomplete_batch");
        const seen = new Set<string>();
        for (const decision of result.decisions) {
          const pair = expected.get(decision.pairKey);
          const relation = relationByPair.get(decision.pairKey);
          if (!pair || !relation || seen.has(decision.pairKey)) throw new SemanticVetoError("semantic_veto_invalid_pair_response");
          if (decision.leftId !== pair.left.id || decision.rightId !== pair.right.id) {
            throw new SemanticVetoError("semantic_veto_pair_orientation_mismatch");
          }
          seen.add(decision.pairKey);
          if (
            decision.confidence >= this.options.minimumSemanticConfidence &&
            semanticDecisionSignature(decision) === heuristicSignature(relation)
          ) {
            confirmed.set(decision.pairKey, {
              ...relation,
              evidence: [
                ...relation.evidence,
                `semantic_veto_confirmed=${this.verifier.model}@${this.verifier.promptVersion ?? "unversioned"}:${decision.confidence}`,
                `semantic_veto_matcher=${MATCHER_VERSION}`
              ]
            });
          }
        }
      }
    } catch (error) {
      const message = errorMessage(error).slice(0, 2_000);
      const reason = `semantic_provider_error:${message}`;
      if (this.options.mode === "ENFORCED") this.openCircuit([reason]);
      return {
        ...this.skippedEvaluation(relations, promotion, [reason], message),
        usage
      };
    }

    const proposedRelations = relations.filter((relation) => {
      if (!ARB_ELIGIBLE.has(relation.type)) return true;
      return confirmed.has(relationPairKey(relation.leftId, relation.rightId));
    });
    const vetoedRelations = arbRelations.length - confirmed.size;
    const guardReasons = this.options.mode === "DRY_RUN" && !gateEligible
      ? ["promotion_gate_not_eligible_for_enforcement", ...promotionReasons]
      : [];

    return {
      proposedRelations,
      promotion,
      gateEligible,
      guardReasons,
      checkedRelations: arbRelations.length,
      vetoedRelations,
      confirmedRelations: confirmed.size,
      vetoRate: arbRelations.length === 0 ? 0 : round(vetoedRelations / arbRelations.length),
      usage,
      model: this.verifier.model,
      ...(this.verifier.promptVersion ? { promptVersion: this.verifier.promptVersion } : {}),
      matcherVersion: MATCHER_VERSION
    };
  }

  finalize(
    evaluation: SemanticVetoEvaluation,
    impact: SemanticOpportunityImpact
  ): SemanticRolloutDecision {
    const guardReasons = [...evaluation.guardReasons];
    if (evaluation.providerError) guardReasons.push("semantic_provider_unavailable");
    if (evaluation.vetoRate > this.options.maximumVetoRate) {
      guardReasons.push(`veto_rate_exceeded:${evaluation.vetoRate}>${this.options.maximumVetoRate}`);
    }
    if (impact.introducedOpportunities > 0) {
      guardReasons.push(`semantic_non_monotonic_opportunities:${impact.introducedOpportunities}`);
    }
    if (
      impact.opportunityRetentionRate !== null &&
      impact.opportunityRetentionRate < this.options.minimumOpportunityRetentionRate
    ) {
      guardReasons.push(
        `opportunity_retention_too_low:${impact.opportunityRetentionRate}<${this.options.minimumOpportunityRetentionRate}`
      );
    }

    let trippedThisSync = false;
    if (this.options.mode === "ENFORCED" && guardReasons.length > 0) {
      trippedThisSync = this.openCircuit(guardReasons);
    }
    const effectiveMode = this.options.mode === "ENFORCED" && !this.circuitOpen ? "ENFORCED" : "DRY_RUN";
    return {
      effectiveMode,
      guardReasons: [...new Set(guardReasons)],
      circuitBreaker: this.circuitSnapshot(trippedThisSync)
    };
  }
}
