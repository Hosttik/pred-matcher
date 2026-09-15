import { describe, expect, it } from "vitest";
import { buildContractSpec, normalizeResolutionSource } from "../core/contract.js";
import type { NormalizedMarket } from "../core/types.js";

function baseMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    id: "kalshi:test",
    venue: "kalshi",
    externalId: "test",
    title: "Will Bitcoin finish above a strike?",
    prices: {},
    ...overrides
  };
}

describe("buildContractSpec", () => {
  it("prefers venue strike metadata over text extraction", () => {
    const spec = buildContractSpec(baseMarket({
      title: "Will Bitcoin finish above $140k?",
      structure: { strikeType: "greater", floorStrike: 150000 }
    }));

    expect(spec.threshold).toBe(150000);
    expect(spec.comparator).toBe(">");
    expect(spec.fieldSources.threshold).toBe("venue");
    expect(spec.fieldSources.comparator).toBe("venue");
  });

  it("tracks a technical close time as fallback provenance", () => {
    const spec = buildContractSpec(baseMarket({
      closeTime: "2027-12-31T23:59:59Z"
    }));

    expect(spec.deadline).toBe("2027-12-31T23:59:59.000Z");
    expect(spec.fieldSources.deadline).toBe("fallback");
  });
});

describe("normalizeResolutionSource", () => {
  it("normalizes URL sources to domains", () => {
    expect(normalizeResolutionSource("https://www.Coinbase.com/prices/btc")).toBe("coinbase.com");
  });
});
