import { describe, expect, it } from "vitest";
import { findOpportunities } from "../core/opportunities.js";
import type { MarketRelation, NormalizedMarket, OutcomeSide } from "../core/types.js";
import { MemoryStore } from "../service/store.js";

function market(
  id: string,
  venue: "polymarket" | "kalshi",
  side: OutcomeSide,
  ask: number
): NormalizedMarket {
  const capturedAt = new Date().toISOString();
  const fee = venue === "polymarket"
    ? { enabled: false, model: "POLYMARKET_CURVE" as const, rate: 0 }
    : { enabled: false, model: "KALSHI_QUADRATIC" as const, multiplier: 0 };
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
    fee
  };
}

function withAsk(market: NormalizedMarket, side: OutcomeSide, ask: number): NormalizedMarket {
  const capturedAt = new Date().toISOString();
  return {
    ...market,
    prices: side === "YES"
      ? { ...market.prices, yesAsk: ask, yesAskSize: 100 }
      : { ...market.prices, noAsk: ask, noAskSize: 100 },
    books: {
      ...market.books,
      [side]: {
        asks: [{ price: ask, size: 100 }],
        bids: [],
        capturedAt
      }
    }
  };
}

describe("MemoryStore incremental updates", () => {
  it("closes and reopens only opportunities affected by the updated market", () => {
    const left = market("left", "polymarket", "YES", 0.4);
    const right = market("right", "kalshi", "NO", 0.5);
    const unrelated = market("other", "kalshi", "YES", 0.3);
    const relation: MarketRelation = {
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      confidence: 0.99,
      evidence: []
    };
    const initial = findOpportunities([left, right, unrelated], [relation], { includeStale: true });
    expect(initial).toHaveLength(1);

    const store = new MemoryStore();
    store.replace([left, right, unrelated], [relation], initial, {
      fetched: { polymarket: 1, kalshi: 2 },
      totalMarkets: 3,
      candidatePairs: 1,
      relations: 1,
      opportunities: 1,
      syncedAt: new Date().toISOString()
    });

    const closed = store.applyMarketUpdate(withAsk(left, "YES", 0.55));
    expect(closed.affectedRelations).toBe(1);
    expect(closed.opportunities).toHaveLength(0);
    expect(closed.history.map((event) => event.kind)).toEqual(["CLOSE"]);
    expect(store.listOpportunities()).toHaveLength(0);

    const reopened = store.applyMarketUpdate(withAsk(left, "YES", 0.4));
    expect(reopened.affectedRelations).toBe(1);
    expect(reopened.opportunities).toHaveLength(1);
    expect(reopened.history.map((event) => event.kind)).toEqual(["OPEN"]);
    expect(store.listHistory(10).map((event) => event.kind)).toEqual(["OPEN", "CLOSE"]);

    expect(store.getMarket(unrelated.id)).toEqual(unrelated);
  });
});
