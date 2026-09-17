import { evaluateSettlementConsistency } from "./settlement.js";
import { normalizeRelationLabel, relationPairKey, type RelationLabel } from "./quality.js";
import type {
  MarketRelation,
  RelationType,
  SemanticCanarySyncResult,
  SemanticOpportunityImpact,
  SemanticRolloutMode,
  Venue
} from "./types.js";
import type { MarketSettlement } from "./settlement.js";

export type SemanticVetoAction = "CONFIRMED" | "VETOED";

export interface SemanticRolloutEvidence {
  evidenceId: string;
  syncedAt: string;
  requestedMode: Exclude<SemanticRolloutMode, "OFF">;
  effectiveMode: "DRY_RUN" | "ENFORCED";
  safe: boolean;
  safeStreak: number;
  autoPromotedThisSync: boolean;
  gateEligible: boolean;
  matcherVersion: string;
  model?: string;
  promptVersion?: string;
  checkedRelations: number;
  confirmedRelations: number;
  vetoedRelations: number;
  vetoRate: number;
  opportunityImpact: SemanticOpportunityImpact;
  guardReasons: string[];
  circuitOpen: boolean;
  canary?: SemanticCanarySyncResult;
}

export interface SemanticVetoDecisionEvidence {
  evidenceId: string;
  pairKey: string;
  leftId: string;
  rightId: string;
  leftVenue: Venue;
  rightVenue: Venue;
  relationType: RelationType;
  direction?: MarketRelation["direction"];
  relationConfidence: number;
  action: SemanticVetoAction;
  enforced?: boolean;
  suppressedOpportunity: boolean;
  capturedAt: string;
}

export interface SemanticRolloutCohort {
  relationType: RelationType;
  venuePair: string;
  decisions: number;
  confirmed: number;
  vetoed: number;
  vetoRate: number;
  enforcedVetoes: number;
  suppressedOpportunities: number;
}

export type SemanticRolloutEventType =
  | "AUTO_PROMOTED"
  | "ENFORCEMENT_STARTED"
  | "ENFORCEMENT_STOPPED"
  | "CIRCUIT_OPENED"
  | "CIRCUIT_RESET_OBSERVED"
  | "SAFE_STREAK_RESET"
  | "CANARY_STAGE_ADVANCED"
  | "CANARY_CIRCUIT_OPENED";

export interface SemanticRolloutEvent {
  type: SemanticRolloutEventType;
  evidenceId: string;
  occurredAt: string;
  requestedMode: Exclude<SemanticRolloutMode, "OFF">;
  effectiveMode: "DRY_RUN" | "ENFORCED";
  safeStreak: number;
  reasons: string[];
  cohort?: string;
}

export type SemanticVetoAttribution =
  | "CORRECT_VETO_BY_LABEL"
  | "FALSE_VETO_BY_LABEL"
  | "PREVENTED_SETTLEMENT_VIOLATION"
  | "NOT_FALSIFIED_BY_SETTLEMENT"
  | "INCONCLUSIVE";

export interface SemanticVetoAttributionRecord {
  evidenceId: string;
  pairKey: string;
  leftId: string;
  rightId: string;
  relationType: RelationType;
  attribution: SemanticVetoAttribution;
  labelType?: RelationLabel["type"];
  settlementStatus?: "CONSISTENT" | "VIOLATED" | "INCONCLUSIVE";
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function exactLabelMatch(decision: SemanticVetoDecisionEvidence, label: RelationLabel): boolean {
  const normalized = normalizeRelationLabel({
    leftId: decision.leftId,
    rightId: decision.rightId,
    type: decision.relationType,
    source: "MANUAL",
    labeledAt: decision.capturedAt,
    ...(decision.direction ? { direction: decision.direction } : {})
  });
  return normalized.type === label.type && (normalized.direction ?? undefined) === (label.direction ?? undefined);
}

export function cohortRolloutDecisions(
  decisions: readonly SemanticVetoDecisionEvidence[]
): SemanticRolloutCohort[] {
  const groups = new Map<string, SemanticVetoDecisionEvidence[]>();
  for (const decision of decisions) {
    const venuePair = [decision.leftVenue, decision.rightVenue].sort().join("-");
    const key = `${decision.relationType}|${venuePair}`;
    const current = groups.get(key) ?? [];
    current.push(decision);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, values]) => {
    const [relationType, venuePair] = key.split("|") as [RelationType, string];
    const vetoed = values.filter((value) => value.action === "VETOED").length;
    return {
      relationType,
      venuePair,
      decisions: values.length,
      confirmed: values.length - vetoed,
      vetoed,
      vetoRate: values.length === 0 ? 0 : round(vetoed / values.length),
      enforcedVetoes: values.filter((value) => value.action === "VETOED" && value.enforced === true).length,
      suppressedOpportunities: values.filter((value) => value.suppressedOpportunity).length
    };
  }).sort((a, b) => b.decisions - a.decisions || a.relationType.localeCompare(b.relationType));
}

export function deriveRolloutEvents(evidence: readonly SemanticRolloutEvidence[]): SemanticRolloutEvent[] {
  const ordered = [...evidence].sort((a, b) => a.syncedAt.localeCompare(b.syncedAt));
  const events: SemanticRolloutEvent[] = [];
  let previous: SemanticRolloutEvidence | undefined;
  const push = (type: SemanticRolloutEventType, item: SemanticRolloutEvidence, cohort?: string, reasons = item.guardReasons): void => {
    events.push({
      type,
      evidenceId: item.evidenceId,
      occurredAt: item.syncedAt,
      requestedMode: item.requestedMode,
      effectiveMode: item.effectiveMode,
      safeStreak: item.safeStreak,
      reasons,
      ...(cohort ? { cohort } : {})
    });
  };
  for (const item of ordered) {
    if (item.autoPromotedThisSync) push("AUTO_PROMOTED", item);
    if (item.effectiveMode === "ENFORCED" && previous?.effectiveMode !== "ENFORCED") push("ENFORCEMENT_STARTED", item);
    if (item.effectiveMode === "DRY_RUN" && previous?.effectiveMode === "ENFORCED") push("ENFORCEMENT_STOPPED", item);
    if (item.circuitOpen && !previous?.circuitOpen) push("CIRCUIT_OPENED", item);
    if (!item.circuitOpen && previous?.circuitOpen) push("CIRCUIT_RESET_OBSERVED", item);
    if (item.safeStreak === 0 && (previous?.safeStreak ?? 0) > 0) push("SAFE_STREAK_RESET", item);
    for (const cohort of item.canary?.cohorts ?? []) {
      if (cohort.advancedThisSync) push("CANARY_STAGE_ADVANCED", item, cohort.key, cohort.reasons);
      if (cohort.trippedThisSync) push("CANARY_CIRCUIT_OPENED", item, cohort.key, cohort.reasons);
    }
    previous = item;
  }
  return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function attributeVetoDecisions(
  decisions: readonly SemanticVetoDecisionEvidence[],
  labels: readonly RelationLabel[],
  settlements: readonly MarketSettlement[]
): SemanticVetoAttributionRecord[] {
  const labelByPair = new Map(labels.filter((label) => label.source !== "PSEUDO").map((label) => [
    relationPairKey(label.leftId, label.rightId), label
  ]));
  const vetoed = decisions.filter((decision) => decision.action === "VETOED");
  const settlementRelations: MarketRelation[] = vetoed.map((decision) => ({
    leftId: decision.leftId,
    rightId: decision.rightId,
    type: decision.relationType,
    confidence: decision.relationConfidence,
    evidence: ["rollout_evidence"],
    ...(decision.direction ? { direction: decision.direction } : {})
  }));
  const settlementReport = evaluateSettlementConsistency(settlementRelations, settlements);
  const settlementByPair = new Map(settlementReport.checks.map((check) => [relationPairKey(check.leftId, check.rightId), check]));

  return vetoed.map((decision) => {
    const label = labelByPair.get(decision.pairKey);
    const settlement = settlementByPair.get(decision.pairKey);
    let attribution: SemanticVetoAttribution = "INCONCLUSIVE";
    if (label) {
      attribution = exactLabelMatch(decision, label) ? "FALSE_VETO_BY_LABEL" : "CORRECT_VETO_BY_LABEL";
    } else if (settlement?.status === "VIOLATED") {
      attribution = "PREVENTED_SETTLEMENT_VIOLATION";
    } else if (settlement?.status === "CONSISTENT") {
      attribution = "NOT_FALSIFIED_BY_SETTLEMENT";
    }
    return {
      evidenceId: decision.evidenceId,
      pairKey: decision.pairKey,
      leftId: decision.leftId,
      rightId: decision.rightId,
      relationType: decision.relationType,
      attribution,
      ...(label ? { labelType: label.type } : {}),
      ...(settlement ? { settlementStatus: settlement.status } : {})
    };
  });
}
