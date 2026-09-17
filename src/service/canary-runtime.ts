import type { SemanticCanarySyncResult } from "../core/types.js";
import { CanaryEnforcementService } from "./canary-enforcement.js";
import type { SemanticProductionMode } from "./semantic-veto.js";

let service: CanaryEnforcementService | undefined;
let serviceKey: string | undefined;

function probability(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stages(): number[] {
  const raw = process.env.PRED_MATCHER_CANARY_STAGES?.trim();
  if (!raw) return [0.1, 0.25, 0.5, 1];
  return raw.split(",").map(Number).filter((value) => Number.isFinite(value));
}

function enabled(mode: SemanticProductionMode): boolean {
  const raw = process.env.PRED_MATCHER_CANARY_ENABLED?.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return mode === "AUTO";
}

export function getCanaryEnforcementService(
  mode: SemanticProductionMode,
  initial?: SemanticCanarySyncResult
): CanaryEnforcementService {
  const options = {
    enabled: enabled(mode),
    stages: stages(),
    safeSyncsPerStage: positiveInt("PRED_MATCHER_CANARY_SAFE_SYNCS_PER_STAGE", 6),
    minimumDecisions: positiveInt("PRED_MATCHER_CANARY_MIN_DECISIONS", 5),
    maximumVetoRate: probability("PRED_MATCHER_CANARY_MAX_VETO_RATE", 0.35),
    minimumOpportunityRetentionRate: probability("PRED_MATCHER_CANARY_MIN_OPPORTUNITY_RETENTION", 0.5)
  };
  const key = JSON.stringify({ mode, ...options });
  if (!service || serviceKey !== key) {
    service = new CanaryEnforcementService({ ...options, ...(initial ? { initial } : {}) });
    serviceKey = key;
  }
  return service;
}

export function peekCanaryEnforcementService(): CanaryEnforcementService | undefined {
  return service;
}
