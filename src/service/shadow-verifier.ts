import { randomUUID } from "node:crypto";
import { classifyCandidate, generateCandidates } from "../core/matcher.js";
import { evaluateMatcherQuality, relationPairKey } from "../core/quality.js";
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
  type ShadowRunRecord,
  type ShadowVerificationObservation
} from "../core/semantic-verifier.js";
import type { MarketRelation, RelationType } from "../core/types.js";
import { MATCHER_VERSION } from "../core/version.js";
import type { QualityRepository } from "./quality-repository.js";
import type { MemoryStore } from "./store.js";

const ARB_ELIGIBLE = new Set<RelationType>(["EQUIVALENT", "THRESHOLD_NESTED", "TIME_NESTED", "IMPLIES"]);

export interface ShadowVerifierOptions {
  enabled: boolean;
  autoRun: boolean;
  minimumCandidateScore: number;
  maxPairs: number;
  batchSize: number;
}

export interface ShadowVerifierStatus {
  enabled: boolean;
  configured: boolean;
  autoRun: boolean;
  running: boolean;
  provider?: string;
  model?: string;
  promptVersion?: string;
  matcherVersion: string;
  minimumCandidateScore: number;
  maxPairs: number;
  batchSize: number;
  lastRun?: ShadowRunRecord;
}

export class ShadowVerifierServiceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

interface SelectedCandidate {
  candidate: ReturnType<typeof generateCandidates>[number];
  heuristic: MarketRelation | undefined;
}

function priority(value: SelectedCandidate): number {
  if (value.heuristic && ARB_ELIGIBLE.has(value.heuristic.type)) {
    return 3 + (1 - value.heuristic.confidence) + value.candidate.score * 0.1;
  }
  if (value.heuristic?.type === "SIMILAR") return 2 + value.candidate.score;
  return 1 + value.candidate.score;
}

function clampProbability(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function positiveInt(value: number, fallback: number, max: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

export class ShadowVerifierService {
  private readonly options: ShadowVerifierOptions;
  private active: Promise<ShadowRunRecord> | undefined;

  constructor(
    private readonly store: MemoryStore,
    private readonly repository: QualityRepository,
    private readonly verifier: SemanticVerifier | undefined,
    options: ShadowVerifierOptions
  ) {
    this.options = {
      enabled: options.enabled,
      autoRun: options.autoRun,
      minimumCandidateScore: clampProbability(options.minimumCandidateScore, 0.2),
      maxPairs: positiveInt(options.maxPairs, 50, 1000),
      batchSize: positiveInt(options.batchSize, 10, 50)
    };
  }

  shouldAutoRun(): boolean {
    return this.options.enabled && this.options.autoRun && this.verifier !== undefined;
  }

  getStatus(): ShadowVerifierStatus {
    const lastRun = this.repository.listShadowRuns(1)[0];
    return {
      enabled: this.options.enabled,
      configured: this.verifier !== undefined,
      autoRun: this.options.autoRun,
      running: this.active !== undefined,
      ...(this.verifier ? {
        provider: this.verifier.provider,
        model: this.verifier.model,
        ...(this.verifier.promptVersion ? { promptVersion: this.verifier.promptVersion } : {})
      } : {}),
      matcherVersion: MATCHER_VERSION,
      minimumCandidateScore: this.options.minimumCandidateScore,
      maxPairs: this.options.maxPairs,
      batchSize: this.options.batchSize,
      ...(lastRun ? { lastRun } : {})
    };
  }

  async run(): Promise<ShadowRunRecord> {
    if (!this.options.enabled) throw new ShadowVerifierServiceError(409, "shadow_verifier_disabled");
    if (!this.verifier) throw new ShadowVerifierServiceError(503, "shadow_verifier_not_configured");
    if (this.active) throw new ShadowVerifierServiceError(409, "shadow_run_in_progress");
    const task = this.execute(this.verifier);
    this.active = task;
    try { return await task; } finally { this.active = undefined; }
  }

  private async execute(verifier: SemanticVerifier): Promise<ShadowRunRecord> {
    const markets = this.store.listMarkets();
    if (markets.length === 0) throw new ShadowVerifierServiceError(409, "shadow_verifier_no_markets");
    const retrieved = generateCandidates(markets, this.options.minimumCandidateScore);
    const selected = retrieved
      .map((candidate): SelectedCandidate => ({ candidate, heuristic: classifyCandidate(candidate) }))
      .sort((a, b) => priority(b) - priority(a))
      .slice(0, this.options.maxPairs);

    const runId = randomUUID();
    let usage = emptySemanticVerifierUsage();
    let record: ShadowRunRecord = {
      runId,
      status: "RUNNING",
      provider: verifier.provider,
      model: verifier.model,
      ...(verifier.promptVersion ? { promptVersion: verifier.promptVersion } : {}),
      matcherVersion: MATCHER_VERSION,
      source: "LIVE",
      startedAt: new Date().toISOString(),
      retrievedPairs: retrieved.length,
      selectedPairs: selected.length,
      verifiedPairs: 0,
      labeledPairs: 0,
      disagreements: 0,
      usage
    };
    this.repository.upsertShadowRun(record);

    const decisions: SemanticVerifierDecision[] = [];
    try {
      for (let offset = 0; offset < selected.length; offset += this.options.batchSize) {
        const batch = selected.slice(offset, offset + this.options.batchSize);
        const requests = batch.map(({ candidate }) => semanticPair(candidate.left, candidate.right));
        const result = await verifySemanticBatch(verifier, requests);
        usage = mergeSemanticVerifierUsage(usage, result.usage);
        const heuristicByPair = new Map(batch.map(({ candidate, heuristic }) => [
          relationPairKey(candidate.left.id, candidate.right.id), heuristic
        ]));
        const observedAt = new Date().toISOString();
        const observations: ShadowVerificationObservation[] = result.decisions.map((decision) => {
          const heuristic = heuristicByPair.get(decision.pairKey);
          return {
            ...decision,
            runId,
            provider: verifier.provider,
            model: verifier.model,
            ...(verifier.promptVersion ? { promptVersion: verifier.promptVersion } : {}),
            matcherVersion: MATCHER_VERSION,
            observedAt,
            heuristicType: heuristic?.type ?? null,
            heuristicConfidence: heuristic?.confidence ?? null,
            ...(heuristic?.direction ? { heuristicDirection: heuristic.direction } : {})
          };
        });
        this.repository.appendShadowVerifications(observations);
        decisions.push(...result.decisions);
        record = { ...record, verifiedPairs: decisions.length, usage };
        this.repository.upsertShadowRun(record);
      }

      const selectedKeys = new Set(selected.map(({ candidate }) => relationPairKey(candidate.left.id, candidate.right.id)));
      const labels = this.repository.listLabels().filter((label) => selectedKeys.has(relationPairKey(label.leftId, label.rightId)));
      const heuristicPredictions = selected.flatMap(({ heuristic }) => heuristic ? [heuristic] : []);
      const shadowPredictions = decisions.flatMap((decision) => {
        const relation = semanticDecisionToRelation(decision);
        return relation ? [relation] : [];
      });
      const heuristicByPair = new Map(selected.map(({ candidate, heuristic }) => [
        relationPairKey(candidate.left.id, candidate.right.id), heuristic
      ]));
      const disagreements = decisions.filter((decision) => (
        semanticDecisionSignature(decision) !== heuristicSignature(heuristicByPair.get(decision.pairKey))
      )).length;

      record = {
        ...record,
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
        verifiedPairs: decisions.length,
        labeledPairs: labels.length,
        disagreements,
        usage,
        heuristicReport: evaluateMatcherQuality(heuristicPredictions, labels),
        shadowReport: evaluateMatcherQuality(shadowPredictions, labels)
      };
      this.repository.upsertShadowRun(record);
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        ...record,
        status: "FAILED",
        completedAt: new Date().toISOString(),
        verifiedPairs: decisions.length,
        usage,
        error: message.slice(0, 2_000)
      };
      this.repository.upsertShadowRun(record);
      throw error;
    }
  }
}
