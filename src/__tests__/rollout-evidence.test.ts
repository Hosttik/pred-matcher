import { describe, expect, it } from "vitest";
import {
  attributeVetoDecisions,
  cohortRolloutDecisions,
  deriveRolloutEvents,
  type SemanticRolloutEvidence,
  type SemanticVetoDecisionEvidence
} from "../core/rollout-evidence.js";

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
    enforced: true,
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

function evidence(overrides: Partial<SemanticRolloutEvidence>): SemanticRolloutEvidence {
  return {
    evidenceId: "ev",
    syncedAt: "2026-09-16T10:00:00Z",
    requestedMode: "AUTO",
    effectiveMode: "DRY_RUN",
    safe: true,
    safeStreak: 1,
    autoPromotedThisSync: false,
    gateEligible: true,
    matcherVersion: "heuristic-v1",
    checkedRelations: 2,
    confirmedRelations: 1,
    vetoedRelations: 1,
    vetoRate: 0.5,
    opportunityImpact: {
      baselineOpportunities: 2,
      candidateOpportunities: 1,
      suppressedOpportunities: 1,
      introducedOpportunities: 0,
      opportunityRetentionRate: 0.5,
      suppressedNetProfit: 1,
      maximumSuppressedNetEdgePerShare: 0.02
    },
    guardReasons: [],
    circuitOpen: false,
    ...overrides
  };
}

describe("rollout evidence analytics", () => {
  it("breaks veto evidence down by relation type, venue pair, and actual enforcement", () => {
    const cohorts = cohortRolloutDecisions(decisions);
    expect(cohorts).toContainEqual({
      relationType: "EQUIVALENT",
      venuePair: "kalshi-polymarket",
      decisions: 2,
      confirmed: 1,
      vetoed: 1,
      vetoRate: 0.5,
      enforcedVetoes: 1,
      suppressedOpportunities: 1
    });
  });

  it("derives global and canary rollout transition events", () => {
    const events = deriveRolloutEvents([
      evidence({ evidenceId: "a", safeStreak: 2, syncedAt: "2026-09-16T10:00:00Z" }),
      evidence({
        evidenceId: "b",
        syncedAt: "2026-09-16T10:05:00Z",
        effectiveMode: "ENFORCED",
        safeStreak: 3,
        autoPromotedThisSync: true,
        canary: {
          enabled: true,
          stages: [0.1, 0.25, 0.5, 1],
          safeSyncsPerStage: 2,
          minimumDecisions: 1,
          maximumVetoRate: 1,
          minimumOpportunityRetentionRate: 0,
          aggregateExposure: 0.25,
          eligibleVetoes: 4,
          enforcedVetoes: 1,
          advancedCohorts: 1,
          trippedCohorts: 0,
          cohorts: [{
            key: "EQUIVALENT|kalshi-polymarket",
            relationType: "EQUIVALENT",
            venuePair: "kalshi-polymarket",
            stageIndex: 1,
            exposure: 0.25,
            safeStreak: 0,
            circuitOpen: false,
            reasons: [],
            decisions: 4,
            vetoed: 4,
            vetoRate: 1,
            baselineOpportunities: 0,
            suppressedOpportunities: 0,
            opportunityRetentionRate: null,
            enforcedVetoes: 1,
            advancedThisSync: true,
            trippedThisSync: false
          }]
        }
      }),
      evidence({
        evidenceId: "c",
        syncedAt: "2026-09-16T10:10:00Z",
        effectiveMode: "DRY_RUN",
        safe: false,
        safeStreak: 0,
        circuitOpen: true,
        guardReasons: ["veto_rate_exceeded"]
      })
    ]);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "AUTO_PROMOTED",
      "ENFORCEMENT_STARTED",
      "ENFORCEMENT_STOPPED",
      "CIRCUIT_OPENED",
      "SAFE_STREAK_RESET",
      "CANARY_STAGE_ADVANCED"
    ]));
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
