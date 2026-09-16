import type { MarketRelation } from "./types.js";

export type SettlementOutcome = "YES" | "NO" | "INVALID";

export interface MarketSettlement {
  marketId: string;
  outcome: SettlementOutcome;
  resolvedAt: string;
  source?: string;
}

export type SettlementConsistency = "CONSISTENT" | "VIOLATED" | "INCONCLUSIVE";

export interface RelationSettlementCheck {
  leftId: string;
  rightId: string;
  relationType: MarketRelation["type"];
  direction?: MarketRelation["direction"];
  status: SettlementConsistency;
  reason: string;
  leftOutcome?: SettlementOutcome;
  rightOutcome?: SettlementOutcome;
}

export interface SettlementConsistencyReport {
  relations: number;
  checked: number;
  consistent: number;
  violated: number;
  inconclusive: number;
  checks: RelationSettlementCheck[];
  evaluatedAt: string;
}

function checkRelation(
  relation: MarketRelation,
  settlements: ReadonlyMap<string, MarketSettlement>
): RelationSettlementCheck {
  const left = settlements.get(relation.leftId);
  const right = settlements.get(relation.rightId);
  const base = {
    leftId: relation.leftId,
    rightId: relation.rightId,
    relationType: relation.type,
    ...(relation.direction ? { direction: relation.direction } : {}),
    ...(left ? { leftOutcome: left.outcome } : {}),
    ...(right ? { rightOutcome: right.outcome } : {})
  };

  if (!left || !right) {
    return { ...base, status: "INCONCLUSIVE", reason: "missing_settlement" };
  }
  if (left.outcome === "INVALID" || right.outcome === "INVALID") {
    return { ...base, status: "INCONCLUSIVE", reason: "invalid_or_void_settlement" };
  }
  if (relation.type === "SIMILAR") {
    return { ...base, status: "INCONCLUSIVE", reason: "similarity_has_no_logical_settlement_constraint" };
  }
  if (relation.type === "EQUIVALENT") {
    return left.outcome === right.outcome
      ? { ...base, status: "CONSISTENT", reason: "equivalent_markets_settled_to_same_outcome" }
      : { ...base, status: "VIOLATED", reason: "equivalent_markets_settled_to_different_outcomes" };
  }
  if (!relation.direction) {
    return { ...base, status: "INCONCLUSIVE", reason: "directed_relation_missing_direction" };
  }

  const antecedent = relation.direction === "LEFT_IMPLIES_RIGHT" ? left.outcome : right.outcome;
  const consequent = relation.direction === "LEFT_IMPLIES_RIGHT" ? right.outcome : left.outcome;
  if (antecedent === "YES" && consequent === "NO") {
    return { ...base, status: "VIOLATED", reason: "antecedent_settled_yes_while_consequent_settled_no" };
  }
  return { ...base, status: "CONSISTENT", reason: "settlement_did_not_violate_implication" };
}

export function evaluateSettlementConsistency(
  relations: readonly MarketRelation[],
  settlements: readonly MarketSettlement[]
): SettlementConsistencyReport {
  const byMarket = new Map(settlements.map((settlement) => [settlement.marketId, settlement]));
  const checks = relations.map((relation) => checkRelation(relation, byMarket));
  const checked = checks.filter((check) => check.status !== "INCONCLUSIVE").length;
  const consistent = checks.filter((check) => check.status === "CONSISTENT").length;
  const violated = checks.filter((check) => check.status === "VIOLATED").length;
  return {
    relations: relations.length,
    checked,
    consistent,
    violated,
    inconclusive: checks.length - checked,
    checks,
    evaluatedAt: new Date().toISOString()
  };
}
