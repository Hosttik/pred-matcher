import type { LiveScannerStatus, Venue } from "../core/types.js";
import type { CatalogRefreshStatus } from "./catalog-refresh.js";
import { MemoryStore } from "./store.js";

function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function timestampSeconds(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).valueOf();
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function liveStatusMetric(live: LiveScannerStatus, venue: Venue): string {
  const state = live.venues[venue];
  return `pred_matcher_live_connection{venue="${venue}",status="${label(state.status)}"} 1`;
}

export function renderPrometheusMetrics(
  version: string,
  store: MemoryStore,
  live: LiveScannerStatus,
  catalog: CatalogRefreshStatus,
  startedAtMs: number
): string {
  const persistence = store.getPersistenceStatus();
  const lastSync = store.getLastSync();
  const polymarket = store.listMarkets("polymarket").length;
  const kalshi = store.listMarkets("kalshi").length;
  const lines = [
    "# HELP pred_matcher_info Build information.",
    "# TYPE pred_matcher_info gauge",
    `pred_matcher_info{version="${label(version)}"} 1`,
    "# HELP pred_matcher_uptime_seconds Process uptime measured by the application.",
    "# TYPE pred_matcher_uptime_seconds gauge",
    `pred_matcher_uptime_seconds ${Math.max(0, (Date.now() - startedAtMs) / 1000)}`,
    "# HELP pred_matcher_markets Current normalized markets by venue.",
    "# TYPE pred_matcher_markets gauge",
    `pred_matcher_markets{venue="polymarket"} ${polymarket}`,
    `pred_matcher_markets{venue="kalshi"} ${kalshi}`,
    "# HELP pred_matcher_relations Current verified and similar relations.",
    "# TYPE pred_matcher_relations gauge",
    `pred_matcher_relations ${store.listRelations().length}`,
    "# HELP pred_matcher_opportunities Current stored executable opportunities.",
    "# TYPE pred_matcher_opportunities gauge",
    `pred_matcher_opportunities ${store.listOpportunities().length}`,
    "# HELP pred_matcher_last_sync_timestamp_seconds Timestamp of the last catalog sync.",
    "# TYPE pred_matcher_last_sync_timestamp_seconds gauge",
    `pred_matcher_last_sync_timestamp_seconds ${timestampSeconds(lastSync?.syncedAt)}`,
    "# HELP pred_matcher_persistence_enabled Durable persistence is configured.",
    "# TYPE pred_matcher_persistence_enabled gauge",
    `pred_matcher_persistence_enabled ${persistence.enabled ? 1 : 0}`,
    "# HELP pred_matcher_persistence_healthy Durable persistence health.",
    "# TYPE pred_matcher_persistence_healthy gauge",
    `pred_matcher_persistence_healthy ${persistence.healthy ? 1 : 0}`,
    "# HELP pred_matcher_persisted_objects Objects currently present in durable storage.",
    "# TYPE pred_matcher_persisted_objects gauge",
    `pred_matcher_persisted_objects{kind="markets"} ${persistence.markets}`,
    `pred_matcher_persisted_objects{kind="relations"} ${persistence.relations}`,
    `pred_matcher_persisted_objects{kind="opportunities"} ${persistence.opportunities}`,
    `pred_matcher_persisted_objects{kind="history"} ${persistence.historyEvents}`,
    "# HELP pred_matcher_live_running Live scanner lifecycle state.",
    "# TYPE pred_matcher_live_running gauge",
    `pred_matcher_live_running ${live.running ? 1 : 0}`,
    "# HELP pred_matcher_live_updates_total Market book updates applied by the live scanner.",
    "# TYPE pred_matcher_live_updates_total counter",
    `pred_matcher_live_updates_total ${live.updatesApplied}`,
    "# HELP pred_matcher_live_recomputations_total Relation-local recomputations performed by the live scanner.",
    "# TYPE pred_matcher_live_recomputations_total counter",
    `pred_matcher_live_recomputations_total ${live.recomputations}`,
    "# HELP pred_matcher_live_connection Current connection state by venue.",
    "# TYPE pred_matcher_live_connection gauge",
    liveStatusMetric(live, "polymarket"),
    liveStatusMetric(live, "kalshi"),
    "# HELP pred_matcher_live_subscribed_markets Markets currently assigned to live subscriptions.",
    "# TYPE pred_matcher_live_subscribed_markets gauge",
    `pred_matcher_live_subscribed_markets{venue="polymarket"} ${live.venues.polymarket.subscribedMarkets}`,
    `pred_matcher_live_subscribed_markets{venue="kalshi"} ${live.venues.kalshi.subscribedMarkets}`,
    "# HELP pred_matcher_live_connections WebSocket connections allocated by venue.",
    "# TYPE pred_matcher_live_connections gauge",
    `pred_matcher_live_connections{venue="polymarket"} ${live.venues.polymarket.connections ?? 0}`,
    `pred_matcher_live_connections{venue="kalshi"} ${live.venues.kalshi.connections ?? 0}`,
    "# HELP pred_matcher_catalog_refresh_total Periodic catalog refresh outcomes.",
    "# TYPE pred_matcher_catalog_refresh_total counter",
    `pred_matcher_catalog_refresh_total{result="attempt"} ${catalog.attempts}`,
    `pred_matcher_catalog_refresh_total{result="success"} ${catalog.successes}`,
    `pred_matcher_catalog_refresh_total{result="failure"} ${catalog.failures}`,
    `pred_matcher_catalog_refresh_total{result="skipped"} ${catalog.skipped}`,
    "# HELP pred_matcher_catalog_refresh_running Whether a scheduled catalog refresh is currently running.",
    "# TYPE pred_matcher_catalog_refresh_running gauge",
    `pred_matcher_catalog_refresh_running ${catalog.running ? 1 : 0}`,
    ""
  ];
  return lines.join("\n");
}
