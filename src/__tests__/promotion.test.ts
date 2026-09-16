import { describe, expect, it } from "vitest";
import { evaluateSemanticPromotion, wilsonUpperBound, type SemanticPromotionPolicy } from "../core/promotion.js";
import { relationPairKey, type RelationLabel } from "../core/quality.js";
import type { SemanticVerifier, SemanticVerifierPair, ShadowVerificationObservation } from "../core/semantic-verifier.js";
import type { MarketRelation, NormalizedMarket } from "../core/types.js";
import type { PromotionGateProvider } from "../service/promotion-gate.js";
import { SemanticVetoService } from "../service/semantic-veto.js";

const POLICY: SemanticPromotionPolicy = {
  model: "fixture-model",
  promptVersion: "semantic-contract-v1",
  minimumLabeledPairs: 100,
  minimumRetainedArbPredictions: 75,
  maximumFalseArbRateUpperBound: 0.05,
  minimumArbPrecisionGain: 0.001,
  minimumMicroPrecisionDelta: 0,
  minimumRecallDelta: 0,
  minimumSemanticConfidence: 0.8,
  confidenceZ: 1.96
};

function dataset(count = 100): { labels: RelationLabel[]; observations: ShadowVerificationObservation[] } {
  const labels: RelationLabel[] = [];
  const observations: ShadowVerificationObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    const leftId = `polymarket:p${index}`;
    const rightId = `kalshi:k${index}`;
    const negative = index >= 95;
    labels.push({
      leftId,
      rightId,
      type: negative ? "NONE" : "EQUIVALENT",
      source: "ADJUDICATED",
      labeledAt: "2026-09-16T10:00:00Z"
    });
    observations.push({
      runId: "run-1",
      provider: "fixture",
      model: POLICY.model,
      promptVersion: POLICY.promptVersion,
      observedAt: `2026-09-16T11:${String(index).padStart(2, "0")}:00Z`,
      pairKey: relationPairKey(leftId, rightId),
      leftId,
      rightId,
      type: negative ? "NONE" : "EQUIVALENT",
      confidence: 0.95,
      evidence: ["fixture"],
      materialDifferences: negative ? ["material mismatch"] : [],
      heuristicType: "EQUIVALENT",
      heuristicConfidence: 0.9
    });
  }
  return { labels, observations };
}

function market(id: string, venue: "polymarket" | "kalshi"): NormalizedMarket {
  return { id: `${venue}:${id}`, venue, externalId: id, title: `Contract ${id}`, prices: {} };
}

describe("semantic promotion gate", () => {
  it("uses a Wilson upper bound instead of treating zero observed errors as zero risk", () => {
    expect(wilsonUpperBound(0, 20)).toBeGreaterThan(0.15);
    expect(wilsonUpperBound(0, 95)).toBeLessThan(0.05);
  });

  it("promotes only when veto policy improves arb precision without recall regression", () => {
    const { labels, observations } = dataset();
    const report = evaluateSemanticPromotion(observations, labels, POLICY, 1);
    expect(report.eligible).toBe(true);
    expect(report.baseline.falseArbPredictions).toBe(5);
    expect(report.candidate.falseArbPredictions).toBe(0);
    expect(report.candidate.micro.recall).toBe(report.baseline.micro.recall);
    expect(report.arbPrecisionGain).toBeGreaterThan(0);
    expect(report.falseArbRateUpperBound).toBeLessThanOrEqual(0.05);
  });

  it("rejects small samples even when no false arb is observed", () => {
    const { labels, observations } = dataset(20);
    const report = evaluateSemanticPromotion(observations, labels, POLICY, 1);
    expect(report.eligible).toBe(false);
    expect(report.reasons.some((reason) => reason.startsWith("insufficient_labeled_pairs"))).toBe(true);
    expect(report.reasons.some((reason) => reason.startsWith("false_arb_upper_bound_exceeded"))).toBe(true);
  });
});

describe("SemanticVetoService", () => {
  it("can only remove arb relations and never creates a new strong relation", async () => {
    const { labels, observations } = dataset();
    const promotion = evaluateSemanticPromotion(observations, labels, POLICY, 1);
    const gate: PromotionGateProvider = { evaluate: () => promotion };
    const verifier: SemanticVerifier = {
      provider: "fixture",
      model: POLICY.model,
      promptVersion: POLICY.promptVersion,
      async verify(pairs: readonly SemanticVerifierPair[]) {
        return pairs.map((pair, index) => ({
          pairKey: pair.pairKey,
          leftId: pair.left.id,
          rightId: pair.right.id,
          type: index === 0 ? "EQUIVALENT" as const : "SIMILAR" as const,
          confidence: 0.95,
          evidence: ["fixture"],
          materialDifferences: index === 0 ? [] : ["not equivalent"]
        }));
      }
    };
    const service = new SemanticVetoService(verifier, gate, {
      mode: "VETO_ONLY",
      batchSize: 10,
      maximumRelations: 10,
      minimumSemanticConfidence: 0.8
    });
    const markets = [
      market("p1", "polymarket"), market("k1", "kalshi"),
      market("p2", "polymarket"), market("k2", "kalshi"),
      market("p3", "polymarket"), market("k3", "kalshi")
    ];
    const relations: MarketRelation[] = [
      { leftId: "polymarket:p1", rightId: "kalshi:k1", type: "EQUIVALENT", confidence: 0.9, evidence: [] },
      { leftId: "polymarket:p2", rightId: "kalshi:k2", type: "EQUIVALENT", confidence: 0.9, evidence: [] },
      { leftId: "polymarket:p3", rightId: "kalshi:k3", type: "SIMILAR", confidence: 0.7, evidence: [] }
    ];

    const result = await service.apply(markets, relations);
    expect(result?.checkedRelations).toBe(2);
    expect(result?.confirmedRelations).toBe(1);
    expect(result?.vetoedRelations).toBe(1);
    expect(result?.relations.map((relation) => relation.type)).toEqual(["EQUIVALENT", "SIMILAR"]);
    expect(result?.relations.some((relation) => relation.leftId === "polymarket:p2")).toBe(false);
  });
});
