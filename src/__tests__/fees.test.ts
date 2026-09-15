import { describe, expect, it } from "vitest";
import { takerFeeForFill } from "../core/fees.js";
import type { NormalizedMarket } from "../core/types.js";

function market(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    id: "m",
    venue: "polymarket",
    externalId: "m",
    title: "Market",
    prices: {},
    ...overrides
  };
}

describe("takerFeeForFill", () => {
  it("calculates the Polymarket curve and rounds to 5 decimals", () => {
    const fee = takerFeeForFill(market({
      fee: { enabled: true, model: "POLYMARKET_CURVE", rate: 0.07, source: "clob" }
    }), 0.5, 100);

    expect(fee).toBe(1.75);
  });

  it("applies the Kalshi multiplier and centicent ceiling", () => {
    const fee = takerFeeForFill(market({
      venue: "kalshi",
      fee: { enabled: true, model: "KALSHI_QUADRATIC", rate: 0.07, multiplier: 1, source: "series" }
    }), 0.43, 1, 0.43);

    expect(fee).toBeCloseTo(0.0172, 8);
  });

  it("supports fee-free markets without treating them as unknown", () => {
    expect(takerFeeForFill(market({
      fee: { enabled: false, model: "POLYMARKET_CURVE", rate: 0, source: "clob" }
    }), 0.5, 100)).toBe(0);

    expect(takerFeeForFill(market({
      venue: "kalshi",
      fee: { enabled: false, model: "KALSHI_QUADRATIC", rate: 0.07, multiplier: 0, source: "series" }
    }), 0.5, 100)).toBe(0);
  });

  it("fails closed for unsupported fee schedules", () => {
    expect(takerFeeForFill(market({
      venue: "kalshi",
      fee: { enabled: true, model: "UNSUPPORTED", feeType: "flat", source: "series" }
    }), 0.5, 100)).toBeUndefined();
  });
});
