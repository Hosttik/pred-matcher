import { buildContractSpec, compareContracts, thresholdImplicationDirection, timeImplicationDirection } from "./contract.js";
import { extractFeatures, tokenize } from "./features.js";
import { jaccard, rounded } from "./similarity.js";
import type { ContractComparison, MarketFeatures, MarketRelation, NormalizedMarket } from "./types.js";

export const DEFAULT_MINIMUM_CANDIDATE_SCORE = 0.32;

interface Candidate {
  left: NormalizedMarket;
  right: NormalizedMarket;
  leftFeatures: MarketFeatures;
  rightFeatures: MarketFeatures;
  score: number;
}

function retrievalTokens(market: NormalizedMarket): string[] {
  return tokenize([market.title, market.subtitle ?? ""].join(" "));
}

function buildTokenIndex(markets: readonly NormalizedMarket[], tokens: Map<string, string[]>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const market of markets) {
    for (const token of new Set(tokens.get(market.id) ?? [])) {
      const ids = index.get(token) ?? new Set<string>();
      ids.add(market.id);
      index.set(token, ids);
    }
  }
  return index;
}

export function generateCandidates(
  markets: readonly NormalizedMarket[],
  minimumScore = DEFAULT_MINIMUM_CANDIDATE_SCORE
): Candidate[] {
  const features = new Map(markets.map((market) => [market.id, extractFeatures(market)]));
  const tokens = new Map(markets.map((market) => [market.id, retrievalTokens(market)]));
  const polymarket = markets.filter((market) => market.venue === "polymarket");
  const kalshi = markets.filter((market) => market.venue === "kalshi");
  const kalshiById = new Map(kalshi.map((market) => [market.id, market]));
  const index = buildTokenIndex(kalshi, tokens);
  const candidates: Candidate[] = [];

  for (const left of polymarket) {
    const leftFeatures = features.get(left.id);
    const leftTokens = tokens.get(left.id);
    if (!leftFeatures || !leftTokens) continue;

    const overlapCounts = new Map<string, number>();
    for (const token of new Set(leftTokens)) {
      for (const rightId of index.get(token) ?? []) {
        overlapCounts.set(rightId, (overlapCounts.get(rightId) ?? 0) + 1);
      }
    }

    for (const [rightId, sharedTokens] of overlapCounts) {
      if (sharedTokens < 2) continue;
      const right = kalshiById.get(rightId);
      const rightFeatures = features.get(rightId);
      const rightTokens = tokens.get(rightId);
      if (!right || !rightFeatures || !rightTokens) continue;
      const score = rounded(jaccard(leftTokens, rightTokens));
      if (score >= minimumScore) candidates.push({ left, right, leftFeatures, rightFeatures, score });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function hasDifference(comparison: ContractComparison, prefix: string): boolean {
  return comparison.differences.some((difference) => difference.startsWith(prefix));
}

function verifierEvidence(comparison: ContractComparison): boolean {
  return comparison.resolutionCompatibility === "MATCH"
    || (comparison.rulesSimilarity !== null && comparison.rulesSimilarity >= 0.35);
}

function settlementCompatible(comparison: ContractComparison): boolean {
  if (comparison.resolutionCompatibility === "MISMATCH") return false;
  if (hasDifference(comparison, "early_close_condition:")) return false;
  return comparison.rulesSimilarity === null || comparison.rulesSimilarity >= 0.08;
}

function evidenceFor(score: number, comparison: ContractComparison): string[] {
  return [
    `retrieval_similarity=${score}`,
    `subject_similarity=${comparison.subjectSimilarity}`,
    `resolution_compatibility=${comparison.resolutionCompatibility}`,
    ...(comparison.rulesSimilarity !== null ? [`rules_similarity=${comparison.rulesSimilarity}`] : []),
    ...comparison.differences.map((difference) => `difference=${difference}`)
  ];
}

export function classifyCandidate(candidate: Candidate): MarketRelation | undefined {
  const { left, right, score } = candidate;
  const leftContract = buildContractSpec(left);
  const rightContract = buildContractSpec(right);
  const comparison = compareContracts(leftContract, rightContract);
  const subjectScore = comparison.subjectSimilarity;
  if (subjectScore < 0.45) return undefined;

  const thresholdDirection = thresholdImplicationDirection(leftContract, rightContract);
  const timeDirection = timeImplicationDirection(leftContract, rightContract);
  const settlementSafe = settlementCompatible(comparison);
  const thresholdDifference = hasDifference(comparison, "threshold:");
  const deadlineDifference = hasDifference(comparison, "deadline:");
  const comparatorDifference = hasDifference(comparison, "comparator:");

  if (
    settlementSafe &&
    thresholdDirection &&
    timeDirection &&
    thresholdDirection === timeDirection &&
    !comparatorDifference
  ) {
    return {
      leftId: left.id,
      rightId: right.id,
      type: "IMPLIES",
      direction: thresholdDirection,
      confidence: rounded(Math.min(0.96, 0.68 + subjectScore * 0.2 + score * 0.08)),
      evidence: evidenceFor(score, comparison),
      comparison
    };
  }

  if (
    settlementSafe &&
    thresholdDirection &&
    !timeDirection &&
    !deadlineDifference &&
    !comparatorDifference
  ) {
    return {
      leftId: left.id,
      rightId: right.id,
      type: "THRESHOLD_NESTED",
      direction: thresholdDirection,
      confidence: rounded(Math.min(0.95, 0.64 + subjectScore * 0.22 + score * 0.06)),
      evidence: evidenceFor(score, comparison),
      comparison
    };
  }

  if (
    settlementSafe &&
    timeDirection &&
    !thresholdDirection &&
    !thresholdDifference &&
    !comparatorDifference
  ) {
    return {
      leftId: left.id,
      rightId: right.id,
      type: "TIME_NESTED",
      direction: timeDirection,
      confidence: rounded(Math.min(0.94, 0.62 + subjectScore * 0.22 + score * 0.06)),
      evidence: evidenceFor(score, comparison),
      comparison
    };
  }

  const noKnownDifference = comparison.differences.length === 0;
  if (
    settlementSafe &&
    noKnownDifference &&
    score >= 0.58 &&
    subjectScore >= 0.55 &&
    (verifierEvidence(comparison) || score >= 0.78)
  ) {
    const resolutionBoost = comparison.resolutionCompatibility === "MATCH" ? 0.04 : 0;
    const rulesBoost = comparison.rulesSimilarity === null ? 0 : Math.min(0.04, comparison.rulesSimilarity * 0.04);
    return {
      leftId: left.id,
      rightId: right.id,
      type: "EQUIVALENT",
      confidence: rounded(Math.min(0.99, 0.62 + score * 0.18 + subjectScore * 0.1 + resolutionBoost + rulesBoost)),
      evidence: evidenceFor(score, comparison),
      comparison
    };
  }

  if (score >= 0.42 && subjectScore >= 0.45) {
    return {
      leftId: left.id,
      rightId: right.id,
      type: "SIMILAR",
      confidence: rounded(Math.min(0.9, 0.42 + score * 0.25 + subjectScore * 0.18)),
      evidence: evidenceFor(score, comparison),
      comparison
    };
  }

  return undefined;
}

export function matchMarkets(
  markets: readonly NormalizedMarket[],
  minimumScore = DEFAULT_MINIMUM_CANDIDATE_SCORE
): { candidatePairs: number; relations: MarketRelation[] } {
  const candidates = generateCandidates(markets, minimumScore);
  const relations = candidates.map(classifyCandidate).filter((value): value is MarketRelation => value !== undefined);
  return { candidatePairs: candidates.length, relations };
}
