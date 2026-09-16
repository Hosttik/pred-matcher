# pred-matcher

Durable prediction-market semantic matcher and executable-opportunity scanner for Polymarket and Kalshi.

Current version: **0.11.0**.

## Scope

- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth books, fee-aware VWAP/slippage, quote freshness, and executable-size checks.
- Live Polymarket/Kalshi books with relation-local recomputation.
- SQLite/WAL operational state, labels, settlements, historical snapshots, and replay.
- Precision/recall/F1 and `falseArbRate` evaluation plus frozen CI regression gates.
- Optional OpenAI semantic verifier in shadow mode with no production influence.
- Historical multi-model shadow A/B with prompt versioning, token/cost/latency accounting, and disagreement review.

## Requirements

- Node.js **24.15+**
- npm 11+

The service uses Node's built-in `node:sqlite`.

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
curl -X POST http://localhost:3000/v1/sync
```

Default databases:

```text
./data/pred-matcher.sqlite
./data/pred-matcher-quality.sqlite
./data/pred-matcher-dataset.sqlite
```

## Production scanner

The production relation graph remains deterministic. `SIMILAR` is never arb-eligible. Opportunities use executable ask-side liquidity, full depth, fees, and quote freshness.

Core endpoints:

```text
GET  /health
GET  /ready
GET  /metrics
POST /v1/sync
GET  /v1/markets
GET  /v1/contracts?marketId=...
GET  /v1/relations
GET  /v1/opportunities
GET  /v1/history
```

Start live scanning:

```bash
curl -X POST http://localhost:3000/v1/live/start
curl http://localhost:3000/v1/live/status
```

Kalshi live books require read credentials:

```bash
export KALSHI_API_KEY_ID='...'
export KALSHI_PRIVATE_KEY_PATH='/run/secrets/kalshi-read-key.pem'
```

Without them Kalshi live mode reports `DEGRADED` and retains the latest REST snapshot.

## Persistence, quality, and historical data

```bash
export PRED_MATCHER_DB_PATH='/var/lib/pred-matcher/state.sqlite'
export PRED_MATCHER_QUALITY_DB_PATH='/var/lib/pred-matcher/quality.sqlite'
export PRED_MATCHER_DATASET_DB_PATH='/var/lib/pred-matcher/dataset.sqlite'
export PRED_MATCHER_HISTORY_LIMIT=20000
```

Gold relation labels use `MANUAL` or `ADJUDICATED` provenance. `PSEUDO` labels are excluded from normal quality/calibration/shadow A/B scoring unless explicitly requested by the corresponding legacy quality endpoint.

```bash
curl -X POST http://localhost:3000/v1/quality/labels \
  -H 'content-type: application/json' \
  -d '{"leftId":"polymarket:a","rightId":"kalshi:b","type":"EQUIVALENT","source":"ADJUDICATED"}'

curl http://localhost:3000/v1/quality/report
```

Historical capture stores content-addressed market/relation versions and snapshot links:

```bash
curl -X POST http://localhost:3000/v1/dataset/capture
curl 'http://localhost:3000/v1/dataset/snapshots?limit=100'
curl 'http://localhost:3000/v1/dataset/review?limit=100'
```

Replay supports `FIXED_RELATIONS`, `REMATCH`, and `CAPTURED_RELATIONS`.

## Calibration and regression gate

```bash
npm run quality:sweep
npm run quality:gate
```

Calibration is advisory and never changes production thresholds automatically. CI's frozen fixture fails on configured false-arbitrage, precision, or recall regressions.

## Semantic verifier shadow mode

Shadow output is **observational only**: it never replaces production relations, never creates an opportunity, and provider failure does not fail catalog sync.

```bash
export PRED_MATCHER_SHADOW_ENABLED=true
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODEL='gpt-5.6-luna'
export PRED_MATCHER_SHADOW_MIN_CANDIDATE_SCORE=0.20
export PRED_MATCHER_SHADOW_MAX_PAIRS=50
export PRED_MATCHER_SHADOW_BATCH_SIZE=10

curl -X POST http://localhost:3000/v1/shadow/run
curl http://localhost:3000/v1/shadow/report
```

The verifier receives contract-semantic fields only: IDs, venue, title/subtitle, rules, resolution source, close time, and structured settlement/strike metadata. Prices and order books are excluded. OpenAI Responses requests use `store: false`, and runtime API-key traffic is fixed to `https://api.openai.com/v1`.

The model is not shown the heuristic prediction. The prompt used by the OpenAI provider is explicitly versioned as `semantic-contract-v1`.

## Historical shadow A/B — v0.11.0

Historical evaluation is an explicit CLI operation, not part of normal sync, so multi-model spend cannot start accidentally:

```bash
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODELS='gpt-5.6-luna,gpt-5.6-terra'
export PRED_MATCHER_SHADOW_BACKFILL_FRAMES=100
export PRED_MATCHER_SHADOW_BACKFILL_MAX_PAIRS=300
export PRED_MATCHER_SHADOW_BATCH_SIZE=10
npm run shadow:backfill
```

If `PRED_MATCHER_SHADOW_MODELS` is omitted, the CLI uses `PRED_MATCHER_SHADOW_MODEL`, then falls back to the single model `gpt-5.6-luna`.

The experiment runner:

1. loads saved dataset frames;
2. retrieves and prioritizes semantic candidate pairs;
3. deduplicates by pair and gives **the same selected pair set** to every model;
4. records one model run per verifier under a common `experimentId`;
5. evaluates heuristic and model predictions only on overlapping non-`PSEUDO` gold labels;
6. compares exact relation+direction signatures model-to-model;
7. creates review candidates for gold-label, model-model, and model-heuristic disagreements.

Inspect experiments and review candidates:

```bash
curl 'http://localhost:3000/v1/shadow/experiments?limit=20'
curl 'http://localhost:3000/v1/shadow/experiment?id=EXPERIMENT_ID'
curl 'http://localhost:3000/v1/shadow/review?experimentId=EXPERIMENT_ID&limit=100'
```

### Usage and cost accounting

Each shadow run records request count, input/cached/cache-write/output/total tokens, cumulative request latency, and estimated USD cost.

Cost is an **estimate, not billing truth**. `0.11.0` uses the pricing snapshot **2026-09-16** for exact known model IDs:

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 |
| `gpt-5.6-terra` | $2.00 | $0.20 | $12.00 |
| `gpt-5.6-sol` / `gpt-5.6` | $4.00 | $0.40 | $20.00 |

Cache-write tokens are estimated at 1.25× the uncached-input price. Unknown model IDs return `estimatedCostUsd: null` instead of guessing. OpenAI billing remains authoritative, and future pricing or special long-context pricing can differ from this snapshot.

Official references used for this snapshot:

- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/models/gpt-5.6-sol

## Shadow API

```text
GET  /v1/shadow/status
POST /v1/shadow/run
GET  /v1/shadow/runs?limit=...
GET  /v1/shadow/observations?limit=...&runId=...
GET  /v1/shadow/report?runId=...
GET  /v1/shadow/experiments?limit=...
GET  /v1/shadow/experiment?id=...
GET  /v1/shadow/review?experimentId=...&limit=...
```

Shadow observations/review candidates never become gold labels automatically.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: runnable matcher MVP.
- `0.2.0`: structured contract verification.
- `0.3.0`: gross opportunity engine.
- `0.4.0`: full-depth fee-aware executable estimates.
- `0.5.0`: live WebSocket scanner.
- `0.6.0`: durable state and observability.
- `0.7.0`: labels, quality metrics, settlement feedback, replay.
- `0.8.0`: historical dataset capture and review queue.
- `0.9.0`: offline calibration and CI regression gate.
- `0.10.0`: semantic verifier shadow mode.
- `0.11.0`: historical shadow backfill, model A/B, prompt versioning, usage/cost accounting, disagreement review.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

This remains a scanner, not an atomic two-venue execution engine. Cross-venue fills can race and settlement/venue risk remains.

Historical capture is sampled rather than tick-complete. Historical shadow experiments currently deduplicate repeated frames by market pair rather than evaluating every semantic version of the same pair.

LLM confidence is not semantic truth. Shadow output stays non-production until enough adjudicated coverage demonstrates better precision/recall without increasing `falseArbRate`. Pricing estimates are informational only. SQLite remains single-process; distributed deployment should move persistence interfaces to a shared transactional database.
