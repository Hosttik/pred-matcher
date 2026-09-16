import { describe, expect, it } from "vitest";
import { attributeVetoDecisions, cohortRolloutDecisions, type SemanticVetoDecisionEvidence } from "../core/rollout-evidence.js";

const decisions: SemanticVetoDecisionEvidence[] = [
  {
    evidenceId: "e1",
    pairKey: "[\"kalshi:k1\",\"polymarket:p1\"]",
    leftId: "polymarket:p1",
    rightId: "kalshi:k1",
    leftVenue: "polymarket",
    rightVenue: "kalshi",
    relationType: "EQUIVALENT",
    relationConfidence: 0.9,
    action: "VETOED",
    suppressedOpportunity: true,
    capturedAt: "2026-09-16T10:00:00Z"
  },
  {
    evidenceId: "e1",
    pairKey: "[\"kalshi:k2\",\"polymarket:p2\"]",
    leftId: "polymarket:p2",
    rightId: "kalshi:k2",
    leftVenue: "polymarket",
    rightVenue: "kalshi",
    relationType: "EQUIVALENT",
    relationConfidence: 0.88,
    action: "CONFIRMED",
    suppressedOpportunity: false,
    capturedAt: "2026-09-16T10:00:00Z"
  },
  {
    evidenceId: "e2",
    pairKey: "[\"kalshi:k3\",\"polymarket:p3\"]",
    leftId: "polymarket:p3",
    rightId: "kalshi:k3",
    leftVenue: "polymarket",
    rightVenue: "kalshi",
    relationType: "IMPLIES",
    direction: "LEFT_IMPLIES_RIGHT",
    relationConfidence: 0.85,
    action: "VETOED",
    suppressedOpportunity: false,
    capturedAt: "2026-09-16T10:05:00Z"
  }
];

describe("rollout evidence analytics", () => {
  it("breaks veto evidence down by relation type and venue pair", () => {
    const cohorts = cohortRolloutDecisions(decisions);
    expect(cohorts).toContainEqual({
      relationType: "EQUIVALENT",
      venuePair: "kalshi-polymarket",
      decisions: 2,
      confirmed: 1,
      vetoed: 1,
      vetoRate: 0.5,
      suppressedOpportunities: 1
    });
  });

  it("uses labels for true/false veto attribution and settlements only as falsification evidence", () => {
    const attribution = attributeVetoDecisions(decisions, [{
      leftId: "polymarket:p1",
      rightId: "kalshi:k1",
      type: "NONE",
      source: "ADJUDICATED",
      labeledAt: "2026-09-16T11:00:00Z"
    }], [
      { marketId: "polymarket:p3", outcome: "YES", resolvedAt: "2026-09-17T00:00:00Z" },
      { marketId: "kalshi:k3", outcome: "NO", resolvedAt: "2026-09-17T00:00:00Z" }
    ]);

    expect(attribution.find((item) => item.leftId === "polymarket:p1")?.attribution).toBe("CORRECT_VETO_BY_LABEL");
    expect(attribution.find((item) => item.leftId === "polymarket:p3")?.attribution).toBe("PREVENTED_SETTLEMENT_VIOLATION");
  });
});
