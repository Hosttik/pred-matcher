import { describe, expect, it } from "vitest";
import { compareOpportunitySets } from "../core/rollout.js";
import type { MarketOpportunity } from "../core/types.js";

function opportunity(id: string, netProfit: number, netEdgePerShare: number): MarketOpportunity {
  return {
    id,
    bestExecution: { netProfit, netEdgePerShare }
  } as MarketOpportunity;
}

describe("semantic rollout opportunity impact", () => {
  it("reports retention and economic value of opportunities suppressed by veto", () => {
    const baseline = [
      opportunity("keep", 2.5, 0.02),
      opportunity("drop", 4.25, 0.04)
    ];
    const candidate = [baseline[0]!];

    expect(compareOpportunitySets(baseline, candidate)).toEqual({
      baselineOpportunities: 2,
      candidateOpportunities: 1,
      suppressedOpportunities: 1,
      introducedOpportunities: 0,
      opportunityRetentionRate: 0.5,
      suppressedNetProfit: 4.25,
      maximumSuppressedNetEdgePerShare: 0.04
    });
  });

  it("flags non-monotonic candidate opportunities", () => {
    const baseline = [opportunity("base", 1, 0.01)];
    const candidate = [baseline[0]!, opportunity("unexpected", 2, 0.02)];
    const impact = compareOpportunitySets(baseline, candidate);
    expect(impact.introducedOpportunities).toBe(1);
    expect(impact.opportunityRetentionRate).toBe(2);
  });
});
