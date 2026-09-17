import { randomUUID } from "node:crypto";
import { hydrateKalshiExecutionData } from "../adapters/kalshi-execution.js";
import { fetchKalshiMarkets } from "../adapters/kalshi.js";
import { hydratePolymarketOrderBooks } from "../adapters/polymarket-orderbook.js";
import { fetchPolymarketMarkets } from "../adapters/polymarket.js";
import { matchMarkets } from "../core/matcher.js";
import { findOpportunities } from "../core/opportunities.js";
import { relationPairKey } from "../core/quality.js";
import { compareOpportunitySets } from "../core/rollout.js";
import type { SemanticRolloutEvidence, SemanticVetoDecisionEvidence } from "../core/rollout-evidence.js";
import type { MarketRelation, NormalizedMarket, SyncResult } from "../core/types.js";
import type { CanaryEnforcementService } from "./canary-enforcement.js";
import type { QualityRepository } from "./quality-repository.js";
import type { SemanticVetoService } from "./semantic-veto.js";
import { MemoryStore } from "./store.js";

function opportunityMarketIds(relations: readonly MarketRelation[]): Set<string> {
  const ids = new Set<string>();
  for (const relation of relations) {
    if (relation.type === "SIMILAR") continue;
    ids.add(relation.leftId);
    ids.add(relation.rightId);
  }
  return ids;
}

function suppressedOpportunityPairs(
  baseline: ReturnType<typeof findOpportunities>,
  candidate: ReturnType<typeof findOpportunities>
): Set<string> {
  const candidateIds = new Set(candidate.map((opportunity) => opportunity.id));
  return new Set(baseline.filter((opportunity) => !candidateIds.has(opportunity.id)).map((opportunity) =>
    relationPairKey(opportunity.legs[0].marketId, opportunity.legs[1].marketId)
  ));
}

export async function syncAll(
  store: MemoryStore,
  semanticVeto?: SemanticVetoService,
  qualityRepository?: QualityRepository,
  canaryEnforcement?: CanaryEnforcementService
): Promise<SyncResult> {
  const [polymarketResult, kalshiResult] = await Promise.allSettled([
    fetchPolymarketMarkets(),
    fetchKalshiMarkets()
  ]);

  const polymarket = polymarketResult.status === "fulfilled" ? polymarketResult.value : [];
  const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : [];

  if (polymarketResult.status === "rejected" && kalshiResult.status === "rejected") {
    throw new AggregateError([polymarketResult.reason, kalshiResult.reason], "Both venue syncs failed");
  }

  const markets: NormalizedMarket[] = [...polymarket, ...kalshi];
  const matched = matchMarkets(markets);
  const semantic = await semanticVeto?.evaluate(markets, matched.relations);

  // Hydrate the baseline relation set even when semantic enforcement is requested.
  // This makes dry-run/enforced opportunity impact directly comparable on identical books.
  const relevantIds = opportunityMarketIds(matched.relations);
  const withPolymarketDepth = await hydratePolymarketOrderBooks(markets, relevantIds);
  const hydratedMarkets = await hydrateKalshiExecutionData(withPolymarketDepth, relevantIds);
  const opportunityOptions = { includeStale: true, maxQuoteAgeMs: 60_000 } as const;
  const baselineOpportunities = findOpportunities(hydratedMarkets, matched.relations, opportunityOptions);

  let relations = matched.relations;
  let opportunities = baselineOpportunities;
  let semanticPolicy: SyncResult["semanticPolicy"];
  let rolloutEvidence: SemanticRolloutEvidence | undefined;
  let rolloutDecisions: SemanticVetoDecisionEvidence[] = [];
  let enforcedVetoPairs = new Set<string>();

  if (semantic && semanticVeto) {
    const candidateOpportunities = findOpportunities(hydratedMarkets, semantic.proposedRelations, opportunityOptions);
    const opportunityImpact = compareOpportunitySets(baselineOpportunities, candidateOpportunities);
    const rollout = semanticVeto.finalize(semantic, opportunityImpact);
    let canary = canaryEnforcement?.getStatus();

    if (rollout.effectiveMode === "ENFORCED") {
      if (canaryEnforcement) {
        const canaryResult = canaryEnforcement.apply(
          hydratedMarkets,
          matched.relations,
          semantic.decisions,
          baselineOpportunities,
          candidateOpportunities,
          rollout.safe
        );
        relations = canaryResult.relations;
        opportunities = findOpportunities(hydratedMarkets, relations, opportunityOptions);
        canary = canaryResult.snapshot;
        enforcedVetoPairs = canaryResult.enforcedVetoPairs;
      } else {
        relations = semantic.proposedRelations;
        opportunities = candidateOpportunities;
        enforcedVetoPairs = new Set(semantic.decisions.filter((decision) => decision.action === "VETOED").map((decision) =>
          relationPairKey(decision.relation.leftId, decision.relation.rightId)
        ));
      }
    }

    semanticPolicy = {
      requestedMode: semanticVeto.mode === "ENFORCED" ? "ENFORCED" : semanticVeto.mode === "AUTO" ? "AUTO" : "DRY_RUN",
      effectiveMode: rollout.effectiveMode,
      gateEligible: semantic.gateEligible,
      safe: rollout.safe,
      safeStreak: rollout.safeStreak,
      autoPromotionRequiredSyncs: semanticVeto.getStatus().autoPromotionRequiredSyncs,
      autoPromotedThisSync: rollout.autoPromotedThisSync,
      matcherVersion: semantic.matcherVersion,
      ...(semantic.model ? { model: semantic.model } : {}),
      ...(semantic.promptVersion ? { promptVersion: semantic.promptVersion } : {}),
      promotionEvaluatedAt: semantic.promotion.evaluatedAt,
      promotionNewestEvidenceAt: semantic.promotion.newestEvidenceAt,
      checkedRelations: semantic.checkedRelations,
      vetoedRelations: semantic.vetoedRelations,
      confirmedRelations: semantic.confirmedRelations,
      vetoRate: semantic.vetoRate,
      opportunityImpact,
      guardReasons: rollout.guardReasons,
      circuitBreaker: rollout.circuitBreaker,
      ...(canary ? { canary } : {}),
      requests: semantic.usage.requests,
      estimatedCostUsd: semantic.usage.estimatedCostUsd,
      ...(semantic.providerError ? { providerError: semantic.providerError } : {})
    };

    const evidenceId = randomUUID();
    const syncedAt = new Date().toISOString();
    rolloutEvidence = {
      evidenceId,
      syncedAt,
      requestedMode: semanticPolicy.requestedMode,
      effectiveMode: semanticPolicy.effectiveMode,
      safe: semanticPolicy.safe,
      safeStreak: semanticPolicy.safeStreak,
      autoPromotedThisSync: semanticPolicy.autoPromotedThisSync,
      gateEligible: semanticPolicy.gateEligible,
      matcherVersion: semanticPolicy.matcherVersion,
      ...(semanticPolicy.model ? { model: semanticPolicy.model } : {}),
      ...(semanticPolicy.promptVersion ? { promptVersion: semanticPolicy.promptVersion } : {}),
      checkedRelations: semanticPolicy.checkedRelations,
      confirmedRelations: semanticPolicy.confirmedRelations,
      vetoedRelations: semanticPolicy.vetoedRelations,
      vetoRate: semanticPolicy.vetoRate,
      opportunityImpact,
      guardReasons: semanticPolicy.guardReasons,
      circuitOpen: semanticPolicy.circuitBreaker.open,
      ...(semanticPolicy.canary ? { canary: semanticPolicy.canary } : {})
    };
    const marketById = new Map(hydratedMarkets.map((market) => [market.id, market]));
    const suppressedPairs = suppressedOpportunityPairs(baselineOpportunities, candidateOpportunities);
    rolloutDecisions = semantic.decisions.flatMap(({ relation, action }) => {
      const left = marketById.get(relation.leftId);
      const right = marketById.get(relation.rightId);
      if (!left || !right) return [];
      const pairKey = relationPairKey(relation.leftId, relation.rightId);
      return [{
        evidenceId,
        pairKey,
        leftId: relation.leftId,
        rightId: relation.rightId,
        leftVenue: left.venue,
        rightVenue: right.venue,
        relationType: relation.type,
        ...(relation.direction ? { direction: relation.direction } : {}),
        relationConfidence: relation.confidence,
        action,
        enforced: action === "VETOED" && enforcedVetoPairs.has(pairKey),
        suppressedOpportunity: action === "VETOED" && suppressedPairs.has(pairKey),
        capturedAt: syncedAt
      } satisfies SemanticVetoDecisionEvidence];
    });
  }

  const result: SyncResult = {
    fetched: { polymarket: polymarket.length, kalshi: kalshi.length },
    totalMarkets: hydratedMarkets.length,
    candidatePairs: matched.candidatePairs,
    relations: relations.length,
    opportunities: opportunities.length,
    ...(semanticPolicy ? { semanticPolicy } : {}),
    syncedAt: rolloutEvidence?.syncedAt ?? new Date().toISOString()
  };

  if (rolloutEvidence && qualityRepository) {
    qualityRepository.appendRolloutEvidence(rolloutEvidence, rolloutDecisions);
  }
  store.replace(hydratedMarkets, relations, opportunities, result);
  return result;
}
