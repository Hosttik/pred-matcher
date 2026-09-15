import { readFile } from "node:fs/promises";
import { KalshiLiveStream, type KalshiLiveCredentials } from "../adapters/kalshi-live.js";
import { PolymarketLiveStream } from "../adapters/polymarket-live.js";
import type { LiveConnectionStatus, LiveScannerStatus, LiveVenueState, NormalizedMarket, Venue } from "../core/types.js";
import { JsonlHistoryWriter } from "./history-persistence.js";
import { MemoryStore } from "./store.js";

type VenueStateUpdate = Omit<LiveVenueState, "venue" | "connections">;

function disconnected(venue: Venue): LiveVenueState {
  return { venue, status: "DISCONNECTED", subscribedMarkets: 0, connections: 0, reconnects: 0 };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function configuredPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function newest(values: readonly (string | undefined)[]): string | undefined {
  const valid = values.filter((value): value is string => value !== undefined);
  if (valid.length === 0) return undefined;
  return valid.sort((a, b) => new Date(b).valueOf() - new Date(a).valueOf())[0];
}

function aggregateStatus(states: readonly VenueStateUpdate[]): LiveConnectionStatus {
  if (states.some((state) => state.status === "ERROR")) return "ERROR";
  if (states.some((state) => state.status === "DEGRADED")) return "DEGRADED";
  if (states.length > 0 && states.every((state) => state.status === "LIVE")) return "LIVE";
  if (states.some((state) => state.status === "CONNECTING")) return "CONNECTING";
  if (states.some((state) => state.status === "LIVE")) return "DEGRADED";
  return "DISCONNECTED";
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
  private polymarket: PolymarketLiveStream[] = [];
  private kalshi: KalshiLiveStream[] = [];
  private writer: JsonlHistoryWriter | undefined;
  private readonly streamStates: Record<Venue, Map<number, VenueStateUpdate>> = {
    polymarket: new Map(),
    kalshi: new Map()
  };
  private readonly persistenceFailures: Partial<Record<Venue, string>> = {};
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

  private recomputeVenueState(venue: Venue): void {
    const states = [...this.streamStates[venue].values()];
    if (states.length === 0) return;
    const errors = states.flatMap((state) => state.error ? [state.error] : []);
    const reasons = states.flatMap((state) => state.reason ? [state.reason] : []);
    const persistenceFailure = this.persistenceFailures[venue];
    if (persistenceFailure) reasons.push("persistence_write_failed");

    this.state.venues[venue] = {
      venue,
      status: persistenceFailure ? "DEGRADED" : aggregateStatus(states),
      subscribedMarkets: states.reduce((sum, state) => sum + state.subscribedMarkets, 0),
      connections: states.length,
      reconnects: states.reduce((sum, state) => sum + state.reconnects, 0),
      ...(newest(states.map((state) => state.lastMessageAt)) ? {
        lastMessageAt: newest(states.map((state) => state.lastMessageAt))
      } : {}),
      ...(errors.length > 0 ? { error: [...new Set(errors)].join("; ") } : {}),
      ...(reasons.length > 0 ? { reason: [...new Set(reasons)].join("; ") } : {})
    };
  }

  private setStreamState(venue: Venue, index: number, update: VenueStateUpdate): void {
    this.streamStates[venue].set(index, update);
    this.recomputeVenueState(venue);
  }

  private applyMarket(market: NormalizedMarket): void {
    const result = this.store.applyMarketUpdate(market);
    this.state.updatesApplied += 1;
    this.state.recomputations += result.affectedRelations;

    if (result.persistenceError) {
      this.persistenceFailures[market.venue] = result.persistenceError;
      this.recomputeVenueState(market.venue);
    } else if (this.store.getPersistenceStatus().healthy) {
      delete this.persistenceFailures[market.venue];
      this.recomputeVenueState(market.venue);
    }

    if (this.writer && result.history.length > 0) {
      void this.writer.write(result.history).catch(() => {
        this.persistenceFailures[market.venue] = "jsonl_history_persistence_failed";
        this.recomputeVenueState(market.venue);
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
    const polymarketChunkSize = configuredPositiveInt("PRED_MATCHER_POLYMARKET_WS_MARKETS_PER_CONNECTION", 250);
    const kalshiChunkSize = configuredPositiveInt("PRED_MATCHER_KALSHI_WS_MARKETS_PER_CONNECTION", 200);

    this.streamStates.polymarket.clear();
    this.streamStates.kalshi.clear();
    delete this.persistenceFailures.polymarket;
    delete this.persistenceFailures.kalshi;
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

    const polymarketChunks = chunks(polymarketMarkets, polymarketChunkSize);
    if (polymarketChunks.length > 0) {
      this.polymarket = polymarketChunks.map((group, index) => {
        this.streamStates.polymarket.set(index, {
          status: "CONNECTING",
          subscribedMarkets: group.length,
          reconnects: 0
        });
        const stream = new PolymarketLiveStream(group, {
          onMarket: (market) => this.applyMarket(market),
          onState: (state) => this.setStreamState("polymarket", index, state)
        });
        stream.start();
        return stream;
      });
      this.recomputeVenueState("polymarket");
    } else {
      this.state.venues.polymarket = {
        venue: "polymarket",
        status: "DEGRADED",
        subscribedMarkets: 0,
        connections: 0,
        reconnects: 0,
        reason: "no_relation_markets_with_tokens"
      };
    }

    if (kalshiMarkets.length > 0) {
      const credentials = await kalshiCredentialsFromEnv();
      if (credentials) {
        const kalshiChunks = chunks(kalshiMarkets, kalshiChunkSize);
        this.kalshi = kalshiChunks.map((group, index) => {
          this.streamStates.kalshi.set(index, {
            status: "CONNECTING",
            subscribedMarkets: group.length,
            reconnects: 0
          });
          const stream = new KalshiLiveStream(group, credentials, {
            onMarket: (market) => this.applyMarket(market),
            onState: (state) => this.setStreamState("kalshi", index, state)
          });
          stream.start();
          return stream;
        });
        this.recomputeVenueState("kalshi");
      } else {
        this.state.venues.kalshi = {
          venue: "kalshi",
          status: "DEGRADED",
          subscribedMarkets: kalshiMarkets.length,
          connections: 0,
          reconnects: 0,
          reason: "kalshi_read_credentials_missing"
        };
      }
    } else {
      this.state.venues.kalshi = {
        venue: "kalshi",
        status: "DEGRADED",
        subscribedMarkets: 0,
        connections: 0,
        reconnects: 0,
        reason: "no_relation_markets"
      };
    }

    return this.getStatus();
  }

  stop(): LiveScannerStatus {
    for (const stream of this.polymarket) stream.stop();
    for (const stream of this.kalshi) stream.stop();
    this.polymarket = [];
    this.kalshi = [];
    this.streamStates.polymarket.clear();
    this.streamStates.kalshi.clear();
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
