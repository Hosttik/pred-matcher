import { findOpportunities, type OpportunitySearchOptions } from "../core/opportunities.js";
import type {
  IncrementalUpdateResult,
  MarketOpportunity,
  MarketRelation,
  NormalizedMarket,
  OpportunityHistoryEvent,
  SyncResult,
  Venue
} from "../core/types.js";
import type { PersistenceStatus, StatePersistence } from "./sqlite-state.js";

function changed(previous: MarketOpportunity, next: MarketOpportunity): boolean {
  return Math.abs(previous.bestExecution.netEdgePerShare - next.bestExecution.netEdgePerShare) > 0.000001 ||
    Math.abs(previous.bestExecution.netProfit - next.bestExecution.netProfit) > 0.000001 ||
    previous.maxProfitableShares !== next.maxProfitableShares ||
    previous.isStale !== next.isStale;
}

export class MemoryStore {
  private markets = new Map<string, NormalizedMarket>();
  private relations: MarketRelation[] = [];
  private relationIndex = new Map<string, MarketRelation[]>();
  private opportunities = new Map<string, MarketOpportunity>();
  private history: OpportunityHistoryEvent[] = [];
  private historySequence = 0;
  private lastSync: SyncResult | undefined;

  constructor(
    private readonly historyLimit = 10_000,
    private readonly persistence?: StatePersistence
  ) {
    if (!this.persistence) return;
    const snapshot = this.persistence.load();
    this.markets = new Map(snapshot.markets.map((market) => [market.id, market]));
    this.relations = [...snapshot.relations];
    this.opportunities = new Map(snapshot.opportunities.map((opportunity) => [opportunity.id, opportunity]));
    this.history = snapshot.history.slice(-this.historyLimit);
    this.historySequence = this.history.reduce((max, event) => Math.max(max, event.sequence), 0);
    this.lastSync = snapshot.lastSync;
    this.rebuildRelationIndex();
  }

  replace(
    markets: NormalizedMarket[],
    relations: MarketRelation[],
    opportunities: MarketOpportunity[],
    result: SyncResult
  ): void {
    this.persistence?.replaceSnapshot(markets, relations, opportunities, result);
    this.markets = new Map(markets.map((market) => [market.id, market]));
    this.relations = [...relations];
    this.opportunities = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity]));
    this.lastSync = result;
    this.rebuildRelationIndex();
  }

  private rebuildRelationIndex(): void {
    this.relationIndex.clear();
    for (const relation of this.relations) {
      if (relation.type === "SIMILAR") continue;
      for (const marketId of [relation.leftId, relation.rightId]) {
        const existing = this.relationIndex.get(marketId) ?? [];
        existing.push(relation);
        this.relationIndex.set(marketId, existing);
      }
    }
  }

  private historyEvent(kind: OpportunityHistoryEvent["kind"], opportunity: MarketOpportunity): OpportunityHistoryEvent {
    const execution = opportunity.targetExecution ?? opportunity.bestExecution;
    return {
      sequence: ++this.historySequence,
      kind,
      opportunityId: opportunity.id,
      capturedAt: new Date().toISOString(),
      type: opportunity.type,
      relationType: opportunity.relationType,
      netEdgePerShare: execution.netEdgePerShare,
      netProfit: execution.netProfit,
      maxProfitableShares: opportunity.maxProfitableShares,
      quoteAgeMs: opportunity.quoteAgeMs
    };
  }

  private appendHistory(events: OpportunityHistoryEvent[]): void {
    if (events.length === 0) return;
    this.history.push(...events);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  applyMarketUpdate(
    market: NormalizedMarket,
    options: OpportunitySearchOptions = { includeStale: false, maxQuoteAgeMs: 15_000 }
  ): IncrementalUpdateResult {
    if (!this.markets.has(market.id)) {
      return { marketId: market.id, affectedRelations: 0, opportunities: [], history: [] };
    }

    this.markets.set(market.id, market);
    const relations = this.relationIndex.get(market.id) ?? [];
    if (relations.length === 0) {
      let persistenceError: string | undefined;
      try {
        this.persistence?.applyIncremental(market, [], [], []);
      } catch (error) {
        persistenceError = error instanceof Error ? error.message : String(error);
      }
      return {
        marketId: market.id,
        affectedRelations: 0,
        opportunities: [],
        history: [],
        ...(persistenceError ? { persistenceError } : {})
      };
    }

    const previous = [...this.opportunities.values()].filter((opportunity) => {
      const involvesMarket = opportunity.legs.some((leg) => leg.marketId === market.id);
      if (!involvesMarket) return false;
      return relations.some((relation) =>
        opportunity.legs.every((leg) => leg.marketId === relation.leftId || leg.marketId === relation.rightId)
      );
    });
    for (const opportunity of previous) this.opportunities.delete(opportunity.id);

    const next = findOpportunities([...this.markets.values()], relations, options);
    for (const opportunity of next) this.opportunities.set(opportunity.id, opportunity);

    const previousById = new Map(previous.map((opportunity) => [opportunity.id, opportunity]));
    const nextById = new Map(next.map((opportunity) => [opportunity.id, opportunity]));
    const history: OpportunityHistoryEvent[] = [];

    for (const [id, opportunity] of previousById) {
      if (!nextById.has(id)) history.push(this.historyEvent("CLOSE", opportunity));
    }
    for (const [id, opportunity] of nextById) {
      const old = previousById.get(id);
      if (!old) history.push(this.historyEvent("OPEN", opportunity));
      else if (changed(old, opportunity)) history.push(this.historyEvent("UPDATE", opportunity));
    }

    this.appendHistory(history);

    let persistenceError: string | undefined;
    try {
      this.persistence?.applyIncremental(
        market,
        previous.map((opportunity) => opportunity.id),
        next,
        history
      );
    } catch (error) {
      persistenceError = error instanceof Error ? error.message : String(error);
    }

    return {
      marketId: market.id,
      affectedRelations: relations.length,
      opportunities: next,
      history,
      ...(persistenceError ? { persistenceError } : {})
    };
  }

  getMarket(id: string): NormalizedMarket | undefined {
    return this.markets.get(id);
  }

  listMarkets(venue?: Venue): NormalizedMarket[] {
    return [...this.markets.values()].filter((market) => !venue || market.venue === venue);
  }

  listRelations(): MarketRelation[] {
    return [...this.relations];
  }

  listRelationMarketIds(venue?: Venue): string[] {
    return [...this.relationIndex.keys()].filter((id) => {
      const market = this.markets.get(id);
      return market !== undefined && (!venue || market.venue === venue);
    });
  }

  listOpportunities(): MarketOpportunity[] {
    return [...this.opportunities.values()].sort((a, b) =>
      b.bestExecution.netEdgePerShare - a.bestExecution.netEdgePerShare
    );
  }

  listHistory(limit = 100, opportunityId?: string): OpportunityHistoryEvent[] {
    const bounded = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const filtered = opportunityId
      ? this.history.filter((event) => event.opportunityId === opportunityId)
      : this.history;
    return filtered.slice(-bounded).reverse();
  }

  getLastSync(): SyncResult | undefined {
    return this.lastSync;
  }

  getPersistenceStatus(): PersistenceStatus {
    if (this.persistence) return this.persistence.status();
    return {
      enabled: false,
      driver: "memory",
      healthy: true,
      schemaVersion: 0,
      markets: this.markets.size,
      relations: this.relations.length,
      opportunities: this.opportunities.size,
      historyEvents: this.history.length
    };
  }

  close(): void {
    this.persistence?.close();
  }
}
