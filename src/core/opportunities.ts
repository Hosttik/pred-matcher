import { rounded } from "./similarity.js";
import type {
  MarketOpportunity,
  MarketRelation,
  NormalizedMarket,
  OpportunityLeg,
  OutcomeSide
} from "./types.js";

const FEE_REASON = "Gross opportunity only: venue taker fees and fee waivers are not yet included.";

function askFor(market: NormalizedMarket, side: OutcomeSide): { ask: number; size?: number } | undefined {
  const ask = side === "YES" ? market.prices.yesAsk : market.prices.noAsk;
  const size = side === "YES" ? market.prices.yesAskSize : market.prices.noAskSize;
  if (ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return undefined;
  return { ask, ...(size !== undefined && Number.isFinite(size) && size > 0 ? { size } : {}) };
}

function leg(market: NormalizedMarket, side: OutcomeSide): OpportunityLeg | undefined {
  const quote = askFor(market, side);
  if (!quote) return undefined;
  return {
    marketId: market.id,
    venue: market.venue,
    side,
    ask: rounded(quote.ask),
    ...(quote.size !== undefined ? { availableShares: rounded(quote.size) } : {})
  };
}

function makeOpportunity(
  relation: MarketRelation,
  type: MarketOpportunity["type"],
  first: OpportunityLeg | undefined,
  second: OpportunityLeg | undefined,
  minimumGrossEdge: number
): MarketOpportunity | undefined {
  if (!first || !second) return undefined;
  const grossCostPerShare = first.ask + second.ask;
  const grossEdgePerShare = 1 - grossCostPerShare;
  if (grossEdgePerShare <= minimumGrossEdge) return undefined;

  const maxShares = first.availableShares !== undefined && second.availableShares !== undefined
    ? Math.min(first.availableShares, second.availableShares)
    : undefined;
  const grossProfitAtTop = maxShares !== undefined ? grossEdgePerShare * maxShares : undefined;

  return {
    id: `${type}:${first.marketId}:${first.side}:${second.marketId}:${second.side}`,
    type,
    relationType: relation.type,
    relationConfidence: relation.confidence,
    legs: [first, second],
    grossCostPerShare: rounded(grossCostPerShare),
    guaranteedPayoutPerShare: 1,
    grossEdgePerShare: rounded(grossEdgePerShare),
    grossEdgePercent: rounded((grossEdgePerShare / grossCostPerShare) * 100),
    ...(maxShares !== undefined ? { maxShares: rounded(maxShares) } : {}),
    ...(grossProfitAtTop !== undefined ? { grossProfitAtTop: rounded(grossProfitAtTop) } : {}),
    fees: { status: "NOT_INCLUDED", reason: FEE_REASON }
  };
}

export function findOpportunities(
  markets: readonly NormalizedMarket[],
  relations: readonly MarketRelation[],
  minimumGrossEdge = 0
): MarketOpportunity[] {
  const byId = new Map(markets.map((market) => [market.id, market]));
  const opportunities: MarketOpportunity[] = [];

  for (const relation of relations) {
    const left = byId.get(relation.leftId);
    const right = byId.get(relation.rightId);
    if (!left || !right) continue;

    if (relation.type === "EQUIVALENT") {
      const yesLeftNoRight = makeOpportunity(
        relation,
        "EQUIVALENT_ARB",
        leg(left, "YES"),
        leg(right, "NO"),
        minimumGrossEdge
      );
      const noLeftYesRight = makeOpportunity(
        relation,
        "EQUIVALENT_ARB",
        leg(left, "NO"),
        leg(right, "YES"),
        minimumGrossEdge
      );
      if (yesLeftNoRight) opportunities.push(yesLeftNoRight);
      if (noLeftYesRight) opportunities.push(noLeftYesRight);
      continue;
    }

    if (
      relation.type !== "THRESHOLD_NESTED" &&
      relation.type !== "TIME_NESTED" &&
      relation.type !== "IMPLIES"
    ) continue;

    if (relation.direction === "LEFT_IMPLIES_RIGHT") {
      const opportunity = makeOpportunity(
        relation,
        "IMPLICATION_ARB",
        leg(left, "NO"),
        leg(right, "YES"),
        minimumGrossEdge
      );
      if (opportunity) opportunities.push(opportunity);
    } else if (relation.direction === "RIGHT_IMPLIES_LEFT") {
      const opportunity = makeOpportunity(
        relation,
        "IMPLICATION_ARB",
        leg(right, "NO"),
        leg(left, "YES"),
        minimumGrossEdge
      );
      if (opportunity) opportunities.push(opportunity);
    }
  }

  return opportunities.sort((a, b) => b.grossEdgePerShare - a.grossEdgePerShare);
}
