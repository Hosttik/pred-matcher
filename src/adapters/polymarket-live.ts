import WebSocket from "ws";
import type {
  LiveVenueState,
  NormalizedMarket,
  OrderBookLevel,
  OutcomeOrderBook,
  OutcomeSide
} from "../core/types.js";

interface TokenRef {
  marketId: string;
  side: OutcomeSide;
}

interface PolyBookMessage {
  event_type: "book";
  asset_id: string;
  bids?: { price?: string; size?: string }[];
  asks?: { price?: string; size?: string }[];
  timestamp?: string;
}

interface PolyPriceChange {
  asset_id?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
}

interface PolyPriceChangeMessage {
  event_type: "price_change";
  price_changes?: PolyPriceChange[];
  timestamp?: string;
}

interface PolyTickMessage {
  event_type: "tick_size_change";
  asset_id?: string;
  new_tick_size?: string;
  timestamp?: string;
}

type PolyMessage = PolyBookMessage | PolyPriceChangeMessage | PolyTickMessage | { event_type?: string };

type StateUpdate = Omit<LiveVenueState, "venue">;

export interface PolymarketLiveCallbacks {
  onMarket: (market: NormalizedMarket) => void;
  onState: (state: StateUpdate) => void;
}

function parsedLevels(levels: readonly { price?: string; size?: string }[] | undefined): OrderBookLevel[] {
  return (levels ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function replaceLevel(levels: readonly OrderBookLevel[], price: number, size: number, ascending: boolean): OrderBookLevel[] {
  const next = levels.filter((level) => level.price !== price);
  if (size > 0) next.push({ price, size });
  return next.sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
}

function timestamp(value?: string): { capturedAt: string; sourceTimestamp?: string } {
  if (value && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return { capturedAt: new Date(parsed).toISOString(), sourceTimestamp: value };
    }
  }
  return { capturedAt: new Date().toISOString(), ...(value ? { sourceTimestamp: value } : {}) };
}

function withBestPrices(market: NormalizedMarket): NormalizedMarket {
  const yes = market.books?.YES;
  const no = market.books?.NO;
  const yesAsk = yes?.asks[0];
  const noAsk = no?.asks[0];
  const yesBid = yes?.bids?.[0];
  const noBid = no?.bids?.[0];
  return {
    ...market,
    prices: {
      ...market.prices,
      ...(yesAsk ? { yesAsk: yesAsk.price, yesAskSize: yesAsk.size } : {}),
      ...(noAsk ? { noAsk: noAsk.price, noAskSize: noAsk.size } : {}),
      ...(yesBid ? { yesBid: yesBid.price, yesBidSize: yesBid.size } : {}),
      ...(noBid ? { noBid: noBid.price, noBidSize: noBid.size } : {})
    }
  };
}

export class PolymarketLiveStream {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private shouldRun = false;
  private reconnects = 0;
  private readonly markets = new Map<string, NormalizedMarket>();
  private readonly tokens = new Map<string, TokenRef>();
  private readonly readyTokens = new Set<string>();

  constructor(markets: readonly NormalizedMarket[], private readonly callbacks: PolymarketLiveCallbacks) {
    for (const market of markets) {
      if (market.venue !== "polymarket") continue;
      this.markets.set(market.id, market);
      for (const token of market.tokens ?? []) {
        this.tokens.set(token.tokenId, { marketId: market.id, side: token.side });
      }
    }
  }

  start(): void {
    if (this.shouldRun || this.tokens.size === 0) return;
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined;
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.callbacks.onState({ status: "DISCONNECTED", subscribedMarkets: this.markets.size, reconnects: this.reconnects });
  }

  private connect(): void {
    if (!this.shouldRun) return;
    this.readyTokens.clear();
    this.callbacks.onState({ status: "CONNECTING", subscribedMarkets: this.markets.size, reconnects: this.reconnects });
    const socket = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    this.socket = socket;

    socket.on("open", () => {
      socket.send(JSON.stringify({
        assets_ids: [...this.tokens.keys()],
        type: "market",
        custom_feature_enabled: true
      }));
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, 10_000);
      this.callbacks.onState({ status: "LIVE", subscribedMarkets: this.markets.size, reconnects: this.reconnects });
    });

    socket.on("message", (data) => {
      const text = data.toString();
      if (text === "PONG") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) this.applyMessage(message as PolyMessage);
      this.callbacks.onState({
        status: "LIVE",
        subscribedMarkets: this.markets.size,
        reconnects: this.reconnects,
        lastMessageAt: new Date().toISOString()
      });
    });

    socket.on("error", (error) => {
      this.callbacks.onState({
        status: "ERROR",
        subscribedMarkets: this.markets.size,
        reconnects: this.reconnects,
        error: error.message
      });
    });

    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      if (!this.shouldRun) return;
      this.reconnects += 1;
      this.callbacks.onState({
        status: "DEGRADED",
        subscribedMarkets: this.markets.size,
        reconnects: this.reconnects,
        reason: "socket_closed_reconnecting"
      });
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnects - 1, 5));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private applyMessage(message: PolyMessage): void {
    if (message.event_type === "book") {
      const ref = this.tokens.get(message.asset_id);
      if (!ref) return;
      const market = this.markets.get(ref.marketId);
      if (!market) return;
      const time = timestamp(message.timestamp);
      const book: OutcomeOrderBook = {
        asks: parsedLevels(message.asks),
        bids: parsedLevels(message.bids).sort((a, b) => b.price - a.price),
        capturedAt: time.capturedAt,
        ...(time.sourceTimestamp ? { sourceTimestamp: time.sourceTimestamp } : {})
      };
      const next = withBestPrices({
        ...market,
        books: { ...market.books, [ref.side]: book }
      });
      this.readyTokens.add(message.asset_id);
      this.markets.set(market.id, next);
      this.callbacks.onMarket(next);
      return;
    }

    if (message.event_type === "price_change") {
      for (const change of message.price_changes ?? []) {
        if (!change.asset_id || !this.readyTokens.has(change.asset_id)) continue;
        const ref = this.tokens.get(change.asset_id);
        if (!ref) continue;
        const market = this.markets.get(ref.marketId);
        const current = market?.books?.[ref.side];
        const price = Number(change.price);
        const size = Number(change.size);
        if (!market || !current || !Number.isFinite(price) || !Number.isFinite(size) || !change.side) continue;
        const time = timestamp(message.timestamp);
        const bids = current.bids ?? [];
        const nextBook: OutcomeOrderBook = change.side === "BUY"
          ? {
              ...current,
              bids: replaceLevel(bids, price, size, false),
              capturedAt: time.capturedAt,
              ...(time.sourceTimestamp ? { sourceTimestamp: time.sourceTimestamp } : {})
            }
          : {
              ...current,
              asks: replaceLevel(current.asks, price, size, true),
              capturedAt: time.capturedAt,
              ...(time.sourceTimestamp ? { sourceTimestamp: time.sourceTimestamp } : {})
            };
        const next = withBestPrices({ ...market, books: { ...market.books, [ref.side]: nextBook } });
        this.markets.set(market.id, next);
        this.callbacks.onMarket(next);
      }
      return;
    }

    if (message.event_type === "tick_size_change" && message.asset_id) {
      const ref = this.tokens.get(message.asset_id);
      const market = ref ? this.markets.get(ref.marketId) : undefined;
      const tickSize = Number(message.new_tick_size);
      if (!market || !Number.isFinite(tickSize) || tickSize <= 0) return;
      const next = { ...market, execution: { ...market.execution, tickSize } };
      this.markets.set(market.id, next);
      this.callbacks.onMarket(next);
    }
  }
}
