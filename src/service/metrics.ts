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
  const semantic = lastSync?.semanticPolicy;
  const canary = semantic?.canary;
  const polymarket = store.listMarkets("polymarket").length;
  const kalshi = store.listMarkets("kalshi").length;
  const requestedMode = semantic?.requestedMode ?? "OFF";
  const effectiveMode = semantic?.effectiveMode ?? "OFF";
  const safeStreak = semantic && Number.isFinite(semantic.safeStreak) ? semantic.safeStreak : 0;
  const autoPromotionRequiredSyncs = semantic && Number.isFinite(semantic.autoPromotionRequiredSyncs) && semantic.autoPromotionRequiredSyncs > 0
    ? semantic.autoPromotionRequiredSyncs
    : 12;
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
    "# HELP pred_matcher_semantic_policy Current requested/effective semantic rollout mode.",
    "# TYPE pred_matcher_semantic_policy gauge",
    `pred_matcher_semantic_policy{requested="${label(requestedMode)}",effective="${label(effectiveMode)}"} 1`,
    "# HELP pred_matcher_semantic_circuit_open Whether the semantic rollout circuit breaker is latched open.",
    "# TYPE pred_matcher_semantic_circuit_open gauge",
    `pred_matcher_semantic_circuit_open ${semantic?.circuitBreaker.open ? 1 : 0}`,
    "# HELP pred_matcher_semantic_safe_streak Consecutive safe semantic rollout syncs.",
    "# TYPE pred_matcher_semantic_safe_streak gauge",
    `pred_matcher_semantic_safe_streak ${safeStreak}`,
    "# HELP pred_matcher_semantic_auto_promotion_progress Fraction of required safe syncs completed for AUTO promotion.",
    "# TYPE pred_matcher_semantic_auto_promotion_progress gauge",
    `pred_matcher_semantic_auto_promotion_progress ${Math.min(1, safeStreak / autoPromotionRequiredSyncs)}`,
    "# HELP pred_matcher_semantic_auto_promoted_this_sync Whether AUTO transitioned to ENFORCED in the last sync.",
    "# TYPE pred_matcher_semantic_auto_promoted_this_sync gauge",
    `pred_matcher_semantic_auto_promoted_this_sync ${semantic?.autoPromotedThisSync ? 1 : 0}`,
    "# HELP pred_matcher_semantic_veto_rate Fraction of checked arb relations proposed for veto in the last sync.",
    "# TYPE pred_matcher_semantic_veto_rate gauge",
    `pred_matcher_semantic_veto_rate ${semantic?.vetoRate ?? 0}`,
    "# HELP pred_matcher_semantic_opportunity_retention Fraction of baseline opportunities retained by semantic policy.",
    "# TYPE pred_matcher_semantic_opportunity_retention gauge",
    `pred_matcher_semantic_opportunity_retention ${semantic?.opportunityImpact.opportunityRetentionRate ?? 1}`,
    "# HELP pred_matcher_semantic_suppressed_opportunities Opportunities removed by the semantic candidate policy in the last sync.",
    "# TYPE pred_matcher_semantic_suppressed_opportunities gauge",
    `pred_matcher_semantic_suppressed_opportunities ${semantic?.opportunityImpact.suppressedOpportunities ?? 0}`,
    "# HELP pred_matcher_semantic_canary_enabled Whether cohort canary enforcement is enabled.",
    "# TYPE pred_matcher_semantic_canary_enabled gauge",
    `pred_matcher_semantic_canary_enabled ${canary?.enabled ? 1 : 0}`,
    "# HELP pred_matcher_semantic_canary_exposure Fraction of veto-eligible relations actually enforced in the last sync.",
    "# TYPE pred_matcher_semantic_canary_exposure gauge",
    `pred_matcher_semantic_canary_exposure ${canary?.aggregateExposure ?? 0}`,
    "# HELP pred_matcher_semantic_canary_vetoes Semantic veto counts at the canary boundary.",
    "# TYPE pred_matcher_semantic_canary_vetoes gauge",
    `pred_matcher_semantic_canary_vetoes{kind="eligible"} ${canary?.eligibleVetoes ?? 0}`,
    `pred_matcher_semantic_canary_vetoes{kind="enforced"} ${canary?.enforcedVetoes ?? 0}`,
    "# HELP pred_matcher_semantic_canary_cohorts Cohort canary transitions in the last sync.",
    "# TYPE pred_matcher_semantic_canary_cohorts gauge",
    `pred_matcher_semantic_canary_cohorts{state="advanced"} ${canary?.advancedCohorts ?? 0}`,
    `pred_matcher_semantic_canary_cohorts{state="tripped"} ${canary?.trippedCohorts ?? 0}`,
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
