# pred-matcher

Durable live prediction-market relation, contract-verification, matcher-quality, historical-replay, and net executable opportunity scanner for Polymarket and Kalshi.

Current version: **0.7.0**.

## Scope

- Polymarket + Kalshi catalog ingestion.
- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth books, venue fee metadata, VWAP/slippage simulation, quote freshness, and target-size execution checks.
- Live Polymarket and authenticated Kalshi order-book streaming.
- Relation-local incremental opportunity recomputation.
- Durable SQLite operational state and restart recovery.
- Periodic catalog refresh, readiness, Prometheus metrics, graceful shutdown, and WebSocket sharding.
- Durable relation-label dataset with `MANUAL`, `ADJUDICATED`, and `PSEUDO` provenance.
- Matcher precision/recall/F1 and false-arbitrage-rate reporting.
- Settlement-consistency feedback for resolved binary markets.
- Historical replay in fixed-relation or full-rematch mode with opportunity lifetime/session statistics.

## Requirements

- Node.js **24.15+**
- npm 11+

The service uses Node's built-in `node:sqlite`; no native SQLite npm dependency is required.

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

Default operational database:

```text
./data/pred-matcher.sqlite
```

Default matcher-quality database:

```text
./data/pred-matcher-quality.sqlite
```

Manual catalog sync:

```bash
curl -X POST http://localhost:3000/v1/sync
```

Start live scanning:

```bash
curl -X POST http://localhost:3000/v1/live/start
curl http://localhost:3000/v1/live/status
```

## Durable operational state

`0.6.0+` persists markets, relations, current opportunities, lifecycle history, and last sync state in SQLite/WAL. A full sync replaces the catalog snapshot transactionally; live price changes use incremental writes.

Configuration:

```bash
export PRED_MATCHER_DB_PATH='/var/lib/pred-matcher/state.sqlite'
export PRED_MATCHER_HISTORY_LIMIT=20000
export PRED_MATCHER_PERSISTENCE=true
```

Set `PRED_MATCHER_PERSISTENCE=false` for RAM-only operational state.

## Matcher-quality dataset

`0.7.0` deliberately separates evaluation data from runtime scanner state. Relation labels and settlements are stored in a second SQLite database:

```bash
export PRED_MATCHER_QUALITY_DB_PATH='/var/lib/pred-matcher/quality.sqlite'
```

A label represents the adjudicated semantic relation for one market pair:

```json
{
  "leftId": "polymarket:...",
  "rightId": "kalshi:...",
  "type": "EQUIVALENT",
  "source": "ADJUDICATED",
  "labeledAt": "2026-09-16T10:00:00Z",
  "notes": "resolution rules checked manually"
}
```

For directed relations (`IMPLIES`, `THRESHOLD_NESTED`, `TIME_NESTED`) include:

```json
{
  "direction": "LEFT_IMPLIES_RIGHT"
}
```

`type: "NONE"` is the hard-negative label for pairs that should not be related. `PSEUDO` labels are stored separately from gold labels: `/v1/quality/report` excludes them unless `includePseudo=true` is explicitly requested.

This prevents third-party/model confidence from being silently treated as ground truth.

## Matcher quality metrics

Create/update a label:

```bash
curl -X POST http://localhost:3000/v1/quality/labels \
  -H 'content-type: application/json' \
  -d '{"leftId":"polymarket:a","rightId":"kalshi:b","type":"EQUIVALENT","source":"ADJUDICATED"}'
```

Inspect unlabeled current predictions:

```bash
curl 'http://localhost:3000/v1/quality/candidates?unlabeled=true'
```

Evaluate the current relation graph against gold labels:

```bash
curl http://localhost:3000/v1/quality/report
```

The report includes:

- labeled and predicted pair counts;
- exact relation matches;
- wrong type/direction count;
- missing predictions;
- per-relation precision, recall, and F1;
- micro precision, recall, and F1;
- `falseArbPredictions` and `falseArbRate` for strong relation classes capable of producing guaranteed-payout trades.

False-arbitrage precision should be treated as the highest-priority matcher metric because a false positive can directly create a bad trade.

## Settlement feedback

Store a resolved binary outcome:

```bash
curl -X POST http://localhost:3000/v1/quality/settlements \
  -H 'content-type: application/json' \
  -d '{"marketId":"kalshi:...","outcome":"YES","resolvedAt":"2026-09-16T10:00:00Z"}'
```

Supported outcomes: `YES`, `NO`, `INVALID`.

Evaluate current relations against stored settlements:

```bash
curl http://localhost:3000/v1/quality/settlement-report
```

Interpretation is intentionally conservative:

- `VIOLATED`: observed outcomes contradict the claimed logical relation; this is strong negative evidence.
- `CONSISTENT`: observed outcomes do not contradict the relation; this does **not** prove semantic equivalence or implication.
- `INCONCLUSIVE`: missing/invalid settlement or a relation such as `SIMILAR` with no strict logical settlement constraint.

For `A ⇒ B`, only `A=YES, B=NO` is a violation.

## Historical replay

`POST /v1/replay` accepts ordered or unordered historical market snapshots and replays opportunity detection using each frame's own timestamp for quote freshness.

Two modes are supported:

- `FIXED_RELATIONS`: hold a supplied/current relation graph constant and isolate the pricing/execution engine.
- `REMATCH`: rerun candidate retrieval + matcher independently on every frame to measure relation churn and end-to-end historical behavior.

Example:

```json
{
  "mode": "FIXED_RELATIONS",
  "frames": [
    {
      "capturedAt": "2026-09-16T10:00:00Z",
      "markets": []
    }
  ],
  "minimumNetEdge": 0,
  "maxQuoteAgeMs": 15000,
  "includeStale": false
}
```

The replay report includes:

- frame count and per-frame market/relation/opportunity counts;
- candidate-pair and relation observations in rematch mode;
- unique relations;
- opportunity observations and unique opportunities;
- open/close counts;
- per-opportunity sessions, first/last seen timestamps, total visible duration, peak net edge/profit, and max profitable size.

A single opportunity ID can have multiple sessions when it disappears and later reopens.

## Catalog refresh

Periodic refresh is enabled by default every five minutes:

```bash
export PRED_MATCHER_CATALOG_REFRESH_MS=300000
export PRED_MATCHER_CATALOG_AUTO_REFRESH=true
```

A refresh rebuilds the relation graph and REST execution snapshot. If live mode is already active, subscriptions restart against the new relation-relevant market set.

## WebSocket sharding

Defaults:

```bash
export PRED_MATCHER_POLYMARKET_WS_MARKETS_PER_CONNECTION=250
export PRED_MATCHER_KALSHI_WS_MARKETS_PER_CONNECTION=200
```

These are operational caps rather than claims about venue hard limits.

## Kalshi live credentials

Kalshi's market-data WebSocket requires authentication:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PATH='/run/secrets/kalshi-read-key.pem'
```

or:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PEM='-----BEGIN PRIVATE KEY-----\n...'
```

Without credentials, Kalshi live mode reports `DEGRADED` and continues to expose the most recent REST snapshot.

## Health and observability

- `GET /health`: operational persistence, quality persistence, catalog scheduler, live state, version.
- `GET /ready`: `200` only after restored/current sync state exists and both SQLite stores are healthy.
- `GET /metrics`: Prometheus exposition for scanner/runtime metrics.
- `GET /v1/quality/status`: matcher-quality database status and label/settlement counts.

## Core API

- `POST /v1/sync`
- `GET /v1/catalog/status`
- `POST /v1/catalog/refresh`
- `POST /v1/live/start`
- `POST /v1/live/stop`
- `GET /v1/live/status`
- `GET /v1/history`
- `GET /v1/markets`
- `GET /v1/contracts`
- `GET /v1/relations`
- `GET /v1/opportunities`

## Quality/replay API

- `GET /v1/quality/status`
- `GET /v1/quality/labels`
- `POST /v1/quality/labels`
- `GET /v1/quality/candidates?unlabeled=true`
- `GET /v1/quality/report?includePseudo=false`
- `GET /v1/quality/settlements`
- `POST /v1/quality/settlements`
- `GET /v1/quality/settlement-report`
- `POST /v1/replay`

Replay request bodies are capped at 25 MB; other quality mutations are capped at 2 MB.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: runnable cross-venue matcher MVP.
- `0.2.0`: structured contract verification and richer relation classes.
- `0.3.0`: top-of-book gross opportunity engine.
- `0.4.0`: full-depth VWAP, fees, freshness, and net executable estimates.
- `0.5.0`: live WebSocket scanner and incremental lifecycle history.
- `0.6.0`: durable operational state, refresh scheduler, observability, and WS sharding.
- `0.7.0`: durable relation labels, matcher-quality metrics, settlement feedback, and historical replay.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

`0.7.0` remains a scanner, not an atomic two-venue execution engine. Replay quality depends on the fidelity and cadence of captured historical books. Settlement consistency is negative-evidence oriented: a non-violating realized outcome cannot prove that two contracts had identical resolution semantics.

The SQLite stores are intentionally single-process. Multiple writable replicas sharing one database file are not a supported deployment model; distributed deployment should move the persistence interfaces to a shared transactional database.
