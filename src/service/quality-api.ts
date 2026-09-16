import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluateMatcherQuality, relationPairKey, type RelationLabel, type RelationLabelSource, type RelationLabelType } from "../core/quality.js";
import { replayHistoricalFrames, type ReplayFrame, type ReplayMode } from "../core/replay.js";
import { evaluateSettlementConsistency, type MarketSettlement, type SettlementOutcome } from "../core/settlement.js";
import type { MarketRelation, RelationType } from "../core/types.js";
import { QualityRepository } from "./quality-repository.js";
import type { MemoryStore } from "./store.js";

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const RELATION_TYPES = new Set<RelationType>([
  "EQUIVALENT",
  "SIMILAR",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);
const LABEL_TYPES = new Set<RelationLabelType>([...RELATION_TYPES, "NONE"]);
const LABEL_SOURCES = new Set<RelationLabelSource>(["MANUAL", "ADJUDICATED", "PSEUDO"]);
const SETTLEMENT_OUTCOMES = new Set<SettlementOutcome>(["YES", "NO", "INVALID"]);

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

function validDate(value: string): boolean {
  return Number.isFinite(new Date(value).valueOf());
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseLabel(value: unknown): RelationLabel {
  if (!isObject(value)) throw new ApiError(400, "invalid_label");
  const leftId = typeof value.leftId === "string" ? value.leftId.trim() : "";
  const rightId = typeof value.rightId === "string" ? value.rightId.trim() : "";
  const type = typeof value.type === "string" && LABEL_TYPES.has(value.type as RelationLabelType)
    ? value.type as RelationLabelType
    : undefined;
  const source = value.source === undefined
    ? "MANUAL"
    : typeof value.source === "string" && LABEL_SOURCES.has(value.source as RelationLabelSource)
      ? value.source as RelationLabelSource
      : undefined;
  const direction = value.direction === "LEFT_IMPLIES_RIGHT" || value.direction === "RIGHT_IMPLIES_LEFT"
    ? value.direction
    : undefined;
  const directed = type === "THRESHOLD_NESTED" || type === "TIME_NESTED" || type === "IMPLIES";
  if (!leftId || !rightId || leftId === rightId || !type || !source || (directed && !direction)) {
    throw new ApiError(400, "invalid_label");
  }
  const labeledAt = typeof value.labeledAt === "string" ? value.labeledAt : new Date().toISOString();
  if (!validDate(labeledAt)) throw new ApiError(400, "invalid_labeled_at");
  return {
    leftId,
    rightId,
    type,
    source,
    labeledAt,
    ...(direction ? { direction } : {}),
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes.trim() } : {})
  };
}

function parseSettlement(value: unknown): MarketSettlement {
  if (!isObject(value)) throw new ApiError(400, "invalid_settlement");
  const marketId = typeof value.marketId === "string" ? value.marketId.trim() : "";
  const outcome = typeof value.outcome === "string" && SETTLEMENT_OUTCOMES.has(value.outcome as SettlementOutcome)
    ? value.outcome as SettlementOutcome
    : undefined;
  const resolvedAt = typeof value.resolvedAt === "string" ? value.resolvedAt : new Date().toISOString();
  if (!marketId || !outcome || !validDate(resolvedAt)) throw new ApiError(400, "invalid_settlement");
  return {
    marketId,
    outcome,
    resolvedAt,
    ...(typeof value.source === "string" && value.source.trim() ? { source: value.source.trim() } : {})
  };
}

function parseFrames(value: unknown): ReplayFrame[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, "replay_frames_required");
  for (const frame of value) {
    if (!isObject(frame) || typeof frame.capturedAt !== "string" || !validDate(frame.capturedAt) || !Array.isArray(frame.markets)) {
      throw new ApiError(400, "invalid_replay_frame");
    }
  }
  return value as ReplayFrame[];
}

export async function handleQualityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: MemoryStore,
  repository: QualityRepository
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/quality/") && url.pathname !== "/v1/replay") return false;

  try {
    if (request.method === "GET" && url.pathname === "/v1/quality/status") {
      json(response, 200, repository.status());
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/quality/labels") {
      const labels = repository.listLabels();
      json(response, 200, { count: labels.length, labels });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/quality/labels") {
      const label = repository.upsertLabel(parseLabel(await readJson(request)));
      json(response, 200, { label });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/quality/report") {
      const includePseudo = url.searchParams.get("includePseudo") === "true";
      const labels = repository.listLabels().filter((label) => includePseudo || label.source !== "PSEUDO");
      json(response, 200, evaluateMatcherQuality(store.listRelations(), labels));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/quality/candidates") {
      const labels = repository.listLabels();
      const byPair = new Map(labels.map((label) => [relationPairKey(label.leftId, label.rightId), label]));
      const unlabeledOnly = url.searchParams.get("unlabeled") === "true";
      const candidates = store.listRelations().map((relation) => ({
        relation,
        label: byPair.get(relationPairKey(relation.leftId, relation.rightId)) ?? null
      })).filter((candidate) => !unlabeledOnly || candidate.label === null);
      json(response, 200, { count: candidates.length, candidates });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/quality/settlements") {
      const settlements = repository.listSettlements();
      json(response, 200, { count: settlements.length, settlements });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/quality/settlements") {
      const settlement = repository.upsertSettlement(parseSettlement(await readJson(request)));
      json(response, 200, { settlement });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/quality/settlement-report") {
      json(response, 200, evaluateSettlementConsistency(store.listRelations(), repository.listSettlements()));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/replay") {
      const body = await readJson(request, 25_000_000);
      if (!isObject(body)) throw new ApiError(400, "invalid_replay_request");
      const frames = parseFrames(body.frames);
      const mode: ReplayMode = body.mode === "REMATCH"
        ? "REMATCH"
        : body.mode === "CAPTURED_RELATIONS"
          ? "CAPTURED_RELATIONS"
          : "FIXED_RELATIONS";
      if (
        body.mode !== undefined &&
        body.mode !== "REMATCH" &&
        body.mode !== "FIXED_RELATIONS" &&
        body.mode !== "CAPTURED_RELATIONS"
      ) {
        throw new ApiError(400, "invalid_replay_mode");
      }
      const relations = Array.isArray(body.relations) ? body.relations as MarketRelation[] : store.listRelations();
      const minimumCandidateScore = numberOption(body.minimumCandidateScore);
      const minimumGrossEdge = numberOption(body.minimumGrossEdge);
      const minimumNetEdge = numberOption(body.minimumNetEdge);
      const targetShares = numberOption(body.targetShares);
      const maxQuoteAgeMs = numberOption(body.maxQuoteAgeMs);
      const report = replayHistoricalFrames(frames, relations, {
        mode,
        ...(minimumCandidateScore !== undefined ? { minimumCandidateScore } : {}),
        ...(minimumGrossEdge !== undefined ? { minimumGrossEdge } : {}),
        ...(minimumNetEdge !== undefined ? { minimumNetEdge } : {}),
        ...(targetShares !== undefined && targetShares > 0 ? { targetShares } : {}),
        ...(maxQuoteAgeMs !== undefined && maxQuoteAgeMs > 0 ? { maxQuoteAgeMs } : {}),
        includeStale: body.includeStale === true
      });
      json(response, 200, report);
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
