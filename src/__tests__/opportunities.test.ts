import { describe, expect, it } from "vitest";
import { findOpportunities } from "../core/opportunities.js";
import type {
  MarketFee,
  MarketRelation,
  NormalizedMarket,
  OrderBookLevel,
  OutcomeSide,
  Venue
} from "../core/types.js";

const NOW = Date.parse("2026-09-15T16:00:00.000Z");
const FRESH = "2026-09-15T15:59:59.000Z";

function freeFee(venue: Venue): MarketFee {
  return venue === "polymarket"
    ? { enabled: false, model: "POLYMARKET_CURVE", rate: 0, source: "clob" }
    : { enabled: false, model: "KALSHI_QUADRATIC", multiplier: 0, rate: 0.07, source: "series" };
}

function market(
  id: string,
  venue: Venue,
  books: Partial<Record<OutcomeSide, OrderBookLevel[]>>,
  fee: MarketFee = freeFee(venue),
  capturedAt = FRESH
): NormalizedMarket {
  const normalizedBooks: NormalizedMarket["books"] = {};
  for (const side of ["YES", "NO"] as const) {
    const asks = books[side];
    if (asks) normalizedBooks[side] = { asks, capturedAt };
  }
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title: `Market ${id}`,
    prices: {},
    books: normalizedBooks,
    fee
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
  it("walks full depth and reports the maximum executable size", () => {
    const opportunities = findOpportunities([
      market("left", "polymarket", {
        YES: [{ price: 0.4, size: 10 }, { price: 0.45, size: 20 }],
        NO: [{ price: 0.7, size: 30 }]
      }),
      market("right", "kalshi", {
        YES: [{ price: 0.7, size: 30 }],
        NO: [{ price: 0.5, size: 5 }, { price: 0.52, size: 25 }]
      })
    ], [relation()], { nowMs: NOW });

    expect(opportunities).toHaveLength(1);
    const opportunity = opportunities[0];
    expect(opportunity?.type).toBe("EQUIVALENT_ARB");
    expect(opportunity?.maxExecutableShares).toBe(30);
    expect(opportunity?.maxProfitableShares).toBe(30);
    expect(opportunity?.bestExecution.shares).toBe(30);
    expect(opportunity?.bestExecution.netProfit).toBe(1.5);
    expect(opportunity?.bestExecution.legs[0].vwap).toBeCloseTo(13 / 30, 4);
    expect(opportunity?.fees.status).toBe("INCLUDED");
  });

  it("uses NO(A) + YES(B) when A implies B", () => {
    const opportunities = findOpportunities([
      market("left", "polymarket", { NO: [{ price: 0.25, size: 50 }] }),
      market("right", "kalshi", { YES: [{ price: 0.7, size: 40 }] })
    ], [relation({ type: "IMPLIES", direction: "LEFT_IMPLIES_RIGHT" })], { nowMs: NOW });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.type).toBe("IMPLICATION_ARB");
    expect(opportunities[0]?.legs.map((leg) => leg.side)).toEqual(["NO", "YES"]);
    expect(opportunities[0]?.maxExecutableShares).toBe(40);
  });

  it("ignores similar relations because they do not guarantee settlement equivalence", () => {
    const opportunities = findOpportunities([
      market("left", "polymarket", { YES: [{ price: 0.2, size: 10 }] }),
      market("right", "kalshi", { NO: [{ price: 0.2, size: 10 }] })
    ], [relation({ type: "SIMILAR" })], { nowMs: NOW });

    expect(opportunities).toEqual([]);
  });

  it("rejects a gross edge that becomes negative after taker fees", () => {
    const polymarketFee: MarketFee = {
      enabled: true,
      model: "POLYMARKET_CURVE",
      rate: 0.07,
      takerOnly: true,
      source: "clob"
    };
    const kalshiFee: MarketFee = {
      enabled: true,
      model: "KALSHI_QUADRATIC",
      rate: 0.07,
      multiplier: 1,
      takerOnly: true,
      source: "series"
    };
    const opportunities = findOpportunities([
      market("left", "polymarket", { YES: [{ price: 0.49, size: 100 }] }, polymarketFee),
      market("right", "kalshi", { NO: [{ price: 0.49, size: 100 }] }, kalshiFee)
    ], [relation()], { nowMs: NOW });

    expect(opportunities).toEqual([]);
  });

  it("evaluates a requested size and rejects it when deeper slippage removes the edge", () => {
    const markets = [
      market("left", "polymarket", {
        YES: [{ price: 0.45, size: 10 }, { price: 0.6, size: 90 }]
      }),
      market("right", "kalshi", {
        NO: [{ price: 0.45, size: 100 }]
      })
    ];

    expect(findOpportunities(markets, [relation()], { nowMs: NOW })).toHaveLength(1);
    expect(findOpportunities(markets, [relation()], { nowMs: NOW, targetShares: 50 })).toHaveLength(0);
  });

  it("drops stale quotes by default but can expose them explicitly", () => {
    const stale = "2026-09-15T15:59:40.000Z";
    const markets = [
      market("left", "polymarket", { YES: [{ price: 0.4, size: 10 }] }, freeFee("polymarket"), stale),
      market("right", "kalshi", { NO: [{ price: 0.5, size: 10 }] }, freeFee("kalshi"), stale)
    ];

    expect(findOpportunities(markets, [relation()], { nowMs: NOW })).toEqual([]);
    const included = findOpportunities(markets, [relation()], { nowMs: NOW, includeStale: true });
    expect(included).toHaveLength(1);
    expect(included[0]?.isStale).toBe(true);
    expect(included[0]?.quoteAgeMs).toBe(20_000);
  });
});
