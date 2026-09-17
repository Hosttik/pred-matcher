import { createHash } from "node:crypto";
import { relationPairKey } from "../core/quality.js";
import type {
  MarketOpportunity,
  MarketRelation,
  NormalizedMarket,
  RelationType,
  SemanticCanaryCohortState,
  SemanticCanarySyncResult,
  Venue
} from "../core/types.js";

export interface CanaryDecision {
  relation: MarketRelation;
  action: "CONFIRMED" | "VETOED";
}

export interface CanaryEnforcementOptions {
  enabled: boolean;
  stages: number[];
  safeSyncsPerStage: number;
  minimumDecisions: number;
  maximumVetoRate: number;
  minimumOpportunityRetentionRate: number;
  initial?: SemanticCanarySyncResult;
}

export interface CanaryApplyResult {
  relations: MarketRelation[];
  snapshot: SemanticCanarySyncResult;
  enforcedVetoPairs: Set<string>;
}

interface MutableCohortState {
  relationType: RelationType;
  venuePair: string;
  stageIndex: number;
  safeStreak: number;
  circuitOpen: boolean;
  reasons: string[];
  openedAt?: string;
  last?: SemanticCanaryCohortState;
}

function probability(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function positiveInt(value: number, fallback: number, max: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function normalizedStages(values: readonly number[]): number[] {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0 && value <= 1);
  const unique = [...new Set(valid.map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [0.1, 0.25, 0.5, 1];
}

function venuePair(left: Venue, right: Venue): string {
  return [left, right].sort().join("-");
}

function cohortKey(relationType: RelationType, pair: string): string {
  return `${relationType}|${pair}`;
}

function sample(pairKey: string, cohort: string): number {
  const digest = createHash("sha256").update(`${cohort}|${pairKey}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function opportunityCountByPair(opportunities: readonly MarketOpportunity[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const opportunity of opportunities) {
    const key = relationPairKey(opportunity.legs[0].marketId, opportunity.legs[1].marketId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function suppressedOpportunityCountByPair(
  baseline: readonly MarketOpportunity[],
  candidate: readonly MarketOpportunity[]
): Map<string, number> {
  const candidateIds = new Set(candidate.map((opportunity) => opportunity.id));
  return opportunityCountByPair(baseline.filter((opportunity) => !candidateIds.has(opportunity.id)));
}

export class CanaryEnforcementService {
  private readonly enabled: boolean;
  private readonly stages: number[];
  private readonly safeSyncsPerStage: number;
  private readonly minimumDecisions: number;
  private readonly maximumVetoRate: number;
  private readonly minimumOpportunityRetentionRate: number;
  private readonly states = new Map<string, MutableCohortState>();
  private lastSnapshot: SemanticCanarySyncResult;

  constructor(options: CanaryEnforcementOptions) {
    this.enabled = options.enabled;
    this.stages = normalizedStages(options.stages);
    this.safeSyncsPerStage = positiveInt(options.safeSyncsPerStage, 6, 10_000);
    this.minimumDecisions = positiveInt(options.minimumDecisions, 5, 100_000);
    this.maximumVetoRate = probability(options.maximumVetoRate, 0.35);
    this.minimumOpportunityRetentionRate = probability(options.minimumOpportunityRetentionRate, 0.5);

    for (const cohort of options.initial?.cohorts ?? []) {
      const stageIndex = Math.min(Math.max(cohort.stageIndex, 0), this.stages.length - 1);
      const restored: SemanticCanaryCohortState = {
        ...cohort,
        stageIndex,
        exposure: cohort.circuitOpen ? 0 : this.stages[stageIndex] ?? 0,
        advancedThisSync: false,
        trippedThisSync: false,
        decisions: 0,
        vetoed: 0,
        vetoRate: 0,
        baselineOpportunities: 0,
        suppressedOpportunities: 0,
        opportunityRetentionRate: null,
        enforcedVetoes: 0
      };
      this.states.set(cohort.key, {
        relationType: cohort.relationType,
        venuePair: cohort.venuePair,
        stageIndex,
        safeStreak: Math.max(0, Math.floor(cohort.safeStreak)),
        circuitOpen: cohort.circuitOpen,
        reasons: [...cohort.reasons],
        ...(cohort.openedAt ? { openedAt: cohort.openedAt } : {}),
        last: restored
      });
    }

    this.lastSnapshot = this.snapshotFromStates();
  }

  private emptySnapshot(): SemanticCanarySyncResult {
    return {
      enabled: this.enabled,
      stages: [...this.stages],
      safeSyncsPerStage: this.safeSyncsPerStage,
      minimumDecisions: this.minimumDecisions,
      maximumVetoRate: this.maximumVetoRate,
      minimumOpportunityRetentionRate: this.minimumOpportunityRetentionRate,
      cohorts: [],
      aggregateExposure: 0,
      eligibleVetoes: 0,
      enforcedVetoes: 0,
      advancedCohorts: 0,
      trippedCohorts: 0
    };
  }

  getStatus(): SemanticCanarySyncResult {
    return this.lastSnapshot;
  }

  reset(cohort?: string): SemanticCanarySyncResult {
    for (const [key, state] of this.states) {
      if (cohort && key !== cohort) continue;
      state.stageIndex = 0;
      state.safeStreak = 0;
      state.circuitOpen = false;
      state.reasons = [];
      delete state.openedAt;
      delete state.last;
    }
    this.lastSnapshot = this.snapshotFromStates();
    return this.lastSnapshot;
  }

  private snapshotFromStates(): SemanticCanarySyncResult {
    const cohorts = [...this.states.entries()].map(([key, state]) => state.last ?? {
      key,
      relationType: state.relationType,
      venuePair: state.venuePair,
      stageIndex: state.stageIndex,
      exposure: state.circuitOpen ? 0 : this.stages[state.stageIndex] ?? 0,
      safeStreak: state.safeStreak,
      circuitOpen: state.circuitOpen,
      reasons: [...state.reasons],
      ...(state.openedAt ? { openedAt: state.openedAt } : {}),
      decisions: 0,
      vetoed: 0,
      vetoRate: 0,
      baselineOpportunities: 0,
      suppressedOpportunities: 0,
      opportunityRetentionRate: null,
      enforcedVetoes: 0,
      advancedThisSync: false,
      trippedThisSync: false
    });
    const eligibleVetoes = cohorts.reduce((sum, cohort) => sum + cohort.vetoed, 0);
    const enforcedVetoes = cohorts.reduce((sum, cohort) => sum + cohort.enforcedVetoes, 0);
    return {
      enabled: this.enabled,
      stages: [...this.stages],
      safeSyncsPerStage: this.safeSyncsPerStage,
      minimumDecisions: this.minimumDecisions,
      maximumVetoRate: this.maximumVetoRate,
      minimumOpportunityRetentionRate: this.minimumOpportunityRetentionRate,
      cohorts,
      aggregateExposure: eligibleVetoes === 0 ? 0 : Number((enforcedVetoes / eligibleVetoes).toFixed(6)),
      eligibleVetoes,
      enforcedVetoes,
      advancedCohorts: cohorts.filter((cohort) => cohort.advancedThisSync).length,
      trippedCohorts: cohorts.filter((cohort) => cohort.trippedThisSync).length
    };
  }

  apply(
    markets: readonly NormalizedMarket[],
    baselineRelations: readonly MarketRelation[],
    decisions: readonly CanaryDecision[],
    baselineOpportunities: readonly MarketOpportunity[],
    fullCandidateOpportunities: readonly MarketOpportunity[],
    globalSafe: boolean
  ): CanaryApplyResult {
    if (!this.enabled) {
      const vetoPairs = new Set(decisions.filter((decision) => decision.action === "VETOED").map((decision) =>
        relationPairKey(decision.relation.leftId, decision.relation.rightId)
      ));
      const relations = baselineRelations.filter((relation) => !vetoPairs.has(relationPairKey(relation.leftId, relation.rightId)));
      this.lastSnapshot = this.emptySnapshot();
      return { relations, snapshot: this.lastSnapshot, enforcedVetoPairs: vetoPairs };
    }

    for (const state of this.states.values()) delete state.last;
    const marketById = new Map(markets.map((market) => [market.id, market]));
    const baselineCounts = opportunityCountByPair(baselineOpportunities);
    const suppressedCounts = suppressedOpportunityCountByPair(baselineOpportunities, fullCandidateOpportunities);
    const groups = new Map<string, CanaryDecision[]>();

    for (const decision of decisions) {
      const left = marketById.get(decision.relation.leftId);
      const right = marketById.get(decision.relation.rightId);
      if (!left || !right) continue;
      const pair = venuePair(left.venue, right.venue);
      const key = cohortKey(decision.relation.type, pair);
      const values = groups.get(key) ?? [];
      values.push(decision);
      groups.set(key, values);
      if (!this.states.has(key)) {
        this.states.set(key, {
          relationType: decision.relation.type,
          venuePair: pair,
          stageIndex: 0,
          safeStreak: 0,
          circuitOpen: false,
          reasons: []
        });
      }
    }

    const enforcedVetoPairs = new Set<string>();
    for (const [key, group] of groups) {
      const state = this.states.get(key)!;
      const vetoed = group.filter((decision) => decision.action === "VETOED");
      const vetoRate = group.length === 0 ? 0 : vetoed.length / group.length;
      let baselineOpportunityCount = 0;
      let suppressedOpportunityCount = 0;
      for (const decision of group) {
        const pairKey = relationPairKey(decision.relation.leftId, decision.relation.rightId);
        baselineOpportunityCount += baselineCounts.get(pairKey) ?? 0;
        suppressedOpportunityCount += suppressedCounts.get(pairKey) ?? 0;
      }
      const opportunityRetentionRate = baselineOpportunityCount === 0
        ? null
        : Math.max(0, 1 - suppressedOpportunityCount / baselineOpportunityCount);
      const sampleEnough = group.length >= this.minimumDecisions;
      const reasons: string[] = [];
      if (sampleEnough && vetoRate > this.maximumVetoRate) {
        reasons.push(`cohort_veto_rate_exceeded:${Number(vetoRate.toFixed(6))}>${this.maximumVetoRate}`);
      }
      if (
        sampleEnough &&
        opportunityRetentionRate !== null &&
        opportunityRetentionRate < this.minimumOpportunityRetentionRate
      ) {
        reasons.push(
          `cohort_opportunity_retention_too_low:${Number(opportunityRetentionRate.toFixed(6))}<${this.minimumOpportunityRetentionRate}`
        );
      }
      const budgetSafe = globalSafe && sampleEnough && reasons.length === 0;
      let advancedThisSync = false;
      let trippedThisSync = false;

      if (!globalSafe || !sampleEnough) {
        state.safeStreak = 0;
      } else if (reasons.length > 0) {
        state.safeStreak = 0;
        if (!state.circuitOpen) {
          state.circuitOpen = true;
          state.reasons = [...new Set([...state.reasons, ...reasons])];
          state.openedAt = new Date().toISOString();
          trippedThisSync = true;
        }
      } else if (!state.circuitOpen) {
        state.safeStreak += 1;
        if (state.safeStreak >= this.safeSyncsPerStage && state.stageIndex < this.stages.length - 1) {
          state.stageIndex += 1;
          state.safeStreak = 0;
          advancedThisSync = true;
        }
      }

      const exposure = budgetSafe && !state.circuitOpen ? this.stages[state.stageIndex] ?? 0 : 0;
      for (const decision of vetoed) {
        const pairKey = relationPairKey(decision.relation.leftId, decision.relation.rightId);
        if (sample(pairKey, key) < exposure) enforcedVetoPairs.add(pairKey);
      }

      state.last = {
        key,
        relationType: state.relationType,
        venuePair: state.venuePair,
        stageIndex: state.stageIndex,
        exposure,
        safeStreak: state.safeStreak,
        circuitOpen: state.circuitOpen,
        reasons: [...state.reasons],
        ...(state.openedAt ? { openedAt: state.openedAt } : {}),
        decisions: group.length,
        vetoed: vetoed.length,
        vetoRate: Number(vetoRate.toFixed(6)),
        baselineOpportunities: baselineOpportunityCount,
        suppressedOpportunities: suppressedOpportunityCount,
        opportunityRetentionRate: opportunityRetentionRate === null ? null : Number(opportunityRetentionRate.toFixed(6)),
        enforcedVetoes: vetoed.filter((decision) => enforcedVetoPairs.has(
          relationPairKey(decision.relation.leftId, decision.relation.rightId)
        )).length,
        advancedThisSync,
        trippedThisSync
      };
    }

    const relations = baselineRelations.filter((relation) =>
      !enforcedVetoPairs.has(relationPairKey(relation.leftId, relation.rightId))
    );
    this.lastSnapshot = this.snapshotFromStates();
    return { relations, snapshot: this.lastSnapshot, enforcedVetoPairs };
  }
}
