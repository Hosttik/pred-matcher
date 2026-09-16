import { randomUUID } from "node:crypto";
import { classifyCandidate, generateCandidates } from "../core/matcher.js";
import { evaluateMatcherQuality, relationPairKey, type RelationLabel } from "../core/quality.js";
import {
  emptySemanticVerifierUsage,
  heuristicSignature,
  mergeSemanticVerifierUsage,
  semanticDecisionSignature,
  semanticDecisionToRelation,
  semanticPair,
  verifySemanticBatch,
  type SemanticVerifier,
  type SemanticVerifierDecision,
  type ShadowExperimentRecord,
  type ShadowModelComparison,
  type ShadowReviewCandidate,
  type ShadowRunRecord,
  type ShadowVerificationObservation
} from "../core/semantic-verifier.js";
import type { MarketRelation, RelationType } from "../core/types.js";
import type { DatasetRepository } from "./dataset-repository.js";
import type { QualityRepository } from "./quality-repository.js";

const ARB_ELIGIBLE = new Set<RelationType>(["EQUIVALENT", "THRESHOLD_NESTED", "TIME_NESTED", "IMPLIES"]);
type Candidate = ReturnType<typeof generateCandidates>[number];

interface SelectedCandidate {
  candidate: Candidate;
  heuristic: MarketRelation | undefined;
  priority: number;
}

export interface HistoricalShadowExperimentOptions {
  snapshotLimit: number;
  maxPairs: number;
  batchSize: number;
  minimumCandidateScore: number;
}

function candidatePriority(candidate: Candidate, heuristic: MarketRelation | undefined): number {
  if (heuristic && ARB_ELIGIBLE.has(heuristic.type)) return 3 + (1 - heuristic.confidence) + candidate.score * 0.1;
  if (heuristic?.type === "SIMILAR") return 2 + candidate.score;
  return 1 + candidate.score;
}

function labelSignature(label: RelationLabel | undefined): string | undefined {
  return label ? `${label.type}:${label.direction ?? "NONE"}` : undefined;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function compareModels(
  models: readonly string[],
  decisionsByModel: ReadonlyMap<string, Map<string, SemanticVerifierDecision>>
): ShadowModelComparison[] {
  const comparisons: ShadowModelComparison[] = [];
  for (let leftIndex = 0; leftIndex < models.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < models.length; rightIndex += 1) {
      const leftModel = models[leftIndex];
      const rightModel = models[rightIndex];
      if (!leftModel || !rightModel) continue;
      const left = decisionsByModel.get(leftModel) ?? new Map<string, SemanticVerifierDecision>();
      const right = decisionsByModel.get(rightModel) ?? new Map<string, SemanticVerifierDecision>();
      let comparedPairs = 0;
      let disagreements = 0;
      for (const [pairKey, leftDecision] of left) {
        const rightDecision = right.get(pairKey);
        if (!rightDecision) continue;
        comparedPairs += 1;
        if (semanticDecisionSignature(leftDecision) !== semanticDecisionSignature(rightDecision)) disagreements += 1;
      }
      comparisons.push({
        leftModel,
        rightModel,
        comparedPairs,
        disagreements,
        agreementRate: ratio(comparedPairs - disagreements, comparedPairs)
      });
    }
  }
  return comparisons;
}

function buildReviewCandidates(
  experimentId: string,
  selected: readonly SelectedCandidate[],
  models: readonly string[],
  decisionsByModel: ReadonlyMap<string, Map<string, SemanticVerifierDecision>>,
  labels: readonly RelationLabel[]
): ShadowReviewCandidate[] {
  const labelByPair = new Map(labels.map((label) => [relationPairKey(label.leftId, label.rightId), label]));
  const createdAt = new Date().toISOString();
  const review: ShadowReviewCandidate[] = [];

  for (const item of selected) {
    const pairKey = relationPairKey(item.candidate.left.id, item.candidate.right.id);
    const modelSignatures: Record<string, string> = {};
    for (const model of models) {
      const decision = decisionsByModel.get(model)?.get(pairKey);
      if (decision) modelSignatures[model] = semanticDecisionSignature(decision);
    }
    const signatures = Object.values(modelSignatures);
    if (signatures.length === 0) continue;
    const heuristic = heuristicSignature(item.heuristic);
    const gold = labelSignature(labelByPair.get(pairKey));
    const goldMismatch = gold !== undefined && signatures.some((signature) => signature !== gold);
    const modelDisagreement = new Set(signatures).size > 1;
    const heuristicDisagreement = signatures.some((signature) => signature !== heuristic);
    if (!goldMismatch && !modelDisagreement && !heuristicDisagreement) continue;

    const reason = goldMismatch
      ? "GOLD_LABEL_DISAGREEMENT"
      : modelDisagreement
        ? "MODEL_DISAGREEMENT"
        : "HEURISTIC_DISAGREEMENT";
    review.push({
      experimentId,
      pairKey,
      leftId: item.candidate.left.id,
      rightId: item.candidate.right.id,
      priority: Number(((goldMismatch ? 4 : modelDisagreement ? 3 : 2) + item.candidate.score).toFixed(6)),
      reason,
      heuristicSignature: heuristic,
      modelSignatures,
      models: Object.keys(modelSignatures),
      createdAt
    });
  }
  return review.sort((a, b) => b.priority - a.priority);
}

export class ShadowExperimentRunner {
  constructor(
    private readonly datasetRepository: DatasetRepository,
    private readonly qualityRepository: QualityRepository,
    private readonly verifiers: readonly SemanticVerifier[]
  ) {}

  async runHistorical(options: HistoricalShadowExperimentOptions): Promise<ShadowExperimentRecord> {
    if (this.verifiers.length === 0) throw new Error("shadow_experiment_requires_verifier");
    const models = [...new Set(this.verifiers.map((verifier) => verifier.model))];
    if (models.length !== this.verifiers.length) throw new Error("shadow_experiment_duplicate_models");

    const snapshots = this.datasetRepository.listSnapshots({ limit: options.snapshotLimit }).reverse();
    if (snapshots.length === 0) throw new Error("shadow_experiment_no_snapshots");
    const selectedByPair = new Map<string, SelectedCandidate>();
    let retrievedPairs = 0;
    for (const snapshot of snapshots) {
      const frame = this.datasetRepository.loadFrame(snapshot.id);
      if (!frame) continue;
      const candidates = generateCandidates(frame.markets, options.minimumCandidateScore);
      retrievedPairs += candidates.length;
      for (const candidate of candidates) {
        const heuristic = classifyCandidate(candidate);
        const item = { candidate, heuristic, priority: candidatePriority(candidate, heuristic) };
        const key = relationPairKey(candidate.left.id, candidate.right.id);
        const existing = selectedByPair.get(key);
        if (!existing || item.priority >= existing.priority) selectedByPair.set(key, item);
      }
    }
    const selected = [...selectedByPair.values()].sort((a, b) => b.priority - a.priority).slice(0, options.maxPairs);
    if (selected.length === 0) throw new Error("shadow_experiment_no_candidates");
    const selectedKeys = new Set(selected.map(({ candidate }) => relationPairKey(candidate.left.id, candidate.right.id)));

    const experimentId = randomUUID();
    const promptVersions = [...new Set(this.verifiers.map((verifier) => verifier.promptVersion ?? "unversioned"))];
    let experiment: ShadowExperimentRecord = {
      experimentId,
      status: "RUNNING",
      promptVersion: promptVersions.join(","),
      source: "HISTORICAL",
      startedAt: new Date().toISOString(),
      snapshots: snapshots.length,
      uniquePairs: selected.length,
      models,
      runIds: [],
      comparisons: [],
      reviewCandidates: 0,
      usage: emptySemanticVerifierUsage()
    };
    this.qualityRepository.upsertShadowExperiment(experiment);

    const labels = this.qualityRepository.listLabels().filter((label) => (
      label.source !== "PSEUDO" && selectedKeys.has(relationPairKey(label.leftId, label.rightId))
    ));
    const heuristicPredictions = selected.flatMap(({ heuristic }) => heuristic ? [heuristic] : []);
    const decisionsByModel = new Map<string, Map<string, SemanticVerifierDecision>>();
    const runIds: string[] = [];
    const errors: string[] = [];
    let totalUsage = emptySemanticVerifierUsage();
    let completedRuns = 0;

    for (const verifier of this.verifiers) {
      const runId = randomUUID();
      runIds.push(runId);
      let usage = emptySemanticVerifierUsage();
      let run: ShadowRunRecord = {
        runId,
        status: "RUNNING",
        provider: verifier.provider,
        model: verifier.model,
        ...(verifier.promptVersion ? { promptVersion: verifier.promptVersion } : {}),
        source: "HISTORICAL",
        experimentId,
        startedAt: new Date().toISOString(),
        retrievedPairs,
        selectedPairs: selected.length,
        verifiedPairs: 0,
        labeledPairs: labels.length,
        disagreements: 0,
        snapshots: snapshots.length,
        usage
      };
      this.qualityRepository.upsertShadowRun(run);
      const decisions: SemanticVerifierDecision[] = [];
      try {
        for (let offset = 0; offset < selected.length; offset += options.batchSize) {
          const batch = selected.slice(offset, offset + options.batchSize);
          const result = await verifySemanticBatch(verifier, batch.map(({ candidate }) => semanticPair(candidate.left, candidate.right)));
          usage = mergeSemanticVerifierUsage(usage, result.usage);
          const heuristicByPair = new Map(batch.map(({ candidate, heuristic }) => [relationPairKey(candidate.left.id, candidate.right.id), heuristic]));
          const observedAt = new Date().toISOString();
          const observations: ShadowVerificationObservation[] = result.decisions.map((decision) => {
            const heuristic = heuristicByPair.get(decision.pairKey);
            return {
              ...decision,
              runId,
              provider: verifier.provider,
              model: verifier.model,
              ...(verifier.promptVersion ? { promptVersion: verifier.promptVersion } : {}),
              observedAt,
              heuristicType: heuristic?.type ?? null,
              heuristicConfidence: heuristic?.confidence ?? null,
              ...(heuristic?.direction ? { heuristicDirection: heuristic.direction } : {})
            };
          });
          this.qualityRepository.appendShadowVerifications(observations);
          decisions.push(...result.decisions);
          run = { ...run, verifiedPairs: decisions.length, usage };
          this.qualityRepository.upsertShadowRun(run);
        }

        const shadowPredictions = decisions.flatMap((decision) => {
          const relation = semanticDecisionToRelation(decision);
          return relation ? [relation] : [];
        });
        const heuristicByPair = new Map(selected.map(({ candidate, heuristic }) => [relationPairKey(candidate.left.id, candidate.right.id), heuristic]));
        const disagreements = decisions.filter((decision) => (
          semanticDecisionSignature(decision) !== heuristicSignature(heuristicByPair.get(decision.pairKey))
        )).length;
        run = {
          ...run,
          status: "COMPLETED",
          completedAt: new Date().toISOString(),
          verifiedPairs: decisions.length,
          disagreements,
          usage,
          heuristicReport: evaluateMatcherQuality(heuristicPredictions, labels),
          shadowReport: evaluateMatcherQuality(shadowPredictions, labels)
        };
        this.qualityRepository.upsertShadowRun(run);
        decisionsByModel.set(verifier.model, new Map(decisions.map((decision) => [decision.pairKey, decision])));
        totalUsage = mergeSemanticVerifierUsage(totalUsage, usage);
        completedRuns += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${verifier.model}:${message}`);
        run = {
          ...run,
          status: "FAILED",
          completedAt: new Date().toISOString(),
          verifiedPairs: decisions.length,
          usage,
          error: message.slice(0, 2_000)
        };
        this.qualityRepository.upsertShadowRun(run);
        if (decisions.length > 0) decisionsByModel.set(verifier.model, new Map(decisions.map((decision) => [decision.pairKey, decision])));
        totalUsage = mergeSemanticVerifierUsage(totalUsage, usage);
      }
    }

    const comparisons = compareModels(models, decisionsByModel);
    const review = buildReviewCandidates(experimentId, selected, models, decisionsByModel, labels);
    this.qualityRepository.upsertShadowReviewCandidates(review);
    experiment = {
      ...experiment,
      status: completedRuns === this.verifiers.length ? "COMPLETED" : completedRuns > 0 ? "PARTIAL" : "FAILED",
      completedAt: new Date().toISOString(),
      runIds,
      comparisons,
      reviewCandidates: review.length,
      usage: totalUsage,
      ...(errors.length > 0 ? { error: errors.join(" | ").slice(0, 4_000) } : {})
    };
    this.qualityRepository.upsertShadowExperiment(experiment);
    return experiment;
  }
}
