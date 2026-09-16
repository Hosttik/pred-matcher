import { evaluateSemanticPromotion, type SemanticPromotionPolicy, type SemanticPromotionReport } from "../core/promotion.js";
import type { QualityRepository } from "./quality-repository.js";

export interface PromotionGateProvider {
  evaluate(): SemanticPromotionReport;
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class PromotionGateService implements PromotionGateProvider {
  constructor(
    private readonly repository: QualityRepository,
    readonly policy: SemanticPromotionPolicy,
    private readonly now: () => number = Date.now
  ) {}

  evaluate(): SemanticPromotionReport {
    const nowMs = this.now();
    const cutoffMs = nowMs - this.policy.maximumEvidenceAgeMs;
    const matchingRuns = this.repository.listShadowRuns(1000).filter((run) =>
      run.status === "COMPLETED" &&
      run.source === "HISTORICAL" &&
      run.model === this.policy.model &&
      run.promptVersion === this.policy.promptVersion &&
      run.matcherVersion === this.policy.matcherVersion
    );
    const observations = matchingRuns.flatMap((run) =>
      this.repository.listShadowVerifications({ limit: 5000, runId: run.runId })
    );
    const freshRuns = matchingRuns.filter((run) => {
      const completedAt = timestamp(run.completedAt ?? run.startedAt);
      return completedAt !== undefined && completedAt >= cutoffMs && completedAt <= nowMs;
    });
    return evaluateSemanticPromotion(
      observations,
      this.repository.listLabels(),
      this.policy,
      freshRuns.length,
      nowMs
    );
  }
}
