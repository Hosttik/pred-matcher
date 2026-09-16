import type { IncomingMessage, ServerResponse } from "node:http";
import type { QualityRepository } from "./quality-repository.js";
import { ShadowVerifierService, ShadowVerifierServiceError } from "./shadow-verifier.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function positiveInt(value: string | null, fallback: number, max: number): number | undefined {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, max);
}

export async function handleShadowRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: ShadowVerifierService,
  repository: QualityRepository
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/shadow/")) return false;

  try {
    if (request.method === "GET" && url.pathname === "/v1/shadow/status") {
      json(response, 200, service.getStatus());
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/shadow/run") {
      json(response, 200, await service.run());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/runs") {
      const limit = positiveInt(url.searchParams.get("limit"), 50, 1000);
      if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
      const runs = repository.listShadowRuns(limit);
      json(response, 200, { count: runs.length, runs });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/observations") {
      const limit = positiveInt(url.searchParams.get("limit"), 100, 5000);
      if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
      const runId = url.searchParams.get("runId")?.trim() || undefined;
      const observations = repository.listShadowVerifications({ limit, ...(runId ? { runId } : {}) });
      json(response, 200, { count: observations.length, observations });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/report") {
      const requestedRunId = url.searchParams.get("runId")?.trim();
      const run = requestedRunId ? repository.getShadowRun(requestedRunId) : repository.listShadowRuns(1)[0];
      if (!run) { json(response, 404, { error: "shadow_run_not_found" }); return true; }
      const observations = repository.listShadowVerifications({ limit: 5000, runId: run.runId });
      json(response, 200, { run, observations });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/experiments") {
      const limit = positiveInt(url.searchParams.get("limit"), 50, 1000);
      if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
      const experiments = repository.listShadowExperiments(limit);
      json(response, 200, { count: experiments.length, experiments });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/experiment") {
      const experimentId = url.searchParams.get("id")?.trim();
      if (!experimentId) { json(response, 400, { error: "experiment_id_required" }); return true; }
      const experiment = repository.getShadowExperiment(experimentId);
      if (!experiment) { json(response, 404, { error: "shadow_experiment_not_found" }); return true; }
      const runs = experiment.runIds.flatMap((runId) => {
        const run = repository.getShadowRun(runId);
        return run ? [run] : [];
      });
      json(response, 200, { experiment, runs });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/shadow/review") {
      const limit = positiveInt(url.searchParams.get("limit"), 100, 5000);
      if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
      const experimentId = url.searchParams.get("experimentId")?.trim() || undefined;
      const candidates = repository.listShadowReviewCandidates({ limit, ...(experimentId ? { experimentId } : {}) });
      json(response, 200, { count: candidates.length, candidates });
      return true;
    }

    json(response, 404, { error: "not_found" });
    return true;
  } catch (error) {
    if (error instanceof ShadowVerifierServiceError) {
      json(response, error.status, { error: error.code });
      return true;
    }
    throw error;
  }
}
