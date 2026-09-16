import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OpenAISemanticVerifier } from "./adapters/openai-semantic-verifier.js";
import { buildContractSpec } from "./core/contract.js";
import { findOpportunities } from "./core/opportunities.js";
import type { OpportunityType, Venue } from "./core/types.js";
import { CatalogRefresher } from "./service/catalog-refresh.js";
import { DatasetCaptureScheduler } from "./service/dataset-capture.js";
import { handleDatasetRequest } from "./service/dataset-api.js";
import { DatasetRepository } from "./service/dataset-repository.js";
import { LiveScanner } from "./service/live-scanner.js";
import { renderPrometheusMetrics } from "./service/metrics.js";
import { handleQualityRequest } from "./service/quality-api.js";
import { QualityRepository } from "./service/quality-repository.js";
import { handleShadowRequest } from "./service/shadow-api.js";
import { ShadowVerifierService } from "./service/shadow-verifier.js";
import { SqliteStateRepository } from "./service/sqlite-state.js";
import { MemoryStore } from "./service/store.js";
import { syncAll } from "./service/sync.js";

const VERSION = "0.11.0";
const STARTED_AT_MS = Date.now();

function configuredPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredProbability(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function createPersistence(): SqliteStateRepository | undefined {
  if (process.env.PRED_MATCHER_PERSISTENCE === "false") return undefined;
  const historyLimit = configuredPositiveInt("PRED_MATCHER_HISTORY_LIMIT", 10_000);
  const path = process.env.PRED_MATCHER_DB_PATH?.trim() ||
    (process.env.NODE_ENV === "test" ? ":memory:" : "./data/pred-matcher.sqlite");
  return new SqliteStateRepository(path, historyLimit);
}

function createQualityRepository(): QualityRepository {
  const path = process.env.PRED_MATCHER_QUALITY_DB_PATH?.trim() ||
    (process.env.NODE_ENV === "test" ? ":memory:" : "./data/pred-matcher-quality.sqlite");
  return new QualityRepository(path);
}

function createDatasetRepository(): DatasetRepository {
  const path = process.env.PRED_MATCHER_DATASET_DB_PATH?.trim() ||
    (process.env.NODE_ENV === "test" ? ":memory:" : "./data/pred-matcher-dataset.sqlite");
  const maxSnapshots = configuredPositiveInt("PRED_MATCHER_DATASET_MAX_SNAPSHOTS", 576);
  return new DatasetRepository(path, maxSnapshots);
}

function createSemanticVerifier(): OpenAISemanticVerifier | undefined {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAISemanticVerifier({
    apiKey,
    model: process.env.PRED_MATCHER_SHADOW_MODEL?.trim() || "gpt-5.6-luna",
    baseUrl: "https://api.openai.com/v1",
    timeoutMs: configuredPositiveInt("PRED_MATCHER_SHADOW_TIMEOUT_MS", 45_000)
  });
}

const historyLimit = configuredPositiveInt("PRED_MATCHER_HISTORY_LIMIT", 10_000);
const store = new MemoryStore(historyLimit, createPersistence());
const qualityRepository = createQualityRepository();
const datasetRepository = createDatasetRepository();
const liveScanner = new LiveScanner(store);
const shadowVerifier = new ShadowVerifierService(store, qualityRepository, createSemanticVerifier(), {
  enabled: process.env.PRED_MATCHER_SHADOW_ENABLED === "true",
  autoRun: process.env.PRED_MATCHER_SHADOW_AUTO_RUN === "true",
  minimumCandidateScore: configuredProbability("PRED_MATCHER_SHADOW_MIN_CANDIDATE_SCORE", 0.2),
  maxPairs: configuredPositiveInt("PRED_MATCHER_SHADOW_MAX_PAIRS", 50),
  batchSize: configuredPositiveInt("PRED_MATCHER_SHADOW_BATCH_SIZE", 10)
});
const datasetCaptureMs = configuredPositiveInt("PRED_MATCHER_DATASET_CAPTURE_MS", 300_000);
const datasetCaptureScheduler = new DatasetCaptureScheduler(
  store,
  datasetRepository,
  datasetCaptureMs,
  process.env.PRED_MATCHER_DATASET_AUTO_CAPTURE !== "false"
);
let activeSync: Promise<unknown> | undefined;

async function performSync(): Promise<unknown> {
  if (activeSync) return activeSync;
  const restartLive = liveScanner.getStatus().running;
  activeSync = syncAll(store);
  try {
    const result = await activeSync;
    if (restartLive) await liveScanner.restart();
    if (shadowVerifier.shouldAutoRun()) {
      try {
        await shadowVerifier.run();
      } catch (error) {
        console.error("shadow verification failed", error);
      }
    }
    return result;
  } finally {
    activeSync = undefined;
  }
}

const catalogRefreshMs = configuredPositiveInt("PRED_MATCHER_CATALOG_REFRESH_MS", 300_000);
const catalogRefresher = new CatalogRefresher(
  async () => {
    if (activeSync) return false;
    await performSync();
    return true;
  },
  catalogRefreshMs,
  process.env.PRED_MATCHER_CATALOG_AUTO_REFRESH !== "false"
);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function urlFor(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

function opportunityType(value: string | null): OpportunityType | undefined {
  return value === "EQUIVALENT_ARB" || value === "IMPLICATION_ARB" ? value : undefined;
}

function nonNegativeNumber(value: string | null, fallback: number): number | undefined {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = urlFor(request);

  if (request.method === "GET" && url.pathname === "/health") {
    const persistence = store.getPersistenceStatus();
    const quality = qualityRepository.status();
    const dataset = datasetRepository.status();
    const healthy = persistence.healthy && quality.healthy && dataset.healthy;
    json(response, healthy ? 200 : 503, {
      status: healthy ? "ok" : "degraded",
      version: VERSION,
      lastSync: store.getLastSync() ?? null,
      persistence,
      quality,
      dataset,
      datasetCapture: datasetCaptureScheduler.getStatus(),
      catalog: catalogRefresher.getStatus(),
      live: liveScanner.getStatus(),
      shadow: shadowVerifier.getStatus()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/ready") {
    const persistence = store.getPersistenceStatus();
    const quality = qualityRepository.status();
    const dataset = datasetRepository.status();
    const ready = Boolean(store.getLastSync()) && persistence.healthy && quality.healthy && dataset.healthy;
    json(response, ready ? 200 : 503, {
      ready,
      restoredOrSynced: Boolean(store.getLastSync()),
      persistenceHealthy: persistence.healthy,
      qualityPersistenceHealthy: quality.healthy,
      datasetPersistenceHealthy: dataset.healthy
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    text(response, 200, renderPrometheusMetrics(
      VERSION,
      store,
      liveScanner.getStatus(),
      catalogRefresher.getStatus(),
      STARTED_AT_MS
    ), "text/plain; version=0.0.4; charset=utf-8");
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/sync") {
    if (activeSync) { json(response, 409, { error: "sync_already_running" }); return; }
    json(response, 200, await performSync());
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/catalog/status") {
    json(response, 200, catalogRefresher.getStatus());
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/catalog/refresh") {
    if (activeSync) { json(response, 409, { error: "sync_already_running" }); return; }
    json(response, 200, await performSync());
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/live/status") {
    json(response, 200, liveScanner.getStatus());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/live/start") {
    if (!store.getLastSync()) await performSync();
    json(response, 200, await liveScanner.start());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/live/stop") {
    json(response, 200, liveScanner.stop());
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/history") {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isFinite(limit) || limit < 1) { json(response, 400, { error: "invalid_limit" }); return; }
    const opportunityId = url.searchParams.get("opportunityId") ?? undefined;
    const history = store.listHistory(limit, opportunityId);
    json(response, 200, { count: history.length, history });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/markets") {
    const venueParam = url.searchParams.get("venue");
    const venue = venueParam === "polymarket" || venueParam === "kalshi" ? venueParam as Venue : undefined;
    const markets = store.listMarkets(venue);
    json(response, 200, { count: markets.length, markets });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/contracts") {
    const marketId = url.searchParams.get("marketId");
    if (!marketId) { json(response, 400, { error: "market_id_required" }); return; }
    const market = store.getMarket(marketId);
    if (!market) { json(response, 404, { error: "market_not_found" }); return; }
    json(response, 200, { marketId: market.id, contract: buildContractSpec(market) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/relations") {
    const type = url.searchParams.get("type");
    const relations = store.listRelations().filter((relation) => !type || relation.type === type);
    json(response, 200, { count: relations.length, relations });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/opportunities") {
    const typeParam = url.searchParams.get("type");
    const type = opportunityType(typeParam);
    if (typeParam && !type) { json(response, 400, { error: "invalid_opportunity_type" }); return; }
    const minimumGrossEdge = nonNegativeNumber(url.searchParams.get("minGrossEdge"), 0);
    const minimumNetEdge = nonNegativeNumber(url.searchParams.get("minNetEdge"), 0);
    const maxQuoteAgeMs = positiveNumber(url.searchParams.get("maxQuoteAgeMs")) ?? 15_000;
    const targetParam = url.searchParams.get("targetShares");
    const targetShares = positiveNumber(targetParam);
    if (minimumGrossEdge === undefined || minimumNetEdge === undefined) { json(response, 400, { error: "invalid_edge_filter" }); return; }
    if (targetParam !== null && targetShares === undefined) { json(response, 400, { error: "invalid_target_shares" }); return; }
    const includeStale = url.searchParams.get("includeStale") === "true";
    const opportunities = findOpportunities(store.listMarkets(), store.listRelations(), {
      minimumGrossEdge, minimumNetEdge, maxQuoteAgeMs, includeStale,
      ...(targetShares !== undefined ? { targetShares } : {})
    }).filter((opportunity) => !type || opportunity.type === type);
    json(response, 200, {
      count: opportunities.length,
      feesIncluded: true,
      depthIncluded: true,
      staleQuotesIncluded: includeStale,
      targetShares: targetShares ?? null,
      persistence: store.getPersistenceStatus(),
      live: liveScanner.getStatus(),
      opportunities
    });
    return;
  }

  if (await handleQualityRequest(request, response, url, store, qualityRepository)) return;
  if (await handleDatasetRequest(request, response, url, store, qualityRepository, datasetRepository, datasetCaptureScheduler)) return;
  if (await handleShadowRequest(request, response, url, shadowVerifier, qualityRepository)) return;
  json(response, 404, { error: "not_found" });
}

export function createAppServer() {
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown_error";
      json(response, 500, { error: "internal_error", message });
    });
  });
}

async function initializeRuntime(): Promise<void> {
  const autoLive = process.env.PRED_MATCHER_LIVE_AUTO_START === "true";
  const autoCatalog = process.env.PRED_MATCHER_CATALOG_AUTO_REFRESH !== "false";
  const autoDataset = process.env.PRED_MATCHER_DATASET_AUTO_CAPTURE !== "false";
  const autoShadow = shadowVerifier.shouldAutoRun();
  let synced = false;

  if (autoCatalog) catalogRefresher.start(false);
  if (!store.getLastSync() && (autoCatalog || autoLive || autoDataset || autoShadow)) {
    await performSync();
    synced = true;
  }
  if (autoLive && store.getLastSync()) await liveScanner.start();
  if (autoDataset) datasetCaptureScheduler.start(true);
  if (autoShadow && store.getLastSync() && !synced) {
    try { await shadowVerifier.run(); } catch (error) { console.error("initial shadow verification failed", error); }
  }
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  const server = createAppServer();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    catalogRefresher.stop();
    datasetCaptureScheduler.stop();
    liveScanner.stop();
    server.close(() => {
      store.close();
      qualityRepository.close();
      datasetRepository.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, "0.0.0.0", () => {
    console.log(`pred-matcher v${VERSION} listening on :${port}`);
    void initializeRuntime().catch((error: unknown) => {
      console.error("runtime initialization failed", error);
    });
  });
}
