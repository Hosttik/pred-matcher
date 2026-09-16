import { describe, expect, it } from "vitest";
import { evaluateSemanticPromotion, wilsonUpperBound, type SemanticPromotionPolicy } from "../core/promotion.js";
import { relationPairKey, type RelationLabel } from "../core/quality.js";
import type { SemanticVerifier, SemanticVerifierPair, ShadowVerificationObservation } from "../core/semantic-verifier.js";
import type { MarketRelation, NormalizedMarket, SemanticOpportunityImpact } from "../core/types.js";
import { MATCHER_VERSION } from "../core/version.js";
import type { PromotionGateProvider } from "../service/promotion-gate.js";
import { SemanticVetoService } from "../service/semantic-veto.js";

const NOW_MS = Date.UTC(2026, 8, 16, 12, 0, 0);
const POLICY: SemanticPromotionPolicy = {
  model: "fixture-model",
  promptVersion: "semantic-contract-v1",
  matcherVersion: MATCHER_VERSION,
  maximumEvidenceAgeMs: 24 * 60 * 60 * 1000,
  minimumLabeledPairs: 100,
  minimumRetainedArbPredictions: 75,
  maximumFalseArbRateUpperBound: 0.05,
  minimumArbPrecisionGain: 0.001,
  minimumMicroPrecisionDelta: 0,
  minimumRecallDelta: 0,
  minimumSemanticConfidence: 0.8,
  confidenceZ: 1.96
};

function dataset(count = 100, observedAtMs = Date.UTC(2026, 8, 16, 11, 0, 0)): {
  labels: RelationLabel[];
  observations: ShadowVerificationObservation[];
} {
  const labels: RelationLabel[] = [];
  const observations: ShadowVerificationObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    const leftId = `polymarket:p${index}`;
    const rightId = `kalshi:k${index}`;
    const negative = index >= Math.max(0, count - 5);
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
      matcherVersion: MATCHER_VERSION,
      observedAt: new Date(observedAtMs + index * 1000).toISOString(),
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

function relationFixtures(): { markets: NormalizedMarket[]; relations: MarketRelation[] } {
  return {
    markets: [
      market("p1", "polymarket"), market("k1", "kalshi"),
      market("p2", "polymarket"), market("k2", "kalshi"),
      market("p3", "polymarket"), market("k3", "kalshi")
    ],
    relations: [
      { leftId: "polymarket:p1", rightId: "kalshi:k1", type: "EQUIVALENT", confidence: 0.9, evidence: [] },
      { leftId: "polymarket:p2", rightId: "kalshi:k2", type: "EQUIVALENT", confidence: 0.9, evidence: [] },
      { leftId: "polymarket:p3", rightId: "kalshi:k3", type: "SIMILAR", confidence: 0.7, evidence: [] }
    ]
  };
}

function impact(retention = 0.5): SemanticOpportunityImpact {
  return {
    baselineOpportunities: 2,
    candidateOpportunities: retention === 1 ? 2 : 1,
    suppressedOpportunities: retention === 1 ? 0 : 1,
    introducedOpportunities: 0,
    opportunityRetentionRate: retention,
    suppressedNetProfit: retention === 1 ? 0 : 1.25,
    maximumSuppressedNetEdgePerShare: retention === 1 ? null : 0.03
  };
}

function verifier(): SemanticVerifier {
  return {
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
}

function options(mode: "DRY_RUN" | "ENFORCED", maximumVetoRate = 1, minimumOpportunityRetentionRate = 0): ConstructorParameters<typeof SemanticVetoService>[2] {
  return {
    mode,
    batchSize: 10,
    maximumRelations: 10,
    minimumSemanticConfidence: 0.8,
    maximumVetoRate,
    minimumOpportunityRetentionRate
  };
}

describe("semantic promotion gate", () => {
  it("uses a Wilson upper bound instead of treating zero observed errors as zero risk", () => {
    expect(wilsonUpperBound(0, 20)).toBeGreaterThan(0.15);
    expect(wilsonUpperBound(0, 95)).toBeLessThan(0.05);
  });

  it("promotes only when veto policy improves arb precision without recall regression", () => {
    const { labels, observations } = dataset();
    const report = evaluateSemanticPromotion(observations, labels, POLICY, 1, NOW_MS);
    expect(report.eligible).toBe(true);
    expect(report.matcherVersion).toBe(MATCHER_VERSION);
    expect(report.baseline.falseArbPredictions).toBe(5);
    expect(report.candidate.falseArbPredictions).toBe(0);
    expect(report.candidate.micro.recall).toBe(report.baseline.micro.recall);
    expect(report.arbPrecisionGain).toBeGreaterThan(0);
    expect(report.falseArbRateUpperBound).toBeLessThanOrEqual(0.05);
  });

  it("rejects small samples even when no false arb is observed", () => {
    const { labels, observations } = dataset(20);
    const report = evaluateSemanticPromotion(observations, labels, POLICY, 1, NOW_MS);
    expect(report.eligible).toBe(false);
    expect(report.reasons.some((reason) => reason.startsWith("insufficient_labeled_pairs"))).toBe(true);
    expect(report.reasons.some((reason) => reason.startsWith("false_arb_upper_bound_exceeded"))).toBe(true);
  });

  it("expires old promotion evidence", () => {
    const { labels, observations } = dataset(100, NOW_MS - 2 * POLICY.maximumEvidenceAgeMs);
    const report = evaluateSemanticPromotion(observations, labels, POLICY, 0, NOW_MS);
    expect(report.eligible).toBe(false);
    expect(report.observations).toBe(0);
    expect(report.reasons).toContain("promotion_evidence_expired");
  });

  it("rejects observations from a different matcher version", () => {
    const { labels, observations } = dataset();
    const mismatched = observations.map((observation) => ({ ...observation, matcherVersion: "heuristic-old" }));
    const report = evaluateSemanticPromotion(mismatched, labels, POLICY, 1, NOW_MS);
    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain("no_matcher_pinned_evidence");
  });
});

describe("SemanticVetoService", () => {
  it("dry-runs a remove-only candidate graph without enforcing it", async () => {
    const { labels, observations } = dataset();
    const promotion = evaluateSemanticPromotion(observations, labels, POLICY, 1, NOW_MS);
    const gate: PromotionGateProvider = { evaluate: () => promotion };
    const service = new SemanticVetoService(verifier(), gate, options("DRY_RUN"));
    const { markets, relations } = relationFixtures();

    const evaluation = await service.evaluate(markets, relations);
    expect(evaluation?.checkedRelations).toBe(2);
    expect(evaluation?.confirmedRelations).toBe(1);
    expect(evaluation?.vetoedRelations).toBe(1);
    expect(evaluation?.proposedRelations.map((relation) => relation.type)).toEqual(["EQUIVALENT", "SIMILAR"]);
    expect(evaluation?.proposedRelations.some((relation) => relation.leftId === "polymarket:p2")).toBe(false);
    const rollout = service.finalize(evaluation!, impact(0.5));
    expect(rollout.effectiveMode).toBe("DRY_RUN");
    expect(rollout.circuitBreaker.open).toBe(false);
  });

  it("opens the circuit before calling the verifier when enforced promotion is ineligible", async () => {
    const { labels, observations } = dataset(20);
    const promotion = evaluateSemanticPromotion(observations, labels, POLICY, 1, NOW_MS);
    let calls = 0;
    const fakeVerifier: SemanticVerifier = {
      provider: "fixture",
      model: POLICY.model,
      promptVersion: POLICY.promptVersion,
      async verify() {
        calls += 1;
        return [];
      }
    };
    const service = new SemanticVetoService(fakeVerifier, { evaluate: () => promotion }, options("ENFORCED"));
    const { markets, relations } = relationFixtures();

    const evaluation = await service.evaluate(markets, relations);
    expect(calls).toBe(0);
    expect(evaluation?.proposedRelations).toEqual(relations);
    expect(service.getStatus().circuitBreaker.open).toBe(true);
    expect(service.getStatus().effectiveMode).toBe("DRY_RUN");
  });

  it("latches a circuit breaker on anomalous veto or opportunity-retention impact until reset", async () => {
    const { labels, observations } = dataset();
    const promotion = evaluateSemanticPromotion(observations, labels, POLICY, 1, NOW_MS);
    const service = new SemanticVetoService(
      verifier(),
      { evaluate: () => promotion },
      options("ENFORCED", 0.25, 0.8)
    );
    const { markets, relations } = relationFixtures();
    const evaluation = await service.evaluate(markets, relations);
    const rollout = service.finalize(evaluation!, impact(0.5));

    expect(rollout.effectiveMode).toBe("DRY_RUN");
    expect(rollout.circuitBreaker.open).toBe(true);
    expect(rollout.guardReasons.some((reason) => reason.startsWith("veto_rate_exceeded"))).toBe(true);
    expect(rollout.guardReasons.some((reason) => reason.startsWith("opportunity_retention_too_low"))).toBe(true);

    expect(service.resetCircuit().circuitBreaker.open).toBe(false);
    expect(service.getStatus().effectiveMode).toBe("ENFORCED");
  });
});
