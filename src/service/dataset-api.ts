import type { IncomingMessage, ServerResponse } from "node:http";
import { relationPairKey } from "../core/quality.js";
import { replayHistoricalFrames, type ReplayMode } from "../core/replay.js";
import type { MarketRelation } from "../core/types.js";
import type { ReviewCandidateKind } from "../core/dataset.js";
import { DatasetCaptureScheduler } from "./dataset-capture.js";
import { DatasetRepository } from "./dataset-repository.js";
import type { QualityRepository } from "./quality-repository.js";
import type { MemoryStore } from "./store.js";

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new ApiError(413, "request_body_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

function positiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ApiError(400, "invalid_limit");
  return Math.min(parsed, max);
}

function optionalDate(value: string | null, code: string): string | undefined {
  if (value === null) return undefined;
  if (!Number.isFinite(new Date(value).valueOf())) throw new ApiError(400, code);
  return value;
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function replayMode(value: unknown): ReplayMode {
  if (value === undefined) return "CAPTURED_RELATIONS";
  if (value === "FIXED_RELATIONS" || value === "REMATCH" || value === "CAPTURED_RELATIONS") return value;
  throw new ApiError(400, "invalid_replay_mode");
}

export async function handleDatasetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: MemoryStore,
  qualityRepository: QualityRepository,
  datasetRepository: DatasetRepository,
  captureScheduler: DatasetCaptureScheduler
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/dataset/")) return false;

  try {
    if (request.method === "GET" && url.pathname === "/v1/dataset/status") {
      json(response, 200, {
        repository: datasetRepository.status(),
        capture: captureScheduler.getStatus()
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/dataset/capture") {
      const snapshot = captureScheduler.capture("MANUAL");
      if (!snapshot) throw new ApiError(409, "dataset_capture_not_ready");
      json(response, 200, { snapshot });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/dataset/snapshots") {
      const limit = positiveInt(url.searchParams.get("limit"), 100, 5000);
      const from = optionalDate(url.searchParams.get("from"), "invalid_from");
      const to = optionalDate(url.searchParams.get("to"), "invalid_to");
      const snapshots = datasetRepository.listSnapshots({
        limit,
        ...(from ? { from } : {}),
        ...(to ? { to } : {})
      });
      json(response, 200, { count: snapshots.length, snapshots });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/dataset/frame") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id < 1) throw new ApiError(400, "invalid_snapshot_id");
      const frame = datasetRepository.loadFrame(id);
      if (!frame) throw new ApiError(404, "snapshot_not_found");
      json(response, 200, { id, frame });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/dataset/review") {
      const limit = positiveInt(url.searchParams.get("limit"), 100, 1000);
      const kindParam = url.searchParams.get("kind");
      const kind: ReviewCandidateKind | undefined = kindParam === "HARD_NEGATIVE" || kindParam === "UNCERTAIN_RELATION"
        ? kindParam
        : undefined;
      if (kindParam && !kind) throw new ApiError(400, "invalid_review_kind");
      const unlabeledOnly = url.searchParams.get("unlabeled") !== "false";
      const labels = qualityRepository.listLabels();
      const labelsByPair = new Map(labels.map((label) => [relationPairKey(label.leftId, label.rightId), label]));
      const fetchLimit = Math.min(2000, Math.max(limit, limit * 5));
      const candidates = datasetRepository.listReviewCandidates(fetchLimit, kind)
        .map((candidate) => ({ candidate, label: labelsByPair.get(candidate.pairKey) ?? null }))
        .filter((entry) => !unlabeledOnly || entry.label === null)
        .slice(0, limit);
      json(response, 200, {
        count: candidates.length,
        unlabeledOnly,
        candidates
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/dataset/replay") {
      const body = await readJson(request);
      if (!isObject(body)) throw new ApiError(400, "invalid_replay_request");
      const mode = replayMode(body.mode);
      const limit = typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0
        ? Math.min(body.limit, 1000)
        : 500;
      const from = typeof body.from === "string" ? optionalDate(body.from, "invalid_from") : undefined;
      const to = typeof body.to === "string" ? optionalDate(body.to, "invalid_to") : undefined;
      const frames = datasetRepository.loadFrames({
        limit,
        ...(from ? { from } : {}),
        ...(to ? { to } : {})
      });
      if (frames.length === 0) throw new ApiError(404, "dataset_frames_not_found");

      const minimumCandidateScore = numberOption(body.minimumCandidateScore);
      const minimumGrossEdge = numberOption(body.minimumGrossEdge);
      const minimumNetEdge = numberOption(body.minimumNetEdge);
      const targetShares = numberOption(body.targetShares);
      const maxQuoteAgeMs = numberOption(body.maxQuoteAgeMs);
      const relations = Array.isArray(body.relations) ? body.relations as MarketRelation[] : store.listRelations();
      const report = replayHistoricalFrames(frames, relations, {
        mode,
        ...(minimumCandidateScore !== undefined ? { minimumCandidateScore } : {}),
        ...(minimumGrossEdge !== undefined ? { minimumGrossEdge } : {}),
        ...(minimumNetEdge !== undefined ? { minimumNetEdge } : {}),
        ...(targetShares !== undefined && targetShares > 0 ? { targetShares } : {}),
        ...(maxQuoteAgeMs !== undefined && maxQuoteAgeMs > 0 ? { maxQuoteAgeMs } : {}),
        includeStale: body.includeStale === true
      });
      json(response, 200, {
        snapshotFrames: frames.length,
        source: "dataset",
        report
      });
      return true;
    }

    return false;
  } catch (error) {
    if (error instanceof ApiError) {
      json(response, error.status, { error: error.code });
      return true;
    }
    throw error;
  }
}
