import type { MarketOpportunity, SemanticOpportunityImpact } from "./types.js";

function round(value: number): number {
  return Number(value.toFixed(8));
}

function selectedExecution(opportunity: MarketOpportunity) {
  return opportunity.targetExecution ?? opportunity.bestExecution;
}

export function compareOpportunitySets(
  baseline: readonly MarketOpportunity[],
  candidate: readonly MarketOpportunity[]
): SemanticOpportunityImpact {
  const baselineById = new Map(baseline.map((opportunity) => [opportunity.id, opportunity]));
  const candidateById = new Map(candidate.map((opportunity) => [opportunity.id, opportunity]));
  const suppressed = [...baselineById.entries()]
    .filter(([id]) => !candidateById.has(id))
    .map(([, opportunity]) => opportunity);
  const introduced = [...candidateById.keys()].filter((id) => !baselineById.has(id)).length;
  const retention = baseline.length === 0 ? 1 : candidate.length / baseline.length;
  const suppressedEdges = suppressed.map((opportunity) => selectedExecution(opportunity).netEdgePerShare);

  return {
    baselineOpportunities: baseline.length,
    candidateOpportunities: candidate.length,
    suppressedOpportunities: suppressed.length,
    introducedOpportunities: introduced,
    opportunityRetentionRate: Number.isFinite(retention) ? round(retention) : null,
    suppressedNetProfit: round(suppressed.reduce((sum, opportunity) => sum + selectedExecution(opportunity).netProfit, 0)),
    maximumSuppressedNetEdgePerShare: suppressedEdges.length > 0 ? round(Math.max(...suppressedEdges)) : null
  };
}
