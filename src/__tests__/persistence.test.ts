import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOpportunities } from "../core/opportunities.js";
import type { MarketRelation, NormalizedMarket, OutcomeSide, SyncResult } from "../core/types.js";
import { SqliteStateRepository } from "../service/sqlite-state.js";
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

function withAsk(value: NormalizedMarket, side: OutcomeSide, ask: number): NormalizedMarket {
  const capturedAt = new Date().toISOString();
  return {
    ...value,
    prices: side === "YES"
      ? { ...value.prices, yesAsk: ask, yesAskSize: 100 }
      : { ...value.prices, noAsk: ask, noAskSize: 100 },
    books: {
      ...value.books,
      [side]: {
        asks: [{ price: ask, size: 100 }],
        bids: [],
        capturedAt
      }
    }
  };
}

describe("SqliteStateRepository", () => {
  it("restores catalog state, current opportunities, and history across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "pred-matcher-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const left = market("left", "polymarket", "YES", 0.4);
      const right = market("right", "kalshi", "NO", 0.5);
      const relation: MarketRelation = {
        leftId: left.id,
        rightId: right.id,
        type: "EQUIVALENT",
        confidence: 0.99,
        evidence: []
      };
      const initial = findOpportunities([left, right], [relation], { includeStale: true });
      const sync: SyncResult = {
        fetched: { polymarket: 1, kalshi: 1 },
        totalMarkets: 2,
        candidatePairs: 1,
        relations: 1,
        opportunities: initial.length,
        syncedAt: new Date().toISOString()
      };

      const firstRepository = new SqliteStateRepository(databasePath, 100);
      const firstStore = new MemoryStore(100, firstRepository);
      firstStore.replace([left, right], [relation], initial, sync);
      const closed = firstStore.applyMarketUpdate(withAsk(left, "YES", 0.55));
      expect(closed.history.map((event) => event.kind)).toEqual(["CLOSE"]);
      const closedSequence = closed.history[0]?.sequence ?? 0;
      firstStore.close();

      const secondRepository = new SqliteStateRepository(databasePath, 100);
      const secondStore = new MemoryStore(100, secondRepository);
      expect(secondStore.listMarkets()).toHaveLength(2);
      expect(secondStore.listRelations()).toEqual([relation]);
      expect(secondStore.listOpportunities()).toHaveLength(0);
      expect(secondStore.getLastSync()).toEqual(sync);
      expect(secondStore.listHistory(10).map((event) => event.kind)).toEqual(["CLOSE"]);
      expect(secondStore.getPersistenceStatus().restoredAt).toBeDefined();

      const reopened = secondStore.applyMarketUpdate(withAsk(left, "YES", 0.4));
      expect(reopened.opportunities).toHaveLength(1);
      expect(reopened.history[0]?.kind).toBe("OPEN");
      expect(reopened.history[0]?.sequence).toBeGreaterThan(closedSequence);
      secondStore.close();

      const thirdRepository = new SqliteStateRepository(databasePath, 100);
      const thirdStore = new MemoryStore(100, thirdRepository);
      expect(thirdStore.listOpportunities()).toHaveLength(1);
      expect(thirdStore.listHistory(10).map((event) => event.kind)).toEqual(["OPEN", "CLOSE"]);
      thirdStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
