import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPESAFE_MODEL,
  TYPESAFE_SEMANTIC_PROMPT_VERSION,
  TypeSafeSemanticVerifier
} from "../adapters/typesafe-semantic-verifier.js";
import type { NormalizedMarket } from "../core/types.js";

function market(id: string, venue: "polymarket" | "kalshi", title: string): NormalizedMarket {
  return {
    id: venue + ":" + id,
    venue,
    externalId: id,
    title,
    rules: "Resolves YES if the stated condition is satisfied by the deadline.",
    prices: { yesAsk: 0.42 },
    books: {
      YES: { asks: [{ price: 0.42, size: 100 }], capturedAt: "2026-09-18T12:00:00Z" }
    }
  };
}

function answers(values: {
  sameEvent: number;
  equivalent: number;
  leftImpliesRight: number;
  rightImpliesLeft: number;
  thresholdNested: number;
  timeNested: number;
  materialDifference: number;
}): Record<string, unknown> {
  return {
    p0_same_event: { type: "noul", noul: values.sameEvent },
    p0_equivalent: { type: "noul", noul: values.equivalent },
    p0_left_implies_right: { type: "noul", noul: values.leftImpliesRight },
    p0_right_implies_left: { type: "noul", noul: values.rightImpliesLeft },
    p0_threshold_nested: { type: "noul", noul: values.thresholdNested },
    p0_time_nested: { type: "noul", noul: values.timeNested },
    p0_material_difference: { type: "noul", noul: values.materialDifference }
  };
}

describe("TypeSafeSemanticVerifier", () => {
  it("maps atomic Jev judgments into an equivalent relation without leaking prices", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: answers({
          sameEvent: 0.99,
          equivalent: 0.94,
          leftImpliesRight: 0.96,
          rightImpliesLeft: 0.95,
          thresholdNested: 0.08,
          timeNested: 0.04,
          materialDifference: 0.02
        }),
        usage: { input_tokens: 1000, output_tokens: 50 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const verifier = new TypeSafeSemanticVerifier({
      apiKey: "test-key",
      model: "jev-1.13.0",
      fetchImpl,
      maxRetries: 0
    });
    const left = market("p1", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?");
    const right = market("k1", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?");
    const result = await verifier.verifyDetailed([{ pairKey: "pair-1", left, right }]);

    expect(result.decisions[0]).toMatchObject({
      pairKey: "pair-1",
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      confidence: 0.94
    });
    expect(result.usage).toMatchObject({
      requests: 1,
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      estimatedCostUsd: 0.000042,
      pricingSnapshot: "2026-09-15"
    });
    expect(verifier.provider).toBe("typesafe");
    expect(verifier.model).toBe("jev-1.13.0");
    expect(verifier.promptVersion).toBe(TYPESAFE_SEMANTIC_PROMPT_VERSION);
    expect(DEFAULT_TYPESAFE_MODEL).toBe("jev-1.13.0");
    expect(authorization).toBe("Bearer test-key");
    expect(requestBody?.model).toBe("jev-1.13.0");
    const serializedState = JSON.stringify(requestBody?.state);
    expect(serializedState).not.toContain('"prices"');
    expect(serializedState).not.toContain('"books"');
    expect(Object.keys(requestBody?.questions as Record<string, unknown>)).toHaveLength(7);
  });

  it("classifies a one-way numeric implication as threshold nested", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: answers({
        sameEvent: 0.99,
        equivalent: 0.12,
        leftImpliesRight: 0.97,
        rightImpliesLeft: 0.08,
        thresholdNested: 0.96,
        timeNested: 0.09,
        materialDifference: 0.01
      }),
      usage: { input_tokens: 400, output_tokens: 20 }
    }), { status: 200 })) as typeof fetch;
    const verifier = new TypeSafeSemanticVerifier({ apiKey: "key", fetchImpl, maxRetries: 0 });
    const left = market("p1", "polymarket", "Will Bitcoin be above $160,000 on December 31, 2026?");
    const right = market("k1", "kalshi", "Will Bitcoin be above $150,000 on December 31, 2026?");

    const [decision] = await verifier.verify([{ pairKey: "pair-2", left, right }]);
    expect(decision).toMatchObject({
      type: "THRESHOLD_NESTED",
      direction: "LEFT_IMPLIES_RIGHT",
      confidence: 0.96
    });
  });

  it("downgrades an otherwise equivalent-looking pair when settlement differences are material", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: answers({
        sameEvent: 0.98,
        equivalent: 0.95,
        leftImpliesRight: 0.94,
        rightImpliesLeft: 0.94,
        thresholdNested: 0.04,
        timeNested: 0.03,
        materialDifference: 0.82
      }),
      usage: { input_tokens: 400, output_tokens: 20 }
    }), { status: 200 })) as typeof fetch;
    const verifier = new TypeSafeSemanticVerifier({ apiKey: "key", fetchImpl, maxRetries: 0 });
    const left = market("p1", "polymarket", "Will candidate X win?");
    const right = market("k1", "kalshi", "Will candidate X win?");

    const [decision] = await verifier.verify([{ pairKey: "pair-3", left, right }]);
    expect(decision?.type).toBe("SIMILAR");
    expect(decision?.materialDifferences[0]).toContain("jev_material_contract_difference_probability");
  });

  it("retries TypeSafe 429 responses before succeeding", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ detail: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "0" }
        });
      }
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: answers({
          sameEvent: 0.1,
          equivalent: 0.01,
          leftImpliesRight: 0.02,
          rightImpliesLeft: 0.02,
          thresholdNested: 0.01,
          timeNested: 0.01,
          materialDifference: 0.1
        }),
        usage: { input_tokens: 100, output_tokens: 5 }
      }), { status: 200 });
    }) as typeof fetch;
    const verifier = new TypeSafeSemanticVerifier({
      apiKey: "key",
      fetchImpl,
      maxRetries: 1,
      retryBaseMs: 0
    });
    const left = market("p1", "polymarket", "Will Bitcoin reach $200k?");
    const right = market("k1", "kalshi", "Will it rain in Paris?");

    const [decision] = await verifier.verify([{ pairKey: "pair-4", left, right }]);
    expect(calls).toBe(2);
    expect(decision?.type).toBe("NONE");
  });
});
