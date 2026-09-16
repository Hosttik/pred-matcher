import { evaluateSemanticPromotion, type SemanticPromotionPolicy, type SemanticPromotionReport } from "../core/promotion.js";
import type { QualityRepository } from "./quality-repository.js";

export interface PromotionGateProvider {
  evaluate(): SemanticPromotionReport;
}

export class PromotionGateService implements PromotionGateProvider {
  constructor(
    private readonly repository: QualityRepository,
    readonly policy: SemanticPromotionPolicy
  ) {}

  evaluate(): SemanticPromotionReport {
    const runs = this.repository.listShadowRuns(1000).filter((run) =>
      run.status === "COMPLETED" &&
      run.source === "HISTORICAL" &&
      run.model === this.policy.model &&
      run.promptVersion === this.policy.promptVersion
    );
    const observations = runs.flatMap((run) =>
      this.repository.listShadowVerifications({ limit: 5000, runId: run.runId })
    );
    return evaluateSemanticPromotion(
      observations,
      this.repository.listLabels(),
      this.policy,
      runs.length
    );
  }
}
