import { matchMarkets } from "./matcher.js";
import { findOpportunities } from "./opportunities.js";
import type { MarketOpportunity, MarketRelation, NormalizedMarket } from "./types.js";

export type ReplayMode = "FIXED_RELATIONS" | "REMATCH";

export interface ReplayFrame {
  capturedAt: string;
  markets: NormalizedMarket[];
}

export interface ReplayOptions {
  mode?: ReplayMode;
  minimumCandidateScore?: number;
  minimumGrossEdge?: number;
  minimumNetEdge?: number;
  targetShares?: number;
  maxQuoteAgeMs?: number;
  includeStale?: boolean;
}

export interface ReplaySession {
  openedAt: string;
  lastSeenAt: string;
  closedAt?: string;
}

export interface OpportunityReplayLifetime {
  opportunityId: string;
  type: MarketOpportunity["type"];
  relationType: MarketOpportunity["relationType"];
  firstSeenAt: string;
  lastSeenAt: string;
  observations: number;
  openCount: number;
  totalVisibleMs: number;
  peakNetEdgePerShare: number;
  peakNetProfit: number;
  maxProfitableShares: number;
  sessions: ReplaySession[];
}

export interface ReplayFrameSummary {
  capturedAt: string;
  markets: number;
  candidatePairs: number;
  relations: number;
  opportunities: number;
}

export interface ReplayReport {
  mode: ReplayMode;
  frames: number;
  startedAt: string | null;
  endedAt: string | null;
  candidatePairs: number;
  relationObservations: number;
  uniqueRelations: number;
  opportunityObservations: number;
  uniqueOpportunities: number;
  opens: number;
  closes: number;
  frameSummaries: ReplayFrameSummary[];
  lifetimes: OpportunityReplayLifetime[];
}

interface MutableLifetime {
  opportunityId: string;
  type: MarketOpportunity["type"];
  relationType: MarketOpportunity["relationType"];
  firstSeenAt: string;
  lastSeenAt: string;
  observations: number;
  peakNetEdgePerShare: number;
  peakNetProfit: number;
  maxProfitableShares: number;
  sessions: ReplaySession[];
}

function relationKey(relation: MarketRelation): string {
  const ordered = relation.leftId <= relation.rightId;
  const left = ordered ? relation.leftId : relation.rightId;
  const right = ordered ? relation.rightId : relation.leftId;
  const direction = ordered
    ? relation.direction
    : relation.direction === "LEFT_IMPLIES_RIGHT"
      ? "RIGHT_IMPLIES_LEFT"
      : relation.direction === "RIGHT_IMPLIES_LEFT"
        ? "LEFT_IMPLIES_RIGHT"
        : undefined;
  return JSON.stringify([left, right, relation.type, direction ?? null]);
}

function timestamp(value: string): number {
  const parsed = new Date(value).valueOf();
  if (!Number.isFinite(parsed)) throw new Error(`invalid_replay_timestamp:${value}`);
  return parsed;
}

function visibleMs(lifetime: MutableLifetime): number {
  return lifetime.sessions.reduce((total, session) => {
    const end = session.closedAt ?? session.lastSeenAt;
    return total + Math.max(0, timestamp(end) - timestamp(session.openedAt));
  }, 0);
}

function selectedExecution(opportunity: MarketOpportunity) {
  return opportunity.targetExecution ?? opportunity.bestExecution;
}

export function replayHistoricalFrames(
  frames: readonly ReplayFrame[],
  fixedRelations: readonly MarketRelation[] = [],
  options: ReplayOptions = {}
): ReplayReport {
  const mode = options.mode ?? "FIXED_RELATIONS";
  const orderedFrames = [...frames].sort((a, b) => timestamp(a.capturedAt) - timestamp(b.capturedAt));
  const uniqueRelations = new Set<string>();
  const lifetimes = new Map<string, MutableLifetime>();
  let active = new Set<string>();
  let candidatePairs = 0;
  let relationObservations = 0;
  let opportunityObservations = 0;
  let opens = 0;
  let closes = 0;
  const frameSummaries: ReplayFrameSummary[] = [];

  for (const frame of orderedFrames) {
    const frameMs = timestamp(frame.capturedAt);
    const matched = mode === "REMATCH"
      ? matchMarkets(frame.markets, options.minimumCandidateScore ?? 0.32)
      : { candidatePairs: 0, relations: [...fixedRelations] };
    const relations = matched.relations;
    candidatePairs += matched.candidatePairs;
    relationObservations += relations.length;
    for (const relation of relations) uniqueRelations.add(relationKey(relation));

    const opportunities = findOpportunities(frame.markets, relations, {
      minimumGrossEdge: options.minimumGrossEdge ?? 0,
      minimumNetEdge: options.minimumNetEdge ?? 0,
      nowMs: frameMs,
      maxQuoteAgeMs: options.maxQuoteAgeMs ?? 15_000,
      includeStale: options.includeStale ?? false,
      ...(options.targetShares !== undefined ? { targetShares: options.targetShares } : {})
    });
    opportunityObservations += opportunities.length;
    const current = new Set(opportunities.map((opportunity) => opportunity.id));

    for (const id of active) {
      if (current.has(id)) continue;
      const lifetime = lifetimes.get(id);
      const session = lifetime?.sessions.at(-1);
      if (session && !session.closedAt) session.closedAt = frame.capturedAt;
      closes += 1;
    }

    for (const opportunity of opportunities) {
      const execution = selectedExecution(opportunity);
      let lifetime = lifetimes.get(opportunity.id);
      if (!lifetime) {
        lifetime = {
          opportunityId: opportunity.id,
          type: opportunity.type,
          relationType: opportunity.relationType,
          firstSeenAt: frame.capturedAt,
          lastSeenAt: frame.capturedAt,
          observations: 0,
          peakNetEdgePerShare: execution.netEdgePerShare,
          peakNetProfit: execution.netProfit,
          maxProfitableShares: opportunity.maxProfitableShares,
          sessions: []
        };
        lifetimes.set(opportunity.id, lifetime);
      }
      if (!active.has(opportunity.id)) {
        lifetime.sessions.push({ openedAt: frame.capturedAt, lastSeenAt: frame.capturedAt });
        opens += 1;
      }
      const session = lifetime.sessions.at(-1);
      if (session) session.lastSeenAt = frame.capturedAt;
      lifetime.lastSeenAt = frame.capturedAt;
      lifetime.observations += 1;
      lifetime.peakNetEdgePerShare = Math.max(lifetime.peakNetEdgePerShare, execution.netEdgePerShare);
      lifetime.peakNetProfit = Math.max(lifetime.peakNetProfit, execution.netProfit);
      lifetime.maxProfitableShares = Math.max(lifetime.maxProfitableShares, opportunity.maxProfitableShares);
    }

    active = current;
    frameSummaries.push({
      capturedAt: frame.capturedAt,
      markets: frame.markets.length,
      candidatePairs: matched.candidatePairs,
      relations: relations.length,
      opportunities: opportunities.length
    });
  }

  const finalized = [...lifetimes.values()].map((lifetime): OpportunityReplayLifetime => ({
    opportunityId: lifetime.opportunityId,
    type: lifetime.type,
    relationType: lifetime.relationType,
    firstSeenAt: lifetime.firstSeenAt,
    lastSeenAt: lifetime.lastSeenAt,
    observations: lifetime.observations,
    openCount: lifetime.sessions.length,
    totalVisibleMs: visibleMs(lifetime),
    peakNetEdgePerShare: lifetime.peakNetEdgePerShare,
    peakNetProfit: lifetime.peakNetProfit,
    maxProfitableShares: lifetime.maxProfitableShares,
    sessions: lifetime.sessions.map((session) => ({ ...session }))
  })).sort((a, b) => b.peakNetEdgePerShare - a.peakNetEdgePerShare);

  return {
    mode,
    frames: orderedFrames.length,
    startedAt: orderedFrames[0]?.capturedAt ?? null,
    endedAt: orderedFrames.at(-1)?.capturedAt ?? null,
    candidatePairs,
    relationObservations,
    uniqueRelations: uniqueRelations.size,
    opportunityObservations,
    uniqueOpportunities: finalized.length,
    opens,
    closes,
    frameSummaries,
    lifetimes: finalized
  };
}
