import { describe, expect, it } from "vitest";
import { matchMarkets } from "../core/matcher.js";
import type { NormalizedMarket } from "../core/types.js";

function market(id: string, venue: "polymarket" | "kalshi", title: string, closeTime?: string): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    externalId: id,
    title,
    prices: {},
    ...(closeTime ? { closeTime } : {})
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
      market("p1", "polymarket", "Will the Fed cut rates by June 30, 2027?", "2027-06-30T23:59:59Z"),
      market("k1", "kalshi", "Will the Fed cut rates by December 31, 2027?", "2027-12-31T23:59:59Z")
    ], 0.2);

    expect(result.relations[0]?.type).toBe("TIME_NESTED");
    expect(result.relations[0]?.direction).toBe("LEFT_IMPLIES_RIGHT");
  });
});
