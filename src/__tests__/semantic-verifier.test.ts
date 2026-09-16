import { describe, expect, it } from "vitest";
import { OpenAISemanticVerifier } from "../adapters/openai-semantic-verifier.js";
import { matchMarkets } from "../core/matcher.js";
import type { SemanticVerifier, SemanticVerifierPair } from "../core/semantic-verifier.js";
import type { NormalizedMarket } from "../core/types.js";
import { QualityRepository } from "../service/quality-repository.js";
import { ShadowVerifierService } from "../service/shadow-verifier.js";
import { MemoryStore } from "../service/store.js";

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

describe("OpenAISemanticVerifier", () => {
  it("uses structured outputs, excludes prices, and records usage/cost", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: "completed",
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
          output_tokens: 100,
          total_tokens: 1100
        },
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              decisions: [{
                pairKey: "pair-1",
                leftId: "polymarket:p1",
                rightId: "kalshi:k1",
                type: "EQUIVALENT",
                direction: "NONE",
                confidence: 0.93,
                evidence: ["same threshold and deadline"],
                materialDifferences: []
              }]
            })
          }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const verifier = new OpenAISemanticVerifier({ apiKey: "test-key", model: "gpt-5.6-luna", fetchImpl });
    const left = market("p1", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?");
    const right = market("k1", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?");
    const result = await verifier.verifyDetailed([{ pairKey: "pair-1", left, right }]);

    expect(result.decisions).toEqual([{
      pairKey: "pair-1",
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      confidence: 0.93,
      evidence: ["same threshold and deadline"],
      materialDifferences: []
    }]);
    expect(result.usage).toMatchObject({
      requests: 1,
      inputTokens: 1000,
      cachedInputTokens: 200,
      cacheWriteTokens: 100,
      outputTokens: 100,
      totalTokens: 1100,
      estimatedCostUsd: 0.000289,
      pricingSnapshot: "2026-09-16"
    });
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(verifier.promptVersion).toBe("semantic-contract-v1");
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.model).toBe("gpt-5.6-luna");
    const text = requestBody?.text as { format?: { type?: string; strict?: boolean } } | undefined;
    expect(text?.format?.type).toBe("json_schema");
    expect(text?.format?.strict).toBe(true);
    const input = requestBody?.input as Array<{ role?: string; content?: string }> | undefined;
    const userPayload = input?.find((item) => item.role === "user")?.content ?? "";
    expect(userPayload).not.toContain('"prices"');
    expect(userPayload).not.toContain('"books"');
  });
});

describe("ShadowVerifierService", () => {
  it("records disagreement without mutating the production relation graph", async () => {
    const left = market("p1", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?");
    const right = market("k1", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?");
    const matched = matchMarkets([left, right], 0.2);
    expect(matched.relations[0]?.type).toBe("EQUIVALENT");

    const store = new MemoryStore();
    store.replace([left, right], matched.relations, [], {
      fetched: { polymarket: 1, kalshi: 1 },
      totalMarkets: 2,
      candidatePairs: matched.candidatePairs,
      relations: matched.relations.length,
      opportunities: 0,
      syncedAt: "2026-09-16T16:00:00Z"
    });
    const repository = new QualityRepository(":memory:");
    repository.upsertLabel({
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      source: "ADJUDICATED",
      labeledAt: "2026-09-16T16:00:00Z"
    });

    const fake: SemanticVerifier = {
      provider: "fake",
      model: "fixture",
      promptVersion: "fixture-v1",
      async verify(pairs: readonly SemanticVerifierPair[]) {
        return pairs.map((pair) => ({
          pairKey: pair.pairKey,
          leftId: pair.left.id,
          rightId: pair.right.id,
          type: "SIMILAR" as const,
          confidence: 0.7,
          evidence: ["fixture disagreement"],
          materialDifferences: ["resolution mechanism unknown"]
        }));
      }
    };

    const service = new ShadowVerifierService(store, repository, fake, {
      enabled: true, autoRun: false, minimumCandidateScore: 0.2, maxPairs: 10, batchSize: 5
    });
    const before = store.listRelations();
    const run = await service.run();

    expect(run.status).toBe("COMPLETED");
    expect(run.source).toBe("LIVE");
    expect(run.promptVersion).toBe("fixture-v1");
    expect(run.verifiedPairs).toBe(1);
    expect(run.labeledPairs).toBe(1);
    expect(run.disagreements).toBe(1);
    expect(run.heuristicReport?.exactMatches).toBe(1);
    expect(run.shadowReport?.wrongTypeOrDirection).toBe(1);
    expect(run.usage?.requests).toBe(1);
    expect(run.usage?.estimatedCostUsd).toBeNull();
    expect(store.listRelations()).toEqual(before);
    expect(repository.listShadowVerifications({ runId: run.runId })).toHaveLength(1);
    expect(repository.status().shadowRuns).toBe(1);
    repository.close();
  });
});
