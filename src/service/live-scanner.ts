import { readFile } from "node:fs/promises";
import { KalshiLiveStream, type KalshiLiveCredentials } from "../adapters/kalshi-live.js";
import { PolymarketLiveStream } from "../adapters/polymarket-live.js";
import type { LiveScannerStatus, LiveVenueState, NormalizedMarket, Venue } from "../core/types.js";
import { JsonlHistoryWriter } from "./history-persistence.js";
import { MemoryStore } from "./store.js";

function disconnected(venue: Venue): LiveVenueState {
  return { venue, status: "DISCONNECTED", subscribedMarkets: 0, reconnects: 0 };
}

async function kalshiCredentialsFromEnv(): Promise<KalshiLiveCredentials | undefined> {
  const apiKeyId = process.env.KALSHI_API_KEY_ID?.trim();
  if (!apiKeyId) return undefined;

  const inline = process.env.KALSHI_PRIVATE_KEY_PEM;
  if (inline?.trim()) {
    return { apiKeyId, privateKeyPem: inline.replace(/\\n/g, "\n") };
  }

  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) return undefined;
  try {
    return { apiKeyId, privateKeyPem: await readFile(keyPath, "utf8") };
  } catch {
    return undefined;
  }
}

export class LiveScanner {
  private polymarket: PolymarketLiveStream | undefined;
  private kalshi: KalshiLiveStream | undefined;
  private writer: JsonlHistoryWriter | undefined;
  private state: LiveScannerStatus = {
    running: false,
    updatesApplied: 0,
    recomputations: 0,
    venues: {
      polymarket: disconnected("polymarket"),
      kalshi: disconnected("kalshi")
    }
  };

  constructor(private readonly store: MemoryStore) {
    const historyFile = process.env.PRED_MATCHER_HISTORY_FILE?.trim();
    if (historyFile) this.writer = new JsonlHistoryWriter(historyFile);
  }

  getStatus(): LiveScannerStatus {
    return {
      ...this.state,
      venues: {
        polymarket: { ...this.state.venues.polymarket },
        kalshi: { ...this.state.venues.kalshi }
      }
    };
  }

  private setVenueState(venue: Venue, update: Omit<LiveVenueState, "venue">): void {
    this.state.venues[venue] = {
      venue,
      status: update.status,
      subscribedMarkets: update.subscribedMarkets,
      reconnects: update.reconnects,
      ...(update.lastMessageAt ? { lastMessageAt: update.lastMessageAt } : {}),
      ...(update.error ? { error: update.error } : {}),
      ...(update.reason ? { reason: update.reason } : {})
    };
  }

  private applyMarket(market: NormalizedMarket): void {
    const result = this.store.applyMarketUpdate(market);
    this.state.updatesApplied += 1;
    this.state.recomputations += result.affectedRelations;
    if (this.writer && result.history.length > 0) {
      void this.writer.write(result.history).catch(() => {
        const venue = market.venue;
        const current = this.state.venues[venue];
        this.state.venues[venue] = { ...current, status: "DEGRADED", reason: "history_persistence_failed" };
      });
    }
  }

  async start(): Promise<LiveScannerStatus> {
    if (this.state.running) return this.getStatus();
    if (!this.store.getLastSync()) throw new Error("initial_sync_required");

    const marketIds = this.store.listRelationMarketIds();
    const markets = marketIds
      .map((id) => this.store.getMarket(id))
      .filter((market): market is NormalizedMarket => market !== undefined);
    const polymarketMarkets = markets.filter((market) => market.venue === "polymarket" && (market.tokens?.length ?? 0) > 0);
    const kalshiMarkets = markets.filter((market) => market.venue === "kalshi");

    this.state = {
      running: true,
      startedAt: new Date().toISOString(),
      updatesApplied: 0,
      recomputations: 0,
      venues: {
        polymarket: disconnected("polymarket"),
        kalshi: disconnected("kalshi")
      }
    };

    if (polymarketMarkets.length > 0) {
      this.polymarket = new PolymarketLiveStream(polymarketMarkets, {
        onMarket: (market) => this.applyMarket(market),
        onState: (state) => this.setVenueState("polymarket", state)
      });
      this.polymarket.start();
    } else {
      this.state.venues.polymarket = {
        venue: "polymarket",
        status: "DEGRADED",
        subscribedMarkets: 0,
        reconnects: 0,
        reason: "no_relation_markets_with_tokens"
      };
    }

    if (kalshiMarkets.length > 0) {
      const credentials = await kalshiCredentialsFromEnv();
      if (credentials) {
        this.kalshi = new KalshiLiveStream(kalshiMarkets, credentials, {
          onMarket: (market) => this.applyMarket(market),
          onState: (state) => this.setVenueState("kalshi", state)
        });
        this.kalshi.start();
      } else {
        this.state.venues.kalshi = {
          venue: "kalshi",
          status: "DEGRADED",
          subscribedMarkets: kalshiMarkets.length,
          reconnects: 0,
          reason: "kalshi_read_credentials_missing"
        };
      }
    } else {
      this.state.venues.kalshi = {
        venue: "kalshi",
        status: "DEGRADED",
        subscribedMarkets: 0,
        reconnects: 0,
        reason: "no_relation_markets"
      };
    }

    return this.getStatus();
  }

  stop(): LiveScannerStatus {
    this.polymarket?.stop();
    this.kalshi?.stop();
    this.polymarket = undefined;
    this.kalshi = undefined;
    this.state = {
      ...this.state,
      running: false,
      venues: {
        polymarket: disconnected("polymarket"),
        kalshi: disconnected("kalshi")
      }
    };
    return this.getStatus();
  }

  async restart(): Promise<LiveScannerStatus> {
    this.stop();
    return this.start();
  }
}
