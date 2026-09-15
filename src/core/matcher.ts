import { extractFeatures } from "./features.js";
import { jaccard, rounded } from "./similarity.js";
import type { MarketFeatures, MarketRelation, NormalizedMarket } from "./types.js";

interface Candidate {
  left: NormalizedMarket;
  right: NormalizedMarket;
  leftFeatures: MarketFeatures;
  rightFeatures: MarketFeatures;
  score: number;
}

function isSameComparatorFamily(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return (a.startsWith(">") && b.startsWith(">")) || (a.startsWith("<") && b.startsWith("<"));
}

function sameDeadline(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).valueOf() - new Date(b).valueOf()) < 24 * 60 * 60 * 1000;
}

function subjectSimilarity(a: MarketFeatures, b: MarketFeatures): number {
  return jaccard(a.subjectText.split(" ").filter(Boolean), b.subjectText.split(" ").filter(Boolean));
}

function buildTokenIndex(markets: readonly NormalizedMarket[], features: Map<string, MarketFeatures>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const market of markets) {
    const marketFeatures = features.get(market.id);
    if (!marketFeatures) continue;
    for (const token of new Set(marketFeatures.tokens)) {
      const ids = index.get(token) ?? new Set<string>();
      ids.add(market.id);
      index.set(token, ids);
    }
  }
  return index;
}

export function generateCandidates(markets: readonly NormalizedMarket[], minimumScore = 0.32): Candidate[] {
  const features = new Map(markets.map((market) => [market.id, extractFeatures(market)]));
  const polymarket = markets.filter((market) => market.venue === "polymarket");
  const kalshi = markets.filter((market) => market.venue === "kalshi");
  const kalshiById = new Map(kalshi.map((market) => [market.id, market]));
  const index = buildTokenIndex(kalshi, features);
  const candidates: Candidate[] = [];

  for (const left of polymarket) {
    const leftFeatures = features.get(left.id);
    if (!leftFeatures) continue;

    const overlapCounts = new Map<string, number>();
    for (const token of new Set(leftFeatures.tokens)) {
      for (const rightId of index.get(token) ?? []) {
        overlapCounts.set(rightId, (overlapCounts.get(rightId) ?? 0) + 1);
      }
    }

    for (const [rightId, sharedTokens] of overlapCounts) {
      if (sharedTokens < 2) continue;
      const right = kalshiById.get(rightId);
      const rightFeatures = features.get(rightId);
      if (!right || !rightFeatures) continue;
      const score = rounded(jaccard(leftFeatures.tokens, rightFeatures.tokens));
      if (score >= minimumScore) candidates.push({ left, right, leftFeatures, rightFeatures, score });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function classifyCandidate(candidate: Candidate): MarketRelation | undefined {
  const { left, right, leftFeatures: a, rightFeatures: b, score } = candidate;
  const subjectScore = subjectSimilarity(a, b);
  if (subjectScore < 0.45) return undefined;

  const thresholdComparable = a.threshold !== undefined && b.threshold !== undefined && isSameComparatorFamily(a.comparator, b.comparator);
  const deadlineComparable = a.deadline !== undefined && b.deadline !== undefined;

  if (
    score >= 0.58 &&
    (!thresholdComparable || a.threshold === b.threshold) &&
    (!deadlineComparable || sameDeadline(a.deadline, b.deadline))
  ) {
    return {
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      confidence: rounded(Math.min(0.99, 0.55 + score * 0.35 + subjectScore * 0.1)),
      evidence: [`token_similarity=${score}`, `subject_similarity=${rounded(subjectScore)}`]
    };
  }

  if (thresholdComparable && a.threshold !== undefined && b.threshold !== undefined && a.threshold !== b.threshold && (!deadlineComparable || sameDeadline(a.deadline, b.deadline))) {
    const greaterFamily = a.comparator?.startsWith(">") === true;
    const leftImpliesRight = greaterFamily ? a.threshold > b.threshold : a.threshold < b.threshold;
    return {
      leftId: left.id,
      rightId: right.id,
      type: "THRESHOLD_NESTED",
      direction: leftImpliesRight ? "LEFT_IMPLIES_RIGHT" : "RIGHT_IMPLIES_LEFT",
      confidence: rounded(Math.min(0.97, 0.62 + subjectScore * 0.25)),
      evidence: [
        `subject_similarity=${rounded(subjectScore)}`,
        `left_threshold=${a.threshold}`,
        `right_threshold=${b.threshold}`
      ]
    };
  }

  if (deadlineComparable && a.deadline !== undefined && b.deadline !== undefined && !sameDeadline(a.deadline, b.deadline) && (!thresholdComparable || a.threshold === b.threshold)) {
    const leftTime = new Date(a.deadline).valueOf();
    const rightTime = new Date(b.deadline).valueOf();
    return {
      leftId: left.id,
      rightId: right.id,
      type: "TIME_NESTED",
      direction: leftTime < rightTime ? "LEFT_IMPLIES_RIGHT" : "RIGHT_IMPLIES_LEFT",
      confidence: rounded(Math.min(0.95, 0.58 + subjectScore * 0.25)),
      evidence: [
        `subject_similarity=${rounded(subjectScore)}`,
        `left_deadline=${a.deadline}`,
        `right_deadline=${b.deadline}`
      ]
    };
  }

  return undefined;
}

export function matchMarkets(markets: readonly NormalizedMarket[], minimumScore = 0.32): { candidatePairs: number; relations: MarketRelation[] } {
  const candidates = generateCandidates(markets, minimumScore);
  const relations = candidates.map(classifyCandidate).filter((value): value is MarketRelation => value !== undefined);
  return { candidatePairs: candidates.length, relations };
}
