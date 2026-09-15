import { hydrateKalshiExecutionData } from "../adapters/kalshi-execution.js";
import { fetchKalshiMarkets } from "../adapters/kalshi.js";
import { hydratePolymarketOrderBooks } from "../adapters/polymarket-orderbook.js";
import { fetchPolymarketMarkets } from "../adapters/polymarket.js";
import { matchMarkets } from "../core/matcher.js";
import { findOpportunities } from "../core/opportunities.js";
import type { MarketRelation, NormalizedMarket, SyncResult } from "../core/types.js";
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

export async function syncAll(store: MemoryStore): Promise<SyncResult> {
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
  const { candidatePairs, relations } = matchMarkets(markets);
  const relevantIds = opportunityMarketIds(relations);
  const withPolymarketDepth = await hydratePolymarketOrderBooks(markets, relevantIds);
  const hydratedMarkets = await hydrateKalshiExecutionData(withPolymarketDepth, relevantIds);
  const opportunities = findOpportunities(hydratedMarkets, relations, {
    includeStale: true,
    maxQuoteAgeMs: 60_000
  });
  const result: SyncResult = {
    fetched: { polymarket: polymarket.length, kalshi: kalshi.length },
    totalMarkets: hydratedMarkets.length,
    candidatePairs,
    relations: relations.length,
    opportunities: opportunities.length,
    syncedAt: new Date().toISOString()
  };

  store.replace(hydratedMarkets, relations, opportunities, result);
  return result;
}
