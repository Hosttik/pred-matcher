import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewCandidates } from "../core/dataset.js";
import { replayHistoricalFrames } from "../core/replay.js";
import type { MarketRelation, NormalizedMarket } from "../core/types.js";
import { DatasetRepository } from "../service/dataset-repository.js";

function market(
  id: string,
  venue: "polymarket" | "kalshi",
  resolutionSource: string,
  yesAsk: number,
  noAsk: number,
  capturedAt: string
): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title: "Will Bitcoin price exceed $100,000 by December 31, 2026?",
    rules: "Resolves YES if Bitcoin is above $100,000 by December 31, 2026.",
    resolutionSource,
    prices: { yesAsk, noAsk },
    books: {
      YES: { asks: [{ price: yesAsk, size: 100 }], bids: [], capturedAt },
      NO: { asks: [{ price: noAsk, size: 100 }], bids: [], capturedAt }
    },
    fee: venue === "polymarket"
      ? { enabled: false, model: "POLYMARKET_CURVE", rate: 0 }
      : { enabled: false, model: "KALSHI_QUADRATIC", multiplier: 0 }
  };
}

const relation: MarketRelation = {
  leftId: "polymarket:btc",
  rightId: "kalshi:btc",
  type: "EQUIVALENT",
  confidence: 0.99,
  evidence: []
};

describe("historical dataset capture", () => {
  it("creates hard-negative review candidates for settlement-source near misses", () => {
    const capturedAt = "2026-01-01T00:00:00.000Z";
    const candidates = buildReviewCandidates([
      market("btc", "polymarket", "Coinbase", 0.4, 0.6, capturedAt),
      market("btc", "kalshi", "Kraken", 0.5, 0.5, capturedAt)
    ], capturedAt);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.kind).toBe("HARD_NEGATIVE");
    expect(candidates[0]?.predictedType).toBe("SIMILAR");
  });

  it("deduplicates unchanged market versions and reconstructs captured frames", () => {
    const directory = mkdtempSync(join(tmpdir(), "pred-matcher-dataset-"));
    const path = join(directory, "dataset.sqlite");
    const capturedAt = "2026-01-01T00:00:00.000Z";
    const markets = [
      market("btc", "polymarket", "Coinbase", 0.4, 0.6, capturedAt),
      market("btc", "kalshi", "Coinbase", 0.5, 0.5, capturedAt)
    ];

    try {
      const repository = new DatasetRepository(path, 10);
      const first = repository.capture(markets, [relation], "MANUAL", capturedAt);
      repository.capture(markets, [relation], "SCHEDULED", "2026-01-01T00:05:00.000Z");

      const status = repository.status();
      expect(status.snapshots).toBe(2);
      expect(status.marketVersions).toBe(2);
      expect(status.relationVersions).toBe(1);

      const frame = repository.loadFrame(first.id);
      expect(frame?.markets).toHaveLength(2);
      expect(frame?.relations).toEqual([relation]);
      repository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays the relation graph captured with each frame", () => {
    const capturedAt = "2026-01-01T00:00:00.000Z";
    const markets = [
      market("btc", "polymarket", "Coinbase", 0.4, 0.6, capturedAt),
      market("btc", "kalshi", "Coinbase", 0.5, 0.5, capturedAt)
    ];
    const report = replayHistoricalFrames([
      { capturedAt, markets, relations: [relation] }
    ], [], { mode: "CAPTURED_RELATIONS" });

    expect(report.mode).toBe("CAPTURED_RELATIONS");
    expect(report.relationObservations).toBe(1);
    expect(report.opportunityObservations).toBe(1);
  });
});
