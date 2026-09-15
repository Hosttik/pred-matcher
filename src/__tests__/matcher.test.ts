import { describe, expect, it } from "vitest";
import { matchMarkets } from "../core/matcher.js";
import type { NormalizedMarket } from "../core/types.js";

function market(
  id: string,
  venue: "polymarket" | "kalshi",
  title: string,
  options: Partial<NormalizedMarket> = {}
): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title,
    prices: {},
    ...options
  };
}

describe("matchMarkets", () => {
  it("detects equivalent markets", () => {
    const result = matchMarkets([
      market("p1", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?"),
      market("k1", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?")
    ], 0.2);

    expect(result.relations[0]?.type).toBe("EQUIVALENT");
  });

  it("downgrades a title match to similar when resolution sources conflict", () => {
    const result = matchMarkets([
      market("p1", "polymarket", "Will Bitcoin be above $150,000 by December 31, 2026?", {
        resolutionSource: "https://coinbase.com"
      }),
      market("k1", "kalshi", "Will Bitcoin be above 150000 by December 31, 2026?", {
        resolutionSource: "https://kraken.com"
      })
    ], 0.2);

    expect(result.relations[0]?.type).toBe("SIMILAR");
    expect(result.relations[0]?.comparison?.resolutionCompatibility).toBe("MISMATCH");
  });

  it("detects threshold nesting and direction", () => {
    const result = matchMarkets([
      market("p1", "polymarket", "Will Bitcoin be above $160k by December 31, 2026?"),
      market("k1", "kalshi", "Will Bitcoin be above $150k by December 31, 2026?")
    ], 0.2);

    expect(result.relations[0]?.type).toBe("THRESHOLD_NESTED");
    expect(result.relations[0]?.direction).toBe("LEFT_IMPLIES_RIGHT");
  });

  it("detects time nesting", () => {
    const result = matchMarkets([
      market("p1", "polymarket", "Will the Fed cut rates by June 30, 2027?", {
        closeTime: "2027-06-30T23:59:59Z"
      }),
      market("k1", "kalshi", "Will the Fed cut rates by December 31, 2027?", {
        closeTime: "2027-12-31T23:59:59Z"
      })
    ], 0.2);

    expect(result.relations[0]?.type).toBe("TIME_NESTED");
    expect(result.relations[0]?.direction).toBe("LEFT_IMPLIES_RIGHT");
  });

  it("detects composed implication when threshold and time both tighten in the same direction", () => {
    const result = matchMarkets([
      market("p1", "polymarket", "Will Bitcoin be above $160k by June 30, 2027?"),
      market("k1", "kalshi", "Will Bitcoin be above $150k by December 31, 2027?")
    ], 0.2);

    expect(result.relations[0]?.type).toBe("IMPLIES");
    expect(result.relations[0]?.direction).toBe("LEFT_IMPLIES_RIGHT");
  });
});
