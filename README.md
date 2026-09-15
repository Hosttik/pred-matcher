# pred-matcher

Live prediction-market relation, contract verification, and net executable opportunity scanner for Polymarket and Kalshi.

Current version: **0.5.0**.

## Scope

- Public Polymarket Gamma ingestion.
- Public Kalshi Markets API ingestion.
- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth Polymarket and Kalshi books for markets participating in strong relations.
- Venue fee metadata, VWAP/slippage simulation, quote freshness, and target-size execution checks.
- Public Polymarket CLOB WebSocket streaming.
- Authenticated Kalshi orderbook WebSocket streaming when read credentials are configured.
- Incremental opportunity recomputation: only relations touching an updated market are rescanned.
- Opportunity lifecycle history: `OPEN`, `UPDATE`, `CLOSE`.
- Optional append-only JSONL persistence for opportunity history.

## Requirements

- Node.js 24+
- npm 11+

Pinned versions:

- `ws 8.21.3`
- `@types/ws 8.18.1`
- `@types/node 24.13.4`
- `tsx 4.23.13`
- `typescript 7.0.2`
- `vitest 5.0.0`

## Run

```bash
npm install
npm run dev
```

Initial catalog/relation sync:

```bash
curl -X POST http://localhost:3000/v1/sync
```

Start live scanning:

```bash
curl -X POST http://localhost:3000/v1/live/start
curl http://localhost:3000/v1/live/status
```

`POST /v1/live/start` performs an initial sync automatically if none exists.

## Live architecture

```text
catalog REST sync
      ↓
contract matcher + relation graph
      ↓
relation-relevant markets only
      ↓
┌───────────────────────┬────────────────────────┐
│ Polymarket public WS  │ Kalshi authenticated WS│
│ book + price_change   │ snapshot + delta       │
└───────────┬───────────┴────────────┬───────────┘
            ↓                        ↓
        normalized in-memory books
                    ↓
        affected relation index only
                    ↓
      fee/depth-aware opportunity scan
                    ↓
          OPEN / UPDATE / CLOSE
                    ↓
      memory history + optional JSONL
```

A catalog sync does **not** run for every price update. Settlement relations are treated as static between catalog refreshes, while order-book changes trigger only the relations indexed by that market.

## Polymarket live feed

The service subscribes to the public CLOB market channel for the YES/NO asset IDs of Polymarket markets that participate in strong relations.

Behavior:

- full `book` messages replace the local side book;
- `price_change` messages update one level in-place;
- `PING` is sent every 10 seconds;
- reconnects use bounded exponential backoff;
- after reconnect, incremental deltas are ignored until a fresh full `book` is received for that token.

No Polymarket credentials are required for this market-data feed.

## Kalshi live feed

Kalshi's orderbook WebSocket requires an authenticated handshake even for market-data subscriptions. Configure a read-only API key using either an inline PEM or a file path:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PATH='/run/secrets/kalshi-read-key.pem'
```

or:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PEM='-----BEGIN PRIVATE KEY-----\n...'
```

The private key is used only to create the RSA-PSS WebSocket handshake signature. It is never written to history or API responses.

The subscription explicitly requests `use_yes_price: true`; no-side levels are normalized back into NO-contract prices internally. Sequence gaps trigger a fresh orderbook snapshot request instead of continuing from a potentially corrupted local book.

If credentials are absent, the service remains usable but reports Kalshi as:

```json
{
  "status": "DEGRADED",
  "reason": "kalshi_read_credentials_missing"
}
```

The most recent REST snapshot remains available; the API does not claim that Kalshi is live.

## Opportunity history

Every incremental market update compares the previous and new opportunity set for affected relations only.

Events:

- `OPEN`: a previously absent net opportunity appears;
- `UPDATE`: a material execution metric changes;
- `CLOSE`: a previous opportunity is no longer net-profitable/executable.

Query recent in-memory history:

```bash
curl 'http://localhost:3000/v1/history?limit=100'
curl --get 'http://localhost:3000/v1/history' --data-urlencode 'opportunityId=EQUIVALENT_ARB:...'
```

The in-memory ring buffer keeps up to 10,000 events by default.

Optional append-only persistence:

```bash
export PRED_MATCHER_HISTORY_FILE='./.data/opportunity-history.jsonl'
```

Each line is one serialized history event. The file contains market/opportunity metrics only, never venue credentials.

## Auto-start

For a long-running service:

```bash
export PRED_MATCHER_LIVE_AUTO_START=true
npm start
```

The server performs an initial sync and then starts live subscriptions. A later `POST /v1/sync` rebuilds the relation graph and automatically restarts live subscriptions against the new relevant-market set.

## API

### `GET /health`

Returns service version, most recent sync summary, and live-scanner status.

### `POST /v1/sync`

Refreshes open markets, contract relations, full-depth REST snapshots, and fee metadata. If live mode is running, subscriptions are restarted after the new relation graph is installed.

### `POST /v1/live/start`

Starts live market-data subscriptions. Performs an initial sync first when necessary.

### `POST /v1/live/stop`

Stops both venue streams.

### `GET /v1/live/status`

Returns per-venue connection state, subscription counts, reconnect count, latest message timestamp, and incremental recomputation counters.

### `GET /v1/history?limit=100&opportunityId=...`

Returns recent `OPEN` / `UPDATE` / `CLOSE` events, newest first.

### `GET /v1/markets?venue=polymarket|kalshi`

Returns current normalized market state, including live-updated books when available.

### `GET /v1/contracts?marketId=...`

Returns the structured contract representation for one market.

### `GET /v1/relations?type=...`

Returns detected relations and verification evidence.

### `GET /v1/opportunities`

Supported query parameters:

- `type=EQUIVALENT_ARB|IMPLICATION_ARB`
- `minGrossEdge=<dollars-per-share>`
- `minNetEdge=<dollars-per-share>`
- `targetShares=<contracts>`
- `maxQuoteAgeMs=<milliseconds>`
- `includeStale=true|false`

The endpoint recomputes execution metrics from the current in-memory books, so caller-specific target size and freshness filters do not require a global rematch.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: first runnable cross-venue matcher MVP.
- `0.2.0`: structured contract parsing, verification, `SIMILAR`, and composed `IMPLIES` relations.
- `0.3.0`: top-of-book hydration and gross opportunity engine.
- `0.4.0`: full-depth VWAP, taker fees, freshness, target-size simulation, and net executable estimates.
- `0.5.0`: live WebSocket market data, relation-indexed incremental recomputation, lifecycle history, and optional JSONL persistence.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

`0.5.0` is still a scanner, not an atomic two-venue execution engine. A live socket does not remove execution latency, partial-fill risk, capital/position constraints, venue pauses, account-specific fee discounts, or settlement disputes.

Kalshi live mode also requires user-provided read credentials. Without them the system deliberately reports degraded status instead of treating a REST snapshot as live market data.
