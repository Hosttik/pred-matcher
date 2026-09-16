import { hydrateKalshiExecutionData } from "../adapters/kalshi-execution.js";
import { fetchKalshiMarkets } from "../adapters/kalshi.js";
import { hydratePolymarketOrderBooks } from "../adapters/polymarket-orderbook.js";
import { fetchPolymarketMarkets } from "../adapters/polymarket.js";
import { matchMarkets } from "../core/matcher.js";
import { findOpportunities } from "../core/opportunities.js";
import { compareOpportunitySets } from "../core/rollout.js";
import type { MarketRelation, NormalizedMarket, SyncResult } from "../core/types.js";
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

export async function syncAll(
  store: MemoryStore,
  semanticVeto?: SemanticVetoService
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

  if (semantic && semanticVeto) {
    const candidateOpportunities = findOpportunities(hydratedMarkets, semantic.proposedRelations, opportunityOptions);
    const opportunityImpact = compareOpportunitySets(baselineOpportunities, candidateOpportunities);
    const rollout = semanticVeto.finalize(semantic, opportunityImpact);
    if (rollout.effectiveMode === "ENFORCED") {
      relations = semantic.proposedRelations;
      opportunities = candidateOpportunities;
    }
    semanticPolicy = {
      requestedMode: semanticVeto.mode === "ENFORCED" ? "ENFORCED" : "DRY_RUN",
      effectiveMode: rollout.effectiveMode,
      gateEligible: semantic.gateEligible,
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
      requests: semantic.usage.requests,
      estimatedCostUsd: semantic.usage.estimatedCostUsd,
      ...(semantic.providerError ? { providerError: semantic.providerError } : {})
    };
  }

  const result: SyncResult = {
    fetched: { polymarket: polymarket.length, kalshi: kalshi.length },
    totalMarkets: hydratedMarkets.length,
    candidatePairs: matched.candidatePairs,
    relations: relations.length,
    opportunities: opportunities.length,
    ...(semanticPolicy ? { semanticPolicy } : {}),
    syncedAt: new Date().toISOString()
  };

  store.replace(hydratedMarkets, relations, opportunities, result);
  return result;
}
