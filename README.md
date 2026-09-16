# pred-matcher

Durable live prediction-market matcher, contract verifier, executable-opportunity scanner, matcher-quality evaluator, and historical dataset/replay service for Polymarket and Kalshi.

Current version: **0.9.0**.

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
- Automatic historical market/relation snapshots with content-addressed deduplication.
- Hard-negative and uncertainty-based review queue.
- Historical replay using fixed, rematched, or originally captured relation graphs.
- Offline threshold calibration over accumulated historical frames and adjudicated labels.
- Frozen baseline regression gate in CI with explicit false-arbitrage protections.

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

Default databases:

```text
./data/pred-matcher.sqlite
./data/pred-matcher-quality.sqlite
./data/pred-matcher-dataset.sqlite
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

```bash
export PRED_MATCHER_DB_PATH='/var/lib/pred-matcher/state.sqlite'
export PRED_MATCHER_HISTORY_LIMIT=20000
export PRED_MATCHER_PERSISTENCE=true
```

Set `PRED_MATCHER_PERSISTENCE=false` for RAM-only operational state.

## Matcher-quality data

Relation labels and settlements live in a separate SQLite database:

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

For `IMPLIES`, `THRESHOLD_NESTED`, and `TIME_NESTED`, include `direction`. `type: "NONE"` is the hard-negative gold label. `PSEUDO` labels are excluded from `/v1/quality/report` unless `includePseudo=true` is explicitly requested.

Create/update a label:

```bash
curl -X POST http://localhost:3000/v1/quality/labels \
  -H 'content-type: application/json' \
  -d '{"leftId":"polymarket:a","rightId":"kalshi:b","type":"EQUIVALENT","source":"ADJUDICATED"}'
```

Evaluate the current graph:

```bash
curl http://localhost:3000/v1/quality/report
```

The report includes per-type and micro precision/recall/F1 plus `falseArbPredictions` and `falseArbRate`. False-arbitrage precision is the highest-priority matcher metric because false strong relations can create bad guaranteed-payout trades.

## Historical dataset capture

Automatic replay-ready capture uses a third SQLite database:

```bash
export PRED_MATCHER_DATASET_DB_PATH='/var/lib/pred-matcher/dataset.sqlite'
```

Defaults:

```bash
export PRED_MATCHER_DATASET_CAPTURE_MS=300000
export PRED_MATCHER_DATASET_MAX_SNAPSHOTS=576
export PRED_MATCHER_DATASET_AUTO_CAPTURE=true
```

Snapshots contain the normalized market catalog and relation graph observed at capture time. Storage is content-addressed: unchanged market/relation JSON is stored once in `market_versions` / `relation_versions`, while each snapshot references hashes. Retention deletes old snapshot links and garbage-collects unreferenced versions.

Manual capture and inspection:

```bash
curl -X POST http://localhost:3000/v1/dataset/capture
curl http://localhost:3000/v1/dataset/status
curl 'http://localhost:3000/v1/dataset/snapshots?limit=100'
curl 'http://localhost:3000/v1/dataset/frame?id=1'
```

## Review queue

Every capture runs a wider semantic candidate pass (`minimumCandidateScore=0.20`) and persists pairs worth human review. It does **not** automatically create labels.

Two candidate classes are stored:

- `HARD_NEGATIVE`: retrieval found a plausible pair but the verifier rejected a strong relation, or classified it only as `SIMILAR`.
- `UNCERTAIN_RELATION`: an arb-eligible relation was emitted below the review-confidence threshold.

The queue records first/last seen timestamps, observation count, maximum review priority, retrieval score, predicted relation/confidence, titles, and diagnostic reasons.

```bash
curl 'http://localhost:3000/v1/dataset/review?limit=100'
curl 'http://localhost:3000/v1/dataset/review?kind=HARD_NEGATIVE&unlabeled=true'
curl 'http://localhost:3000/v1/dataset/review?kind=UNCERTAIN_RELATION&unlabeled=false'
```

Adjudication still goes through `POST /v1/quality/labels`; the review queue never promotes a near-miss to `NONE`, `EQUIVALENT`, or another gold label by itself.

## Offline calibration

`0.9.0` adds an offline sweep over the historical dataset and adjudicated labels. The sweep varies both retrieval threshold and the minimum confidence accepted for arb-eligible relations. It does **not** automatically modify production matcher thresholds.

```bash
npm run quality:sweep
```

By default the command reads:

```text
./data/pred-matcher-dataset.sqlite
./data/pred-matcher-quality.sqlite
```

Useful controls:

```bash
export PRED_MATCHER_CALIBRATION_FRAMES=500
export PRED_MATCHER_CALIBRATION_CANDIDATE_SCORES='0.20,0.26,0.32,0.38,0.44'
export PRED_MATCHER_CALIBRATION_ARB_CONFIDENCES='0,0.72,0.76,0.80,0.84,0.88,0.92'
export PRED_MATCHER_CALIBRATION_MAX_FALSE_ARB_RATE=0
export PRED_MATCHER_CALIBRATION_MIN_RECALL=0.80
export PRED_MATCHER_CALIBRATION_MIN_ARB_PREDICTIONS=20
export PRED_MATCHER_CALIBRATION_MIN_LABELED_PAIRS=100
```

`PSEUDO` labels are excluded unless `PRED_MATCHER_CALIBRATION_INCLUDE_PSEUDO=true` is explicitly set.

The JSON report contains every threshold point, candidate/relation counts, the full matcher quality report, an eligibility flag, a Pareto frontier, and a recommended point among configurations that satisfy the configured policy. Recommendation is advisory; production thresholds remain unchanged until deliberately changed in code/config.

## Regression gate

CI runs:

```bash
npm run quality:gate
```

The gate evaluates the current matcher against `config/quality-regression-fixture.json` and compares it with a **frozen baseline prediction set** in the same fixture. The baseline is not recomputed using the candidate implementation; this prevents a matcher regression from redefining its own benchmark.

The committed fixture currently protects representative `EQUIVALENT`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`, and settlement-source-mismatch `SIMILAR` cases. Its default policy is fail-closed:

- `falseArbRate` must remain `0`;
- no increase in false-arbitrage rate is allowed;
- no micro precision drop is allowed;
- no micro recall drop is allowed;
- the fixture must still produce the expected number of arb-eligible predictions.

If a matcher change intentionally changes semantics, update the frozen fixture/baseline in the same reviewed change and explain why. Do not silently loosen the regression policy to make CI pass.

A different fixture can be tested with:

```bash
PRED_MATCHER_QUALITY_GATE_FIXTURE=./path/to/fixture.json npm run quality:gate
```

## Historical replay

Replay supports three modes:

- `FIXED_RELATIONS`: hold a supplied/current graph constant and isolate pricing/execution behavior.
- `REMATCH`: rerun the current candidate retrieval + matcher on every historical frame.
- `CAPTURED_RELATIONS`: use the relation graph stored with each historical frame, preserving what the matcher believed at that time.

Dataset-backed replay:

```bash
curl -X POST http://localhost:3000/v1/dataset/replay \
  -H 'content-type: application/json' \
  -d '{"mode":"CAPTURED_RELATIONS","limit":288,"minimumNetEdge":0,"maxQuoteAgeMs":15000,"includeStale":false}'
```

Optional `from` and `to` ISO timestamps select a historical window. `limit` is capped at 1000 frames per request.

## Settlement feedback

Store a resolved binary outcome:

```bash
curl -X POST http://localhost:3000/v1/quality/settlements \
  -H 'content-type: application/json' \
  -d '{"marketId":"kalshi:...","outcome":"YES","resolvedAt":"2026-09-16T10:00:00Z"}'
```

`GET /v1/quality/settlement-report` reports `CONSISTENT`, `VIOLATED`, or `INCONCLUSIVE`. This is intentionally negative-evidence oriented: a violating realized outcome is strong evidence against a relation; a non-violating outcome does not prove semantic equivalence.

## Catalog refresh and live data

Periodic refresh is enabled by default every five minutes:

```bash
export PRED_MATCHER_CATALOG_REFRESH_MS=300000
export PRED_MATCHER_CATALOG_AUTO_REFRESH=true
```

WebSocket sharding defaults:

```bash
export PRED_MATCHER_POLYMARKET_WS_MARKETS_PER_CONNECTION=250
export PRED_MATCHER_KALSHI_WS_MARKETS_PER_CONNECTION=200
```

Kalshi live market data requires read credentials:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PATH='/run/secrets/kalshi-read-key.pem'
```

Without credentials, Kalshi live mode reports `DEGRADED` and continues to expose the most recent REST snapshot.

## Health and observability

- `GET /health`: operational, quality, and dataset persistence status plus catalog/live/capture schedulers.
- `GET /ready`: `200` only after restored/current sync state exists and all SQLite stores are healthy.
- `GET /metrics`: Prometheus scanner/runtime metrics.
- `GET /v1/quality/status`: label/settlement database status.
- `GET /v1/dataset/status`: historical dataset database + capture scheduler status.

## API

Core:

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

Quality/replay:

- `GET /v1/quality/status`
- `GET /v1/quality/labels`
- `POST /v1/quality/labels`
- `GET /v1/quality/candidates?unlabeled=true`
- `GET /v1/quality/report?includePseudo=false`
- `GET /v1/quality/settlements`
- `POST /v1/quality/settlements`
- `GET /v1/quality/settlement-report`
- `POST /v1/replay`

Dataset:

- `GET /v1/dataset/status`
- `POST /v1/dataset/capture`
- `GET /v1/dataset/snapshots?limit=...&from=...&to=...`
- `GET /v1/dataset/frame?id=...`
- `GET /v1/dataset/review?limit=...&kind=...&unlabeled=true|false`
- `POST /v1/dataset/replay`

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: runnable cross-venue matcher MVP.
- `0.2.0`: structured contract verification and richer relation classes.
- `0.3.0`: top-of-book gross opportunity engine.
- `0.4.0`: full-depth VWAP, fees, freshness, and net executable estimates.
- `0.5.0`: live WebSocket scanner and incremental lifecycle history.
- `0.6.0`: durable operational state, refresh scheduler, observability, and WS sharding.
- `0.7.0`: durable relation labels, matcher-quality metrics, settlement feedback, and historical replay.
- `0.8.0`: automatic deduplicated historical dataset capture, review queues, and captured-relation replay.
- `0.9.0`: offline threshold calibration, Pareto quality analysis, frozen baseline regression fixture, and CI quality gate.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

`0.9.0` remains a scanner, not an atomic two-venue execution engine. Historical capture is sampled, not tick-complete, so replay cannot reconstruct opportunities shorter than the capture interval. Calibration quality is bounded by the coverage and correctness of adjudicated labels; a recommendation from a small or biased gold set must not be treated as proof of production safety.

The committed CI fixture is intentionally small and deterministic. It protects known semantic invariants but does not replace evaluation on the accumulated historical dataset. The SQLite stores are intentionally single-process; distributed deployment should move persistence interfaces to a shared transactional database.
