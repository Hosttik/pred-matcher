import { evaluateSettlementConsistency } from "./settlement.js";
import { relationPairKey, type RelationLabel } from "./quality.js";
import type { MarketRelation, RelationType, SemanticOpportunityImpact, SemanticRolloutMode, Venue } from "./types.js";
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
  suppressedOpportunities: number;
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
  return decision.relationType === label.type && (decision.direction ?? undefined) === (label.direction ?? undefined);
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
      suppressedOpportunities: values.filter((value) => value.suppressedOpportunity).length
    };
  }).sort((a, b) => b.decisions - a.decisions || a.relationType.localeCompare(b.relationType));
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
