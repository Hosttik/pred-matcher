import { constants, createSign } from "node:crypto";
import WebSocket from "ws";
import type {
  LiveVenueState,
  NormalizedMarket,
  OrderBookLevel,
  OutcomeOrderBook
} from "../core/types.js";

type StateUpdate = Omit<LiveVenueState, "venue">;

export interface KalshiLiveCredentials {
  apiKeyId: string;
  privateKeyPem: string;
}

export interface KalshiLiveCallbacks {
  onMarket: (market: NormalizedMarket) => void;
  onState: (state: StateUpdate) => void;
}

interface SnapshotMessage {
  type: "orderbook_snapshot";
  sid?: number;
  seq?: number;
  msg?: {
    market_ticker?: string;
    yes_dollars_fp?: [string, string][];
    no_dollars_fp?: [string, string][];
  };
}

interface DeltaMessage {
  type: "orderbook_delta";
  sid?: number;
  seq?: number;
  msg?: {
    market_ticker?: string;
    price_dollars?: string;
    delta_fp?: string;
    side?: "yes" | "no";
    ts?: string;
    ts_ms?: number;
  };
}

interface SubscribedMessage {
  type: "subscribed";
  msg?: { sid?: number; channel?: string };
}

type KalshiMessage = SnapshotMessage | DeltaMessage | SubscribedMessage | { type?: string; msg?: unknown; sid?: number; seq?: number };

function sign(privateKeyPem: string, timestamp: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}GET/trade-api/ws/v2`);
  signer.end();
  return signer.sign({
    key: privateKeyPem,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST
  }).toString("base64");
}

function bidLevels(raw: readonly [string, string][] | undefined, noSideUsesYesScale = false): OrderBookLevel[] {
  return (raw ?? [])
    .map(([price, size]) => ({
      price: noSideUsesYesScale ? 1 - Number(price) : Number(price),
      size: Number(size)
    }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => b.price - a.price);
}

function asksFromOppositeBids(bids: readonly OrderBookLevel[]): OrderBookLevel[] {
  return bids
    .map((level) => ({ price: 1 - level.price, size: level.size }))
    .sort((a, b) => a.price - b.price);
}

function addDelta(levels: readonly OrderBookLevel[], price: number, delta: number): OrderBookLevel[] {
  const existing = levels.find((level) => level.price === price)?.size ?? 0;
  const size = existing + delta;
  const next = levels.filter((level) => level.price !== price);
  if (size > 0) next.push({ price, size });
  return next.sort((a, b) => b.price - a.price);
}

function withBooks(market: NormalizedMarket, yesBids: OrderBookLevel[], noBids: OrderBookLevel[], capturedAt: string): NormalizedMarket {
  const yesAsks = asksFromOppositeBids(noBids);
  const noAsks = asksFromOppositeBids(yesBids);
  const yesBook: OutcomeOrderBook = { bids: yesBids, asks: yesAsks, capturedAt };
  const noBook: OutcomeOrderBook = { bids: noBids, asks: noAsks, capturedAt };
  const yesBid = yesBids[0];
  const noBid = noBids[0];
  const yesAsk = yesAsks[0];
  const noAsk = noAsks[0];
  return {
    ...market,
    books: { YES: yesBook, NO: noBook },
    prices: {
      ...market.prices,
      ...(yesBid ? { yesBid: yesBid.price, yesBidSize: yesBid.size } : {}),
      ...(noBid ? { noBid: noBid.price, noBidSize: noBid.size } : {}),
      ...(yesAsk ? { yesAsk: yesAsk.price, yesAskSize: yesAsk.size } : {}),
      ...(noAsk ? { noAsk: noAsk.price, noAskSize: noAsk.size } : {})
    }
  };
}

export class KalshiLiveStream {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private shouldRun = false;
  private reconnects = 0;
  private messageId = 1;
  private subscriptionSid?: number;
  private readonly lastSeq = new Map<number, number>();
  private readonly markets = new Map<string, NormalizedMarket>();

  constructor(
    markets: readonly NormalizedMarket[],
    private readonly credentials: KalshiLiveCredentials,
    private readonly callbacks: KalshiLiveCallbacks
  ) {
    for (const market of markets) {
      if (market.venue === "kalshi") this.markets.set(market.externalId, market);
    }
  }

  start(): void {
    if (this.shouldRun || this.markets.size === 0) return;
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.callbacks.onState({ status: "DISCONNECTED", subscribedMarkets: this.markets.size, reconnects: this.reconnects });
  }

  private connect(): void {
    if (!this.shouldRun) return;
    this.subscriptionSid = undefined;
    this.lastSeq.clear();
    this.callbacks.onState({ status: "CONNECTING", subscribedMarkets: this.markets.size, reconnects: this.reconnects });
    const timestamp = Date.now().toString();
    const socket = new WebSocket("wss://external-api-ws.kalshi.com/trade-api/ws/v2", {
      headers: {
        "KALSHI-ACCESS-KEY": this.credentials.apiKeyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": sign(this.credentials.privateKeyPem, timestamp)
      }
    });
    this.socket = socket;

    socket.on("open", () => {
      socket.send(JSON.stringify({
        id: this.messageId++,
        cmd: "subscribe",
        params: {
          channels: ["orderbook_delta"],
          market_tickers: [...this.markets.keys()],
          use_yes_price: true
        }
      }));
      this.callbacks.onState({ status: "LIVE", subscribedMarkets: this.markets.size, reconnects: this.reconnects });
    });

    socket.on("message", (data) => {
      let message: KalshiMessage;
      try {
        message = JSON.parse(data.toString()) as KalshiMessage;
      } catch {
        return;
      }
      this.applyMessage(message);
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

  private requestSnapshot(marketTicker: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.subscriptionSid === undefined) return;
    this.socket.send(JSON.stringify({
      id: this.messageId++,
      cmd: "update_subscription",
      params: {
        sid: this.subscriptionSid,
        market_tickers: [marketTicker],
        action: "get_snapshot"
      }
    }));
  }

  private applyMessage(message: KalshiMessage): void {
    if (message.type === "subscribed") {
      const sid = message.msg?.sid;
      if (sid !== undefined) this.subscriptionSid = sid;
      return;
    }

    if (message.type === "orderbook_snapshot") {
      const ticker = message.msg?.market_ticker;
      const market = ticker ? this.markets.get(ticker) : undefined;
      if (!ticker || !market) return;
      const yesBids = bidLevels(message.msg?.yes_dollars_fp);
      const noBids = bidLevels(message.msg?.no_dollars_fp, true);
      const capturedAt = new Date().toISOString();
      const next = withBooks(market, yesBids, noBids, capturedAt);
      this.markets.set(ticker, next);
      if (message.sid !== undefined && message.seq !== undefined) this.lastSeq.set(message.sid, message.seq);
      this.callbacks.onMarket(next);
      return;
    }

    if (message.type !== "orderbook_delta") return;
    const ticker = message.msg?.market_ticker;
    const market = ticker ? this.markets.get(ticker) : undefined;
    if (!ticker || !market || !message.msg?.side) return;

    if (message.sid !== undefined && message.seq !== undefined) {
      const previous = this.lastSeq.get(message.sid);
      if (previous !== undefined && message.seq !== previous + 1) {
        this.requestSnapshot(ticker);
        this.lastSeq.set(message.sid, message.seq);
        return;
      }
      this.lastSeq.set(message.sid, message.seq);
    }

    const rawPrice = Number(message.msg.price_dollars);
    const delta = Number(message.msg.delta_fp);
    if (!Number.isFinite(rawPrice) || !Number.isFinite(delta)) return;
    const yesBids = [...(market.books?.YES?.bids ?? [])];
    const noBids = [...(market.books?.NO?.bids ?? [])];
    if (message.msg.side === "yes") {
      const nextYes = addDelta(yesBids, rawPrice, delta);
      const capturedAt = message.msg.ts ?? new Date().toISOString();
      const next = withBooks(market, nextYes, noBids, capturedAt);
      this.markets.set(ticker, next);
      this.callbacks.onMarket(next);
    } else {
      const noPrice = 1 - rawPrice;
      const nextNo = addDelta(noBids, noPrice, delta);
      const capturedAt = message.msg.ts ?? new Date().toISOString();
      const next = withBooks(market, yesBids, nextNo, capturedAt);
      this.markets.set(ticker, next);
      this.callbacks.onMarket(next);
    }
  }
}
