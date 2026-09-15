import { describe, expect, it } from "vitest";
import { findOpportunities } from "../core/opportunities.js";
import type { MarketRelation, NormalizedMarket } from "../core/types.js";

function market(
  id: string,
  venue: "polymarket" | "kalshi",
  prices: NormalizedMarket["prices"]
): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title: `Market ${id}`,
    prices
  };
}

function relation(overrides: Partial<MarketRelation> = {}): MarketRelation {
  return {
    leftId: "polymarket:left",
    rightId: "kalshi:right",
    type: "EQUIVALENT",
    confidence: 0.95,
    evidence: [],
    ...overrides
  };
}

describe("findOpportunities", () => {
  it("finds an equivalent-market gross arb and caps it by top-of-book size", () => {
    const opportunities = findOpportunities([
      market("left", "polymarket", {
        yesAsk: 0.43,
        yesAskSize: 100,
        noAsk: 0.58,
        noAskSize: 100
      }),
      market("right", "kalshi", {
        yesAsk: 0.45,
        yesAskSize: 70,
        noAsk: 0.52,
        noAskSize: 80
      })
    ], [relation()]);

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.type).toBe("EQUIVALENT_ARB");
    expect(opportunities[0]?.grossCostPerShare).toBe(0.95);
    expect(opportunities[0]?.grossEdgePerShare).toBe(0.05);
    expect(opportunities[0]?.maxShares).toBe(80);
    expect(opportunities[0]?.grossProfitAtTop).toBe(4);
    expect(opportunities[0]?.legs.map((leg) => leg.side)).toEqual(["YES", "NO"]);
    expect(opportunities[0]?.fees.status).toBe("NOT_INCLUDED");
  });

  it("uses NO(A) + YES(B) when A implies B", () => {
    const opportunities = findOpportunities([
      market("left", "polymarket", {
        noAsk: 0.25,
        noAskSize: 50
      }),
      market("right", "kalshi", {
        yesAsk: 0.7,
        yesAskSize: 40
      })
    ], [relation({
      type: "IMPLIES",
      direction: "LEFT_IMPLIES_RIGHT"
    })]);

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.type).toBe("IMPLICATION_ARB");
    expect(opportunities[0]?.grossCostPerShare).toBe(0.95);
    expect(opportunities[0]?.grossEdgePerShare).toBe(0.05);
    expect(opportunities[0]?.maxShares).toBe(40);
    expect(opportunities[0]?.legs.map((leg) => leg.side)).toEqual(["NO", "YES"]);
  });

  it("ignores similar relations because they do not guarantee settlement equivalence", () => {
    const opportunities = findOpportunities([
      market("left", "polymarket", { yesAsk: 0.2, noAsk: 0.8 }),
      market("right", "kalshi", { yesAsk: 0.2, noAsk: 0.2 })
    ], [relation({ type: "SIMILAR" })]);

    expect(opportunities).toEqual([]);
  });

  it("applies the minimum gross edge filter", () => {
    const markets = [
      market("left", "polymarket", { yesAsk: 0.48 }),
      market("right", "kalshi", { noAsk: 0.49 })
    ];

    expect(findOpportunities(markets, [relation()], 0.02)).toHaveLength(1);
    expect(findOpportunities(markets, [relation()], 0.04)).toHaveLength(0);
  });
});
