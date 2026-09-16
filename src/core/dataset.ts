import { classifyCandidate, generateCandidates } from "./matcher.js";
import { relationPairKey } from "./quality.js";
import { rounded } from "./similarity.js";
import type { MarketRelation, NormalizedMarket, RelationType } from "./types.js";

export type DatasetSnapshotSource = "SCHEDULED" | "MANUAL" | "SYNC";
export type ReviewCandidateKind = "HARD_NEGATIVE" | "UNCERTAIN_RELATION";

export interface DatasetReviewCandidate {
  pairKey: string;
  leftId: string;
  rightId: string;
  leftTitle: string;
  rightTitle: string;
  kind: ReviewCandidateKind;
  retrievalScore: number;
  predictedType: RelationType | null;
  predictedConfidence: number | null;
  predictedDirection?: NonNullable<MarketRelation["direction"]>;
  priority: number;
  reasons: string[];
  capturedAt: string;
}

export interface HistoricalDatasetFrame {
  capturedAt: string;
  markets: NormalizedMarket[];
  relations: MarketRelation[];
}

const STRONG_RELATIONS = new Set<RelationType>([
  "EQUIVALENT",
  "THRESHOLD_NESTED",
  "TIME_NESTED",
  "IMPLIES"
]);

function hardNegativePriority(score: number, confidence?: number): number {
  const ambiguity = confidence === undefined ? 0.2 : Math.max(0, 0.9 - confidence);
  return rounded(Math.min(1, 0.45 + score * 0.4 + ambiguity * 0.4));
}

function uncertainPriority(confidence: number, score: number, threshold: number): number {
  const uncertainty = Math.max(0, threshold - confidence);
  return rounded(Math.min(1, 0.55 + uncertainty * 1.8 + Math.max(0, 0.55 - score) * 0.5));
}

export function buildReviewCandidates(
  markets: readonly NormalizedMarket[],
  capturedAt: string,
  minimumCandidateScore = 0.2,
  uncertaintyConfidence = 0.88
): DatasetReviewCandidate[] {
  const review: DatasetReviewCandidate[] = [];

  for (const candidate of generateCandidates(markets, minimumCandidateScore)) {
    const relation = classifyCandidate(candidate);
    const pairKey = relationPairKey(candidate.left.id, candidate.right.id);

    if (!relation) {
      review.push({
        pairKey,
        leftId: candidate.left.id,
        rightId: candidate.right.id,
        leftTitle: candidate.left.title,
        rightTitle: candidate.right.title,
        kind: "HARD_NEGATIVE",
        retrievalScore: candidate.score,
        predictedType: null,
        predictedConfidence: null,
        priority: hardNegativePriority(candidate.score),
        reasons: ["retrieval_candidate_rejected_by_relation_verifier"],
        capturedAt
      });
      continue;
    }

    if (relation.type === "SIMILAR") {
      review.push({
        pairKey,
        leftId: candidate.left.id,
        rightId: candidate.right.id,
        leftTitle: candidate.left.title,
        rightTitle: candidate.right.title,
        kind: "HARD_NEGATIVE",
        retrievalScore: candidate.score,
        predictedType: relation.type,
        predictedConfidence: relation.confidence,
        priority: hardNegativePriority(candidate.score, relation.confidence),
        reasons: ["semantically_related_but_not_arb_eligible"],
        capturedAt
      });
      continue;
    }

    if (STRONG_RELATIONS.has(relation.type) && relation.confidence < uncertaintyConfidence) {
      const reasons = ["arb_eligible_relation_below_review_confidence"];
      if (candidate.score < 0.55) reasons.push("low_retrieval_support");
      if (relation.comparison?.resolutionCompatibility === "UNKNOWN") reasons.push("resolution_source_unknown");
      review.push({
        pairKey,
        leftId: candidate.left.id,
        rightId: candidate.right.id,
        leftTitle: candidate.left.title,
        rightTitle: candidate.right.title,
        kind: "UNCERTAIN_RELATION",
        retrievalScore: candidate.score,
        predictedType: relation.type,
        predictedConfidence: relation.confidence,
        ...(relation.direction ? { predictedDirection: relation.direction } : {}),
        priority: uncertainPriority(relation.confidence, candidate.score, uncertaintyConfidence),
        reasons,
        capturedAt
      });
    }
  }

  return review.sort((a, b) => b.priority - a.priority || b.retrievalScore - a.retrievalScore);
}
