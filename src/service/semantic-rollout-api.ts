import type { IncomingMessage, ServerResponse } from "node:http";
import { attributeVetoDecisions, cohortRolloutDecisions, deriveRolloutEvents } from "../core/rollout-evidence.js";
import type { QualityRepository } from "./quality-repository.js";
import type { SemanticVetoService } from "./semantic-veto.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function boundedLimit(value: string | null, fallback: number, max: number): number | undefined {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : undefined;
}

export async function handleSemanticRolloutRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  repository: QualityRepository,
  semanticVeto: SemanticVetoService
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/semantic/")) return false;

  if (request.method === "GET" && url.pathname === "/v1/semantic/status") {
    json(response, 200, semanticVeto.getStatus());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/v1/semantic/circuit/reset") {
    json(response, 200, semanticVeto.resetCircuit());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/v1/semantic/evidence") {
    const limit = boundedLimit(url.searchParams.get("limit"), 100, 5000);
    if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
    const evidence = repository.listRolloutEvidence(limit);
    json(response, 200, { count: evidence.length, evidence });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/v1/semantic/events") {
    const limit = boundedLimit(url.searchParams.get("limit"), 500, 5000);
    if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
    const evidence = repository.listRolloutEvidence(limit);
    const events = deriveRolloutEvents(evidence);
    json(response, 200, { count: events.length, events });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/v1/semantic/decisions") {
    const limit = boundedLimit(url.searchParams.get("limit"), 500, 20_000);
    if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
    const actionParam = url.searchParams.get("action");
    const action = actionParam === "VETOED" || actionParam === "CONFIRMED" ? actionParam : undefined;
    if (actionParam !== null && !action) { json(response, 400, { error: "invalid_action" }); return true; }
    const evidenceId = url.searchParams.get("evidenceId") ?? undefined;
    const decisions = repository.listRolloutDecisions({
      limit,
      ...(evidenceId ? { evidenceId } : {}),
      ...(action ? { action } : {})
    });
    json(response, 200, { count: decisions.length, decisions });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/v1/semantic/cohorts") {
    const limit = boundedLimit(url.searchParams.get("limit"), 5000, 20_000);
    if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
    const decisions = repository.listRolloutDecisions({ limit });
    const cohorts = cohortRolloutDecisions(decisions);
    json(response, 200, { decisions: decisions.length, cohorts });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/v1/semantic/attribution") {
    const limit = boundedLimit(url.searchParams.get("limit"), 5000, 20_000);
    if (limit === undefined) { json(response, 400, { error: "invalid_limit" }); return true; }
    const decisions = repository.listRolloutDecisions({ limit, action: "VETOED" });
    const attribution = attributeVetoDecisions(decisions, repository.listLabels(), repository.listSettlements());
    const counts = attribution.reduce<Record<string, number>>((accumulator, item) => {
      accumulator[item.attribution] = (accumulator[item.attribution] ?? 0) + 1;
      return accumulator;
    }, {});
    json(response, 200, { count: attribution.length, counts, attribution });
    return true;
  }
  return false;
}
