import type { FeeModel, NormalizedMarket } from "./types.js";

function ceilTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil((value - Number.EPSILON) * factor) / factor;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function feeModel(market: NormalizedMarket): FeeModel | undefined {
  return market.fee?.model;
}

export function isFeeSupported(market: NormalizedMarket): boolean {
  const model = feeModel(market);
  return model === "POLYMARKET_CURVE" || model === "KALSHI_QUADRATIC";
}

/**
 * Returns the taker fee for one fill, or undefined when the venue fee model
 * cannot be evaluated safely. Opportunity evaluation fails closed on undefined.
 */
export function takerFeeForFill(
  market: NormalizedMarket,
  price: number,
  shares: number,
  positionCost = price * shares
): number | undefined {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(shares) || shares <= 0) {
    return undefined;
  }

  const fee = market.fee;
  if (!fee || !fee.model || fee.model === "UNSUPPORTED") return undefined;

  if (fee.model === "POLYMARKET_CURVE") {
    const rate = fee.rate ?? (fee.enabled ? undefined : 0);
    if (rate === undefined || !Number.isFinite(rate) || rate < 0) return undefined;
    const raw = shares * rate * price * (1 - price);
    // Polymarket documents USDC taker fees rounded to 5 decimal places.
    return roundTo(raw, 5);
  }

  if (fee.model === "KALSHI_QUADRATIC") {
    const multiplier = fee.multiplier;
    if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier < 0) return undefined;
    const raw = multiplier * 0.07 * shares * price * (1 - price);
    // Current Kalshi schedule rounds up so fee + position cost lands on a centicent.
    return Math.max(0, ceilTo(positionCost + raw, 4) - positionCost);
  }

  return undefined;
}
