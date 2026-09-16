import { describe, expect, it } from "vitest";
import { replayHistoricalFrames } from "../core/replay.js";
import type { MarketRelation, NormalizedMarket, OutcomeSide } from "../core/types.js";

function market(
  id: string,
  venue: "polymarket" | "kalshi",
  side: OutcomeSide,
  ask: number,
  capturedAt: string
): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title: `Market ${id}`,
    prices: side === "YES" ? { yesAsk: ask } : { noAsk: ask },
    books: {
      [side]: {
        asks: [{ price: ask, size: 100 }],
        bids: [],
        capturedAt
      }
    },
    fee: venue === "polymarket"
      ? { enabled: false, model: "POLYMARKET_CURVE", rate: 0 }
      : { enabled: false, model: "KALSHI_QUADRATIC", multiplier: 0 }
  };
}

describe("historical replay", () => {
  it("tracks repeated opportunity sessions and lifetime peaks", () => {
    const relation: MarketRelation = {
      leftId: "polymarket:left",
      rightId: "kalshi:right",
      type: "EQUIVALENT",
      confidence: 0.99,
      evidence: []
    };
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-01T00:01:00.000Z";
    const t3 = "2026-01-01T00:02:00.000Z";
    const report = replayHistoricalFrames([
      { capturedAt: t1, markets: [market("left", "polymarket", "YES", 0.4, t1), market("right", "kalshi", "NO", 0.5, t1)] },
      { capturedAt: t2, markets: [market("left", "polymarket", "YES", 0.55, t2), market("right", "kalshi", "NO", 0.5, t2)] },
      { capturedAt: t3, markets: [market("left", "polymarket", "YES", 0.35, t3), market("right", "kalshi", "NO", 0.5, t3)] }
    ], [relation], { mode: "FIXED_RELATIONS" });

    expect(report.frames).toBe(3);
    expect(report.uniqueOpportunities).toBe(1);
    expect(report.opens).toBe(2);
    expect(report.closes).toBe(1);
    expect(report.lifetimes[0]?.openCount).toBe(2);
    expect(report.lifetimes[0]?.peakNetEdgePerShare).toBeCloseTo(0.15, 6);
    expect(report.lifetimes[0]?.sessions[0]?.closedAt).toBe(t2);
    expect(report.lifetimes[0]?.sessions[1]?.closedAt).toBeUndefined();
  });
});
