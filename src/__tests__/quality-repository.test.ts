import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QualityRepository } from "../service/quality-repository.js";

describe("QualityRepository", () => {
  it("persists labels and settlements across reopen", () => {
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
      expect(second.status().healthy).toBe(true);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
