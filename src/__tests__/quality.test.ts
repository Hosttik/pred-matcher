import { describe, expect, it } from "vitest";
import { evaluateMatcherQuality, normalizeRelationLabel, type RelationLabel } from "../core/quality.js";
import { evaluateSettlementConsistency } from "../core/settlement.js";
import type { MarketRelation } from "../core/types.js";

function relation(
  leftId: string,
  rightId: string,
  type: MarketRelation["type"],
  direction?: MarketRelation["direction"]
): MarketRelation {
  return {
    leftId,
    rightId,
    type,
    confidence: 0.9,
    evidence: [],
    ...(direction ? { direction } : {})
  };
}

function label(
  leftId: string,
  rightId: string,
  type: RelationLabel["type"],
  direction?: RelationLabel["direction"]
): RelationLabel {
  return {
    leftId,
    rightId,
    type,
    source: "ADJUDICATED",
    labeledAt: "2026-01-01T00:00:00.000Z",
    ...(direction ? { direction } : {})
  };
}

describe("matcher quality evaluation", () => {
  it("counts exact matches, wrong relation types, missing predictions, and false arb predictions", () => {
    const predictions = [
      relation("a", "b", "EQUIVALENT"),
      relation("c", "d", "IMPLIES", "LEFT_IMPLIES_RIGHT"),
      relation("e", "f", "EQUIVALENT")
    ];
    const labels = [
      label("a", "b", "EQUIVALENT"),
      label("c", "d", "TIME_NESTED", "LEFT_IMPLIES_RIGHT"),
      label("e", "f", "NONE"),
      label("g", "h", "EQUIVALENT")
    ];

    const report = evaluateMatcherQuality(predictions, labels);
    expect(report.exactMatches).toBe(1);
    expect(report.wrongTypeOrDirection).toBe(1);
    expect(report.missingPredictions).toBe(1);
    expect(report.falseArbPredictions).toBe(2);
    expect(report.evaluatedArbPredictions).toBe(3);
    expect(report.falseArbRate).toBeCloseTo(2 / 3, 5);
    expect(report.micro.truePositive).toBe(1);
    expect(report.micro.falsePositive).toBe(2);
    expect(report.micro.falseNegative).toBe(2);
  });

  it("normalizes reversed implication labels without changing semantics", () => {
    const normalized = normalizeRelationLabel(
      label("z", "a", "IMPLIES", "LEFT_IMPLIES_RIGHT")
    );
    expect(normalized.leftId).toBe("a");
    expect(normalized.rightId).toBe("z");
    expect(normalized.direction).toBe("RIGHT_IMPLIES_LEFT");

    const report = evaluateMatcherQuality([
      relation("a", "z", "IMPLIES", "RIGHT_IMPLIES_LEFT")
    ], [normalized]);
    expect(report.exactMatches).toBe(1);
  });
});

describe("settlement consistency", () => {
  it("flags only logically violating implication outcomes", () => {
    const relations = [
      relation("a", "b", "IMPLIES", "LEFT_IMPLIES_RIGHT"),
      relation("c", "d", "EQUIVALENT")
    ];
    const report = evaluateSettlementConsistency(relations, [
      { marketId: "a", outcome: "YES", resolvedAt: "2026-01-01T00:00:00Z" },
      { marketId: "b", outcome: "NO", resolvedAt: "2026-01-01T00:00:00Z" },
      { marketId: "c", outcome: "NO", resolvedAt: "2026-01-01T00:00:00Z" },
      { marketId: "d", outcome: "NO", resolvedAt: "2026-01-01T00:00:00Z" }
    ]);
    expect(report.violated).toBe(1);
    expect(report.consistent).toBe(1);
    expect(report.inconclusive).toBe(0);
  });
});
