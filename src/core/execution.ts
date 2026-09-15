import { takerFeeForFill } from "./fees.js";
import { rounded } from "./similarity.js";
import type {
  ExecutedLegQuote,
  ExecutionQuote,
  NormalizedMarket,
  OrderBookLevel,
  OutcomeSide
} from "./types.js";

const SHARE_PRECISION = 0.01;

function validLevels(levels: readonly OrderBookLevel[]): OrderBookLevel[] {
  return levels
    .filter((level) =>
      Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
      Number.isFinite(level.size) && level.size > 0
    )
    .sort((a, b) => a.price - b.price);
}

export function bookCapacity(market: NormalizedMarket, side: OutcomeSide): number {
  return validLevels(market.books?.[side]?.asks ?? []).reduce((sum, level) => sum + level.size, 0);
}

export function bookBreakpoints(market: NormalizedMarket, side: OutcomeSide): number[] {
  const result: number[] = [];
  let cumulative = 0;
  for (const level of validLevels(market.books?.[side]?.asks ?? [])) {
    cumulative += level.size;
    result.push(cumulative);
  }
  return result;
}

export function quoteAgeTimestamp(market: NormalizedMarket, side: OutcomeSide): string | undefined {
  return market.books?.[side]?.capturedAt;
}

export function simulateLeg(
  market: NormalizedMarket,
  side: OutcomeSide,
  shares: number
): ExecutedLegQuote | undefined {
  if (!Number.isFinite(shares) || shares <= 0) return undefined;
  const minimum = market.execution?.minOrderSize;
  if (minimum !== undefined && shares + 1e-9 < minimum) return undefined;

  const levels = validLevels(market.books?.[side]?.asks ?? []);
  let remaining = shares;
  let positionCost = 0;
  let fee = 0;
  let worstPrice = 0;

  for (const level of levels) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, level.size);
    const fillCost = take * level.price;
    const fillFee = takerFeeForFill(market, level.price, take, fillCost);
    if (fillFee === undefined) return undefined;
    positionCost += fillCost;
    fee += fillFee;
    worstPrice = level.price;
    remaining -= take;
  }

  if (remaining > 1e-7 || worstPrice <= 0) return undefined;
  const totalCost = positionCost + fee;
  return {
    marketId: market.id,
    venue: market.venue,
    side,
    shares: rounded(shares),
    positionCost: rounded(positionCost),
    fee: rounded(fee),
    totalCost: rounded(totalCost),
    vwap: rounded(positionCost / shares),
    worstPrice: rounded(worstPrice)
  };
}

export function simulatePair(
  firstMarket: NormalizedMarket,
  firstSide: OutcomeSide,
  secondMarket: NormalizedMarket,
  secondSide: OutcomeSide,
  shares: number
): ExecutionQuote | undefined {
  const first = simulateLeg(firstMarket, firstSide, shares);
  const second = simulateLeg(secondMarket, secondSide, shares);
  if (!first || !second) return undefined;

  const grossPositionCost = first.positionCost + second.positionCost;
  const totalFees = first.fee + second.fee;
  const netCost = grossPositionCost + totalFees;
  const guaranteedPayout = shares;
  const netProfit = guaranteedPayout - netCost;

  return {
    shares: rounded(shares),
    legs: [first, second],
    grossPositionCost: rounded(grossPositionCost),
    totalFees: rounded(totalFees),
    netCost: rounded(netCost),
    guaranteedPayout: rounded(guaranteedPayout),
    netProfit: rounded(netProfit),
    netEdgePerShare: rounded(netProfit / shares),
    netEdgePercent: rounded((netProfit / netCost) * 100)
  };
}

function uniqueBreakpoints(
  firstMarket: NormalizedMarket,
  firstSide: OutcomeSide,
  secondMarket: NormalizedMarket,
  secondSide: OutcomeSide,
  maximum: number
): number[] {
  const values = [
    ...bookBreakpoints(firstMarket, firstSide),
    ...bookBreakpoints(secondMarket, secondSide),
    maximum
  ]
    .filter((value) => value > 0 && value <= maximum + 1e-9)
    .map((value) => Math.min(value, maximum));
  return [...new Set(values.map((value) => rounded(value)))].sort((a, b) => a - b);
}

function binarySearchMaxProfitable(
  firstMarket: NormalizedMarket,
  firstSide: OutcomeSide,
  secondMarket: NormalizedMarket,
  secondSide: OutcomeSide,
  low: number,
  high: number
): number {
  let left = low;
  let right = high;
  while (right - left > SHARE_PRECISION) {
    const rawMid = (left + right) / 2;
    const mid = Math.floor(rawMid / SHARE_PRECISION) * SHARE_PRECISION;
    if (mid <= left) break;
    const quote = simulatePair(firstMarket, firstSide, secondMarket, secondSide, mid);
    if (quote && quote.netProfit > 0) left = mid;
    else right = mid;
  }
  return rounded(left);
}

export interface PairExecutionSummary {
  maxExecutableShares: number;
  maxProfitableShares: number;
  bestExecution: ExecutionQuote;
  targetExecution?: ExecutionQuote;
}

export function evaluatePairDepth(
  firstMarket: NormalizedMarket,
  firstSide: OutcomeSide,
  secondMarket: NormalizedMarket,
  secondSide: OutcomeSide,
  targetShares?: number
): PairExecutionSummary | undefined {
  const maximum = Math.min(
    bookCapacity(firstMarket, firstSide),
    bookCapacity(secondMarket, secondSide)
  );
  if (!Number.isFinite(maximum) || maximum <= 0) return undefined;

  const minimumOrder = Math.max(
    firstMarket.execution?.minOrderSize ?? SHARE_PRECISION,
    secondMarket.execution?.minOrderSize ?? SHARE_PRECISION,
    SHARE_PRECISION
  );
  if (maximum + 1e-9 < minimumOrder) return undefined;

  const points = uniqueBreakpoints(firstMarket, firstSide, secondMarket, secondSide, maximum)
    .filter((value) => value + 1e-9 >= minimumOrder);
  if (points.length === 0) points.push(maximum);

  let bestExecution: ExecutionQuote | undefined;
  let lastProfitablePoint: number | undefined;
  let nextUnprofitablePoint: number | undefined;

  for (const point of points) {
    const quote = simulatePair(firstMarket, firstSide, secondMarket, secondSide, point);
    if (!quote) continue;
    if (quote.netProfit > 0) {
      lastProfitablePoint = point;
      if (!bestExecution || quote.netProfit > bestExecution.netProfit) bestExecution = quote;
    } else if (lastProfitablePoint !== undefined && point > lastProfitablePoint) {
      nextUnprofitablePoint = point;
      break;
    }
  }

  if (!bestExecution || lastProfitablePoint === undefined) return undefined;

  let maxProfitableShares = lastProfitablePoint;
  if (nextUnprofitablePoint !== undefined) {
    maxProfitableShares = binarySearchMaxProfitable(
      firstMarket,
      firstSide,
      secondMarket,
      secondSide,
      lastProfitablePoint,
      nextUnprofitablePoint
    );
  } else if (lastProfitablePoint < maximum) {
    const maxQuote = simulatePair(firstMarket, firstSide, secondMarket, secondSide, maximum);
    if (maxQuote?.netProfit && maxQuote.netProfit > 0) maxProfitableShares = maximum;
  }

  let targetExecution: ExecutionQuote | undefined;
  if (targetShares !== undefined) {
    if (!Number.isFinite(targetShares) || targetShares <= 0 || targetShares > maximum + 1e-9) return undefined;
    targetExecution = simulatePair(firstMarket, firstSide, secondMarket, secondSide, targetShares);
    if (!targetExecution || targetExecution.netProfit <= 0) return undefined;
  }

  return {
    maxExecutableShares: rounded(maximum),
    maxProfitableShares: rounded(maxProfitableShares),
    bestExecution,
    ...(targetExecution ? { targetExecution } : {})
  };
}
