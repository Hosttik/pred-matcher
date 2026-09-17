import { describe, expect, it } from "vitest";
import type { MarketRelation, NormalizedMarket } from "../core/types.js";
import { CanaryEnforcementService, type CanaryDecision } from "../service/canary-enforcement.js";

function market(id: string, venue: "polymarket" | "kalshi"): NormalizedMarket {
  return { id: `${venue}:${id}`, venue, externalId: id, title: id, prices: {} };
}

function relation(index: number, type: MarketRelation["type"] = "EQUIVALENT"): MarketRelation {
  return {
    leftId: `polymarket:p${index}`,
    rightId: `kalshi:k${index}`,
    type,
    confidence: 0.9,
    evidence: []
  };
}

function fixtures(count = 8): { markets: NormalizedMarket[]; relations: MarketRelation[]; decisions: CanaryDecision[] } {
  const markets: NormalizedMarket[] = [];
  const relations: MarketRelation[] = [];
  const decisions: CanaryDecision[] = [];
  for (let index = 0; index < count; index += 1) {
    markets.push(market(`p${index}`, "polymarket"), market(`k${index}`, "kalshi"));
    const item = relation(index);
    relations.push(item);
    decisions.push({ relation: item, action: "VETOED" });
  }
  return { markets, relations, decisions };
}

function service(overrides: Partial<ConstructorParameters<typeof CanaryEnforcementService>[0]> = {}) {
  return new CanaryEnforcementService({
    enabled: true,
    stages: [0.25, 0.5, 1],
    safeSyncsPerStage: 2,
    minimumDecisions: 1,
    maximumVetoRate: 1,
    minimumOpportunityRetentionRate: 0,
    ...overrides
  });
}

describe("CanaryEnforcementService", () => {
  it("advances cohort exposure only after consecutive safe syncs", () => {
    const canary = service();
    const { markets, relations, decisions } = fixtures();

    const first = canary.apply(markets, relations, decisions, [], [], true);
    expect(first.snapshot.cohorts[0]?.exposure).toBe(0.25);
    expect(first.snapshot.cohorts[0]?.safeStreak).toBe(1);

    const second = canary.apply(markets, relations, decisions, [], [], true);
    expect(second.snapshot.cohorts[0]?.stageIndex).toBe(1);
    expect(second.snapshot.cohorts[0]?.exposure).toBe(0.5);
    expect(second.snapshot.cohorts[0]?.advancedThisSync).toBe(true);

    canary.apply(markets, relations, decisions, [], [], true);
    const fourth = canary.apply(markets, relations, decisions, [], [], true);
    expect(fourth.snapshot.cohorts[0]?.stageIndex).toBe(2);
    expect(fourth.snapshot.cohorts[0]?.exposure).toBe(1);
    expect(fourth.relations).toHaveLength(0);
  });

  it("latches only the cohort whose veto-rate budget is violated", () => {
    const canary = service({ maximumVetoRate: 0.5, stages: [1] });
    const markets = [market("p1", "polymarket"), market("k1", "kalshi"), market("p2", "polymarket"), market("k2", "kalshi")];
    const bad = relation(1, "EQUIVALENT");
    const good = relation(2, "IMPLIES");
    const result = canary.apply(markets, [bad, good], [
      { relation: bad, action: "VETOED" },
      { relation: good, action: "CONFIRMED" }
    ], [], [], true);

    const badState = result.snapshot.cohorts.find((cohort) => cohort.relationType === "EQUIVALENT");
    const goodState = result.snapshot.cohorts.find((cohort) => cohort.relationType === "IMPLIES");
    expect(badState?.circuitOpen).toBe(true);
    expect(badState?.exposure).toBe(0);
    expect(badState?.trippedThisSync).toBe(true);
    expect(goodState?.circuitOpen).toBe(false);
    expect(result.relations).toHaveLength(2);

    canary.reset(badState?.key);
    expect(canary.getStatus().cohorts.find((cohort) => cohort.relationType === "EQUIVALENT")?.circuitOpen).toBe(false);
  });

  it("keeps stable hash assignment across repeated syncs at a fixed stage", () => {
    const canary = service({ stages: [0.5], safeSyncsPerStage: 100 });
    const { markets, relations, decisions } = fixtures(20);
    const first = canary.apply(markets, relations, decisions, [], [], true);
    const second = canary.apply(markets, relations, decisions, [], [], true);
    expect(second.relations.map((item) => item.leftId)).toEqual(first.relations.map((item) => item.leftId));
    expect(first.snapshot.enforcedVetoes).toBeGreaterThan(0);
    expect(first.snapshot.enforcedVetoes).toBeLessThan(20);
  });

  it("applies the full semantic veto set when canary is disabled", () => {
    const canary = service({ enabled: false });
    const { markets, relations, decisions } = fixtures(3);
    const result = canary.apply(markets, relations, decisions, [], [], true);
    expect(result.relations).toHaveLength(0);
    expect(result.snapshot.enabled).toBe(false);
  });
});
