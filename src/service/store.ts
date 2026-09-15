import type { MarketRelation, NormalizedMarket, SyncResult, Venue } from "../core/types.js";

export class MemoryStore {
  private markets = new Map<string, NormalizedMarket>();
  private relations: MarketRelation[] = [];
  private lastSync?: SyncResult;

  replace(markets: NormalizedMarket[], relations: MarketRelation[], result: SyncResult): void {
    this.markets = new Map(markets.map((market) => [market.id, market]));
    this.relations = [...relations];
    this.lastSync = result;
  }

  listMarkets(venue?: Venue): NormalizedMarket[] {
    return [...this.markets.values()].filter((market) => !venue || market.venue === venue);
  }

  listRelations(): MarketRelation[] {
    return [...this.relations];
  }

  getLastSync(): SyncResult | undefined {
    return this.lastSync;
  }
}
