import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QualityRepository } from "../service/quality-repository.js";

describe("QualityRepository", () => {
  it("persists labels, settlements, and shadow observations across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "pred-matcher-quality-"));
    const path = join(dir, "quality.sqlite");
    try {
      const first = new QualityRepository(path);
      first.upsertLabel({
        leftId: "z",
        rightId: "a",
        type: "IMPLIES",
        direction: "LEFT_IMPLIES_RIGHT",
        source: "ADJUDICATED",
        labeledAt: "2026-01-01T00:00:00Z"
      });
      first.upsertSettlement({
        marketId: "a",
        outcome: "YES",
        resolvedAt: "2026-01-02T00:00:00Z"
      });
      first.upsertShadowRun({
        runId: "run-1",
        status: "COMPLETED",
        provider: "fixture",
        model: "fixture-model",
        startedAt: "2026-01-03T00:00:00Z",
        completedAt: "2026-01-03T00:00:01Z",
        retrievedPairs: 1,
        selectedPairs: 1,
        verifiedPairs: 1,
        labeledPairs: 1,
        disagreements: 0
      });
      first.appendShadowVerifications([{
        runId: "run-1",
        provider: "fixture",
        model: "fixture-model",
        observedAt: "2026-01-03T00:00:01Z",
        pairKey: "[\"a\",\"z\"]",
        leftId: "a",
        rightId: "z",
        type: "IMPLIES",
        direction: "RIGHT_IMPLIES_LEFT",
        confidence: 0.91,
        evidence: ["fixture"],
        materialDifferences: [],
        heuristicType: "IMPLIES",
        heuristicConfidence: 0.9,
        heuristicDirection: "RIGHT_IMPLIES_LEFT"
      }]);
      first.close();

      const second = new QualityRepository(path);
      const labels = second.listLabels();
      expect(labels).toHaveLength(1);
      expect(labels[0]?.leftId).toBe("a");
      expect(labels[0]?.rightId).toBe("z");
      expect(labels[0]?.direction).toBe("RIGHT_IMPLIES_LEFT");
      expect(second.listSettlements()).toEqual([
        { marketId: "a", outcome: "YES", resolvedAt: "2026-01-02T00:00:00Z" }
      ]);
      expect(second.listShadowRuns()).toHaveLength(1);
      expect(second.listShadowVerifications({ runId: "run-1" })[0]?.type).toBe("IMPLIES");
      expect(second.status()).toMatchObject({
        healthy: true,
        schemaVersion: 2,
        shadowRuns: 1,
        shadowVerifications: 1
      });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
