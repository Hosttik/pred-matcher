import { bookCapacity, evaluatePairDepth, quoteAgeTimestamp } from "./execution.js";
import { feeModel, isFeeSupported } from "./fees.js";
import { rounded } from "./similarity.js";
import type {
  MarketOpportunity,
  MarketRelation,
  NormalizedMarket,
  OpportunityLeg,
  OpportunityType,
  OutcomeSide
} from "./types.js";

export interface OpportunitySearchOptions {
  minimumGrossEdge?: number;
  minimumNetEdge?: number;
  targetShares?: number;
  nowMs?: number;
  maxQuoteAgeMs?: number;
  includeStale?: boolean;
}

interface PairDefinition {
  type: OpportunityType;
  firstMarket: NormalizedMarket;
  firstSide: OutcomeSide;
  secondMarket: NormalizedMarket;
  secondSide: OutcomeSide;
}

function bestAsk(market: NormalizedMarket, side: OutcomeSide): { price: number; size: number } | undefined {
  const asks = market.books?.[side]?.asks
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  const best = asks?.[0];
  return best ? { price: best.price, size: best.size } : undefined;
}

function leg(market: NormalizedMarket, side: OutcomeSide): OpportunityLeg | undefined {
  const best = bestAsk(market, side);
  if (!best) return undefined;
  const available = bookCapacity(market, side);
  return {
    marketId: market.id,
    venue: market.venue,
    side,
    ask: rounded(best.price),
    ...(available > 0 ? { availableShares: rounded(available) } : {})
  };
}

function pairForRelation(
  relation: MarketRelation,
  left: NormalizedMarket,
  right: NormalizedMarket
): PairDefinition[] {
  if (relation.type === "EQUIVALENT") {
    return [
      { type: "EQUIVALENT_ARB", firstMarket: left, firstSide: "YES", secondMarket: right, secondSide: "NO" },
      { type: "EQUIVALENT_ARB", firstMarket: left, firstSide: "NO", secondMarket: right, secondSide: "YES" }
    ];
  }

  if (
    relation.type !== "THRESHOLD_NESTED" &&
    relation.type !== "TIME_NESTED" &&
    relation.type !== "IMPLIES"
  ) return [];

  if (relation.direction === "LEFT_IMPLIES_RIGHT") {
    return [{ type: "IMPLICATION_ARB", firstMarket: left, firstSide: "NO", secondMarket: right, secondSide: "YES" }];
  }
  if (relation.direction === "RIGHT_IMPLIES_LEFT") {
    return [{ type: "IMPLICATION_ARB", firstMarket: right, firstSide: "NO", secondMarket: left, secondSide: "YES" }];
  }
  return [];
}

function quoteFreshness(
  pair: PairDefinition,
  nowMs: number,
  maxQuoteAgeMs: number
): { oldestQuoteAt: string; quoteAgeMs: number; isStale: boolean } | undefined {
  const firstAt = quoteAgeTimestamp(pair.firstMarket, pair.firstSide);
  const secondAt = quoteAgeTimestamp(pair.secondMarket, pair.secondSide);
  if (!firstAt || !secondAt) return undefined;
  const firstMs = new Date(firstAt).valueOf();
  const secondMs = new Date(secondAt).valueOf();
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return undefined;
  const oldestMs = Math.min(firstMs, secondMs);
  const quoteAgeMs = Math.max(0, nowMs - oldestMs);
  return {
    oldestQuoteAt: new Date(oldestMs).toISOString(),
    quoteAgeMs: Math.round(quoteAgeMs),
    isStale: quoteAgeMs > maxQuoteAgeMs
  };
}

function makeOpportunity(
  relation: MarketRelation,
  pair: PairDefinition,
  options: Required<Pick<OpportunitySearchOptions, "minimumGrossEdge" | "minimumNetEdge" | "nowMs" | "maxQuoteAgeMs" | "includeStale">> & Pick<OpportunitySearchOptions, "targetShares">
): MarketOpportunity | undefined {
  if (!isFeeSupported(pair.firstMarket) || !isFeeSupported(pair.secondMarket)) return undefined;

  const first = leg(pair.firstMarket, pair.firstSide);
  const second = leg(pair.secondMarket, pair.secondSide);
  if (!first || !second) return undefined;

  const grossCostPerShare = first.ask + second.ask;
  const grossEdgePerShare = 1 - grossCostPerShare;
  if (grossEdgePerShare <= options.minimumGrossEdge) return undefined;

  const freshness = quoteFreshness(pair, options.nowMs, options.maxQuoteAgeMs);
  if (!freshness || (freshness.isStale && !options.includeStale)) return undefined;

  const depth = evaluatePairDepth(
    pair.firstMarket,
    pair.firstSide,
    pair.secondMarket,
    pair.secondSide,
    options.targetShares
  );
  if (!depth) return undefined;

  const selected = depth.targetExecution ?? depth.bestExecution;
  if (selected.netEdgePerShare < options.minimumNetEdge) return undefined;

  const topShares = Math.min(
    bestAsk(pair.firstMarket, pair.firstSide)?.size ?? 0,
    bestAsk(pair.secondMarket, pair.secondSide)?.size ?? 0
  );
  const grossProfitAtTop = topShares > 0 ? topShares * grossEdgePerShare : undefined;
  const firstModel = feeModel(pair.firstMarket);
  const secondModel = feeModel(pair.secondMarket);
  if (!firstModel || !secondModel || firstModel === "UNSUPPORTED" || secondModel === "UNSUPPORTED") return undefined;

  return {
    id: `${pair.type}:${first.marketId}:${first.side}:${second.marketId}:${second.side}`,
    type: pair.type,
    relationType: relation.type,
    relationConfidence: relation.confidence,
    legs: [first, second],
    grossCostPerShare: rounded(grossCostPerShare),
    guaranteedPayoutPerShare: 1,
    grossEdgePerShare: rounded(grossEdgePerShare),
    grossEdgePercent: rounded((grossEdgePerShare / grossCostPerShare) * 100),
    ...(topShares > 0 ? { maxShares: rounded(topShares) } : {}),
    ...(grossProfitAtTop !== undefined ? { grossProfitAtTop: rounded(grossProfitAtTop) } : {}),
    maxExecutableShares: depth.maxExecutableShares,
    maxProfitableShares: depth.maxProfitableShares,
    bestExecution: depth.bestExecution,
    ...(depth.targetExecution ? { targetExecution: depth.targetExecution } : {}),
    oldestQuoteAt: freshness.oldestQuoteAt,
    quoteAgeMs: freshness.quoteAgeMs,
    staleAfterMs: options.maxQuoteAgeMs,
    isStale: freshness.isStale,
    fees: { status: "INCLUDED", models: [firstModel, secondModel] }
  };
}

export function findOpportunities(
  markets: readonly NormalizedMarket[],
  relations: readonly MarketRelation[],
  options: OpportunitySearchOptions | number = {}
): MarketOpportunity[] {
  const normalizedOptions: OpportunitySearchOptions = typeof options === "number"
    ? { minimumGrossEdge: options }
    : options;
  const resolved = {
    minimumGrossEdge: normalizedOptions.minimumGrossEdge ?? 0,
    minimumNetEdge: normalizedOptions.minimumNetEdge ?? 0,
    nowMs: normalizedOptions.nowMs ?? Date.now(),
    maxQuoteAgeMs: normalizedOptions.maxQuoteAgeMs ?? 15_000,
    includeStale: normalizedOptions.includeStale ?? false,
    ...(normalizedOptions.targetShares !== undefined ? { targetShares: normalizedOptions.targetShares } : {})
  };

  const byId = new Map(markets.map((market) => [market.id, market]));
  const opportunities: MarketOpportunity[] = [];

  for (const relation of relations) {
    if (relation.type === "SIMILAR") continue;
    const left = byId.get(relation.leftId);
    const right = byId.get(relation.rightId);
    if (!left || !right) continue;

    for (const pair of pairForRelation(relation, left, right)) {
      const opportunity = makeOpportunity(relation, pair, resolved);
      if (opportunity) opportunities.push(opportunity);
    }
  }

  return opportunities.sort((a, b) => {
    const aExecution = a.targetExecution ?? a.bestExecution;
    const bExecution = b.targetExecution ?? b.bestExecution;
    return bExecution.netEdgePerShare - aExecution.netEdgePerShare;
  });
}
