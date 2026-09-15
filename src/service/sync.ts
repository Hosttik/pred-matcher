import { fetchKalshiMarkets } from "../adapters/kalshi.js";
import { fetchPolymarketMarkets } from "../adapters/polymarket.js";
import { matchMarkets } from "../core/matcher.js";
import type { NormalizedMarket, SyncResult } from "../core/types.js";
import { MemoryStore } from "./store.js";

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
  const result: SyncResult = {
    fetched: { polymarket: polymarket.length, kalshi: kalshi.length },
    totalMarkets: markets.length,
    candidatePairs,
    relations: relations.length,
    syncedAt: new Date().toISOString()
  };

  store.replace(markets, relations, result);
  return result;
}
