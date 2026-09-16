import { describe, expect, it } from "vitest";
import type { SemanticVerifier, SemanticVerifierPair } from "../core/semantic-verifier.js";
import type { NormalizedMarket } from "../core/types.js";
import { DatasetRepository } from "../service/dataset-repository.js";
import { QualityRepository } from "../service/quality-repository.js";
import { ShadowExperimentRunner } from "../service/shadow-experiment.js";

function market(id: string, venue: "polymarket" | "kalshi", title: string): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title,
    rules: "Resolves YES if the stated condition is satisfied by the deadline.",
    prices: {}
  };
}

function fake(model: string, type: "EQUIVALENT" | "SIMILAR"): SemanticVerifier {
  return {
    provider: "fixture",
    model,
    promptVersion: "fixture-v1",
    async verify(pairs: readonly SemanticVerifierPair[]) {
      return pairs.map((pair) => ({
        pairKey: pair.pairKey,
        leftId: pair.left.id,
        rightId: pair.right.id,
        type,
        confidence: type === "EQUIVALENT" ? 0.95 : 0.75,
        evidence: [model],
        materialDifferences: type === "SIMILAR" ? ["fixture difference"] : []
      }));
    }
  };
}

describe("ShadowExperimentRunner", () => {
  it("runs the same historical pair across models and creates disagreement review", async () => {
    const left = market("p1", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?");
    const right = market("k1", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?");
    const dataset = new DatasetRepository(":memory:", 10);
    const quality = new QualityRepository(":memory:");
    dataset.capture([left, right], [], "MANUAL", "2026-09-16T10:00:00Z");
    quality.upsertLabel({
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      source: "ADJUDICATED",
      labeledAt: "2026-09-16T10:00:00Z"
    });

    const runner = new ShadowExperimentRunner(dataset, quality, [
      fake("fixture-a", "EQUIVALENT"),
      fake("fixture-b", "SIMILAR")
    ]);
    const experiment = await runner.runHistorical({
      snapshotLimit: 5,
      maxPairs: 10,
      batchSize: 5,
      minimumCandidateScore: 0.2
    });

    expect(experiment.status).toBe("COMPLETED");
    expect(experiment.snapshots).toBe(1);
    expect(experiment.uniquePairs).toBe(1);
    expect(experiment.runIds).toHaveLength(2);
    expect(experiment.comparisons).toEqual([{
      leftModel: "fixture-a",
      rightModel: "fixture-b",
      comparedPairs: 1,
      disagreements: 1,
      agreementRate: 0
    }]);
    expect(experiment.reviewCandidates).toBe(1);
    const review = quality.listShadowReviewCandidates({ experimentId: experiment.experimentId });
    expect(review).toHaveLength(1);
    expect(review[0]?.reason).toBe("GOLD_LABEL_DISAGREEMENT");
    expect(quality.getShadowExperiment(experiment.experimentId)?.status).toBe("COMPLETED");
    expect(quality.status().shadowExperiments).toBe(1);

    dataset.close();
    quality.close();
  });
});
