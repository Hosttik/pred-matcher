import type {
  MarketOpportunity,
  MarketRelation,
  NormalizedMarket,
  SyncResult,
  Venue
} from "../core/types.js";

export class MemoryStore {
  private markets = new Map<string, NormalizedMarket>();
  private relations: MarketRelation[] = [];
  private opportunities: MarketOpportunity[] = [];
  private lastSync?: SyncResult;

  replace(
    markets: NormalizedMarket[],
    relations: MarketRelation[],
    opportunities: MarketOpportunity[],
    result: SyncResult
  ): void {
    this.markets = new Map(markets.map((market) => [market.id, market]));
    this.relations = [...relations];
    this.opportunities = [...opportunities];
    this.lastSync = result;
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

  listOpportunities(): MarketOpportunity[] {
    return [...this.opportunities];
  }

  getLastSync(): SyncResult | undefined {
    return this.lastSync;
  }
}
