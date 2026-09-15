# pred-matcher

Durable live prediction-market relation, contract verification, and net executable opportunity scanner for Polymarket and Kalshi.

Current version: **0.6.0**.

## Scope

- Public Polymarket Gamma ingestion and public Kalshi Markets API ingestion.
- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth books, venue fee metadata, VWAP/slippage simulation, quote freshness, and target-size execution checks.
- Public Polymarket CLOB WebSocket streaming.
- Authenticated Kalshi orderbook WebSocket streaming when read credentials are configured.
- Relation-indexed incremental opportunity recomputation.
- Opportunity lifecycle history: `OPEN`, `UPDATE`, `CLOSE`.
- Durable SQLite state for markets, relations, opportunities, sync state, and lifecycle history.
- Periodic catalog refresh, Prometheus metrics, readiness checks, and graceful shutdown.
- Sharded WebSocket subscriptions for large relation sets.

## Requirements

- Node.js **24.15+**
- npm 11+

The durable store uses Node's built-in `node:sqlite`; no native SQLite npm dependency is required.

Pinned package versions:

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

By default the service creates:

```text
./data/pred-matcher.sqlite
```

The database uses WAL mode for file-backed storage.

Initial/manual catalog refresh:

```bash
curl -X POST http://localhost:3000/v1/sync
```

Start live scanning:

```bash
curl -X POST http://localhost:3000/v1/live/start
curl http://localhost:3000/v1/live/status
```

`POST /v1/live/start` performs an initial sync automatically if neither a restored nor a current sync state exists.

## Durable state and restart recovery

`0.6.0` persists the current operational state rather than relying on RAM only. The SQLite database stores:

```text
markets
relations
opportunities
opportunity_history
sync_state
```

A full catalog sync replaces the current markets/relations/opportunities in one transaction. Live order-book updates use incremental upserts/deletes and append lifecycle history.

On process restart, the in-memory indices are rebuilt from SQLite immediately. This means `/v1/markets`, `/v1/relations`, `/v1/history`, and the last known opportunity state are available before the next external catalog refresh finishes.

Configuration:

```bash
# Default: ./data/pred-matcher.sqlite
export PRED_MATCHER_DB_PATH='/var/lib/pred-matcher/state.sqlite'

# Disable durable persistence entirely.
export PRED_MATCHER_PERSISTENCE=false

# Default: 10000
export PRED_MATCHER_HISTORY_LIMIT=20000
```

For tests or intentionally ephemeral runs:

```bash
export PRED_MATCHER_DB_PATH=':memory:'
```

SQLite does not contain Kalshi API keys or private keys.

## Runtime architecture

```text
periodic/manual catalog REST sync
              ↓
contract matcher + relation graph
              ↓
transactional SQLite snapshot
              ↓
relation-relevant markets only
              ↓
┌────────────────────────┬────────────────────────┐
│ Polymarket public WS   │ Kalshi authenticated WS│
│ sharded connections   │ sharded connections    │
└────────────┬───────────┴────────────┬───────────┘
             ↓                        ↓
          normalized live books
                    ↓
        affected relation index only
                    ↓
      fee/depth-aware opportunity scan
                    ↓
          OPEN / UPDATE / CLOSE
                    ↓
          RAM + SQLite history
```

Settlement relations remain static between catalog refreshes; order-book changes never trigger a global rematch.

## Catalog refresh

A periodic catalog refresh is enabled by default every five minutes. It fetches open markets, rebuilds the relation graph, refreshes REST execution metadata/books, commits the new snapshot, and restarts live subscriptions if live mode was already running.

```bash
# Default: 300000 (5 minutes)
export PRED_MATCHER_CATALOG_REFRESH_MS=300000

# Disable periodic refresh.
export PRED_MATCHER_CATALOG_AUTO_REFRESH=false
```

When automatic catalog refresh is enabled and no durable snapshot exists, the service performs an initial sync after startup.

## WebSocket sharding

Large relation sets are split across multiple connections instead of sending one unbounded subscription request.

Defaults:

```bash
export PRED_MATCHER_POLYMARKET_WS_MARKETS_PER_CONNECTION=250
export PRED_MATCHER_KALSHI_WS_MARKETS_PER_CONNECTION=200
```

These are operational caps, not claims about venue hard limits. Tune them based on observed connection stability and venue guidance.

`GET /v1/live/status` reports both `subscribedMarkets` and `connections` per venue.

## Polymarket live feed

The service subscribes to the public CLOB market channel for the YES/NO asset IDs of markets participating in strong relations.

Behavior:

- full `book` messages replace the local side book;
- `price_change` messages update one level in place;
- `PING` is sent every 10 seconds;
- reconnects use bounded exponential backoff;
- after reconnect, incremental deltas are ignored until a fresh full `book` is received for that token.

No Polymarket credentials are required for this market-data feed.

## Kalshi live feed

Kalshi's orderbook WebSocket requires an authenticated handshake. Configure a read-only key with either a PEM file or inline PEM:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PATH='/run/secrets/kalshi-read-key.pem'
```

or:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PEM='-----BEGIN PRIVATE KEY-----\n...'
```

The private key is used only for the RSA-PSS WebSocket handshake signature and is never serialized into SQLite, JSONL history, logs, or API responses.

The subscription explicitly requests `use_yes_price: true`. Sequence gaps cause the affected market to wait for a fresh snapshot before later deltas are accepted.

Without credentials, Kalshi remains on the last REST snapshot and is explicitly reported as `DEGRADED`.

## Opportunity history

Incremental updates compare the previous and new opportunity set for affected relations only:

- `OPEN`: a previously absent net opportunity appears;
- `UPDATE`: a material execution metric changes;
- `CLOSE`: a previous opportunity is no longer net-profitable/executable.

Query history:

```bash
curl 'http://localhost:3000/v1/history?limit=100'
curl --get 'http://localhost:3000/v1/history' --data-urlencode 'opportunityId=EQUIVALENT_ARB:...'
```

SQLite history is durable. Optional append-only JSONL remains available as a secondary audit stream:

```bash
export PRED_MATCHER_HISTORY_FILE='./data/opportunity-history.jsonl'
```

## Auto-start live mode

```bash
export PRED_MATCHER_LIVE_AUTO_START=true
npm start
```

If durable state was restored, live subscriptions can start from that relation graph immediately. If no sync state exists, an initial REST sync is performed first.

## Health and observability

### `GET /health`

Returns version, last sync, SQLite status, catalog scheduler status, and live-scanner status. Returns `503` if durable persistence is unhealthy.

### `GET /ready`

Returns `200` only after a current or restored sync state exists and persistence is healthy. Otherwise returns `503`.

### `GET /metrics`

Prometheus text exposition including:

- market counts by venue;
- current relations/opportunities;
- persistence health/object counts;
- last sync timestamp;
- live updates/recomputations;
- connection/subscription counts;
- catalog refresh attempts/successes/failures/skips.

## API

### `POST /v1/sync`

Manual full catalog refresh. If live mode is running, subscriptions are restarted against the new relation graph.

### `GET /v1/catalog/status`

Returns scheduler interval, counters, last success/error, and current run state.

### `POST /v1/catalog/refresh`

Explicit catalog refresh alias with the same overlap protection as `/v1/sync`.

### `POST /v1/live/start`

Starts live market-data subscriptions.

### `POST /v1/live/stop`

Stops all venue streams.

### `GET /v1/live/status`

Returns per-venue connection state, shard count, subscription count, reconnects, latest message time, and incremental recomputation counters.

### `GET /v1/history?limit=100&opportunityId=...`

Returns recent lifecycle events, newest first.

### `GET /v1/markets?venue=polymarket|kalshi`

Returns current normalized market state.

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

Execution metrics are recalculated from the current books, so caller-specific size/freshness filters do not require a global rematch.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: first runnable cross-venue matcher MVP.
- `0.2.0`: structured contract parsing, verification, `SIMILAR`, and composed `IMPLIES` relations.
- `0.3.0`: top-of-book hydration and gross opportunity engine.
- `0.4.0`: full-depth VWAP, taker fees, freshness, target-size simulation, and net executable estimates.
- `0.5.0`: live WebSocket data, incremental relation-local recomputation, lifecycle history, and optional JSONL persistence.
- `0.6.0`: SQLite restart recovery, periodic catalog refresh, metrics/readiness, graceful shutdown, and sharded live subscriptions.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

`0.6.0` is still a scanner, not an atomic two-venue execution engine. Durable state and live data do not eliminate execution latency, partial-fill risk, capital/position constraints, venue pauses, account-specific fee differences, or settlement disputes.

The SQLite implementation is intentionally single-process. Running multiple writable replicas against the same database file is not a supported deployment model; a later distributed deployment should move the persistence interface to PostgreSQL or another shared transactional store.
