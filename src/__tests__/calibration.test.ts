import { describe, expect, it } from "vitest";
import { calibrateMatcher, compareQualityRegression } from "../core/calibration.js";
import { evaluateMatcherQuality, type RelationLabel } from "../core/quality.js";
import type { HistoricalDatasetFrame } from "../core/dataset.js";
import type { MarketRelation, NormalizedMarket } from "../core/types.js";

function market(id: string, venue: "polymarket" | "kalshi", title: string): NormalizedMarket {
  return { id: `${venue}:${id}`, venue, externalId: id, title, prices: {} };
}

describe("matcher calibration", () => {
  it("sweeps candidate and arb-confidence thresholds without auto-changing runtime config", () => {
    const frame: HistoricalDatasetFrame = {
      capturedAt: "2026-01-01T00:00:00.000Z",
      markets: [
        market("p", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?"),
        market("k", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?")
      ],
      relations: []
    };
    const labels: RelationLabel[] = [{
      leftId: "polymarket:p",
      rightId: "kalshi:k",
      type: "EQUIVALENT",
      source: "ADJUDICATED",
      labeledAt: "2026-01-02T00:00:00.000Z"
    }];

    const report = calibrateMatcher([frame], labels, {
      candidateScores: [0.2],
      arbConfidenceThresholds: [0, 0.99],
      policy: { maxFalseArbRate: 0, minimumMicroRecall: 1, minimumArbPredictions: 1 }
    });

    expect(report.points).toHaveLength(2);
    expect(report.points[0]?.report.micro.recall).toBe(1);
    expect(report.points[0]?.eligible).toBe(true);
    expect(report.points[1]?.report.evaluatedArbPredictions).toBe(0);
    expect(report.points[1]?.eligible).toBe(false);
    expect(report.recommended?.config.minimumArbConfidence).toBe(0);
  });

  it("fails a regression gate when a strong relation creates a false-arbitrage prediction", () => {
    const labels: RelationLabel[] = [{
      leftId: "polymarket:a",
      rightId: "kalshi:b",
      type: "NONE",
      source: "ADJUDICATED",
      labeledAt: "2026-01-02T00:00:00.000Z"
    }];
    const badPrediction: MarketRelation = {
      leftId: "polymarket:a",
      rightId: "kalshi:b",
      type: "EQUIVALENT",
      confidence: 0.99,
      evidence: []
    };
    const baseline = evaluateMatcherQuality([], labels);
    const candidate = evaluateMatcherQuality([badPrediction], labels);
    const gate = compareQualityRegression(baseline, candidate, {
      maxFalseArbRate: 0,
      maxFalseArbRateIncrease: 0,
      minimumArbPredictions: 1
    });

    expect(candidate.falseArbRate).toBe(1);
    expect(gate.pass).toBe(false);
    expect(gate.reasons.some((reason) => reason.startsWith("false_arb_rate_above_cap"))).toBe(true);
  });
});
