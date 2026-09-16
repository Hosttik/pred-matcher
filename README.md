# pred-matcher

Durable prediction-market semantic matcher and executable-opportunity scanner for Polymarket and Kalshi.

Current version: **0.12.0**.

## Scope

- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth books, fee-aware VWAP/slippage, quote freshness, and executable-size checks.
- Live Polymarket/Kalshi books with relation-local recomputation.
- SQLite/WAL operational state, labels, settlements, historical snapshots, and replay.
- Precision/recall/F1 and `falseArbRate` evaluation plus frozen CI regression gates.
- OpenAI semantic verifier in observational shadow mode.
- Historical multi-model A/B with prompt versioning, usage/cost accounting, and disagreement review.
- Statistical promotion gate and opt-in `VETO_ONLY` production policy that can remove, but never create, arb-eligible relations.

## Requirements

- Node.js **24.15+**
- npm 11+

The service uses Node's built-in `node:sqlite`.

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

By default (`PRED_MATCHER_SEMANTIC_MODE=OFF`) the production relation graph is deterministic. `SIMILAR` is never arb-eligible. Opportunities use executable ask-side liquidity, full depth, fees, and quote freshness.

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

Gold relation labels use `MANUAL` or `ADJUDICATED` provenance. `PSEUDO` labels are excluded from promotion decisions.

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

Shadow output is observational only: it never replaces production relations, never creates an opportunity, and provider failure does not fail catalog sync.

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

The model is not shown the heuristic prediction. The OpenAI prompt is versioned as `semantic-contract-v1`.

## Historical shadow A/B

Historical evaluation is an explicit CLI operation, not part of normal sync, so multi-model spend cannot start accidentally:

```bash
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODELS='gpt-5.6-luna,gpt-5.6-terra'
export PRED_MATCHER_SHADOW_BACKFILL_FRAMES=100
export PRED_MATCHER_SHADOW_BACKFILL_MAX_PAIRS=300
export PRED_MATCHER_SHADOW_BATCH_SIZE=10
npm run shadow:backfill
```

Every configured model receives the same deduplicated selected pair set. Runs persist prompt/model identity, token usage, cumulative latency, estimated cost, quality on overlapping gold labels, pairwise model disagreement, and review candidates.

Inspect results:

```bash
curl 'http://localhost:3000/v1/shadow/experiments?limit=20'
curl 'http://localhost:3000/v1/shadow/experiment?id=EXPERIMENT_ID'
curl 'http://localhost:3000/v1/shadow/review?experimentId=EXPERIMENT_ID&limit=100'
```

Cost accounting is an estimate, not billing truth. Known model rates are tied to the pricing snapshot stored in code; unknown model IDs produce `estimatedCostUsd: null` instead of a guessed number.

## Shadow promotion gate — v0.12.0

Promotion evaluates the **combined veto policy**, not the LLM as a replacement matcher. For each labeled historical pair, the baseline is the heuristic relation recorded with the shadow observation. An arb-eligible heuristic relation survives the candidate policy only when the pinned semantic model returns the exact same relation type/direction at or above the configured confidence threshold. Non-arb relations are unchanged.

The default policy requires:

- exact model pin and prompt-version pin;
- at least 100 overlapping non-`PSEUDO` labeled pairs;
- at least 75 arb-eligible predictions retained after veto;
- 95% Wilson upper bound for candidate `falseArbRate` <= 5%;
- arb precision improvement of at least 0.1 percentage points over the heuristic baseline;
- no micro-precision regression;
- no recall regression.

The Wilson bound prevents a small `0/N` sample from being treated as zero risk. The retained-arb minimum prevents a trivial policy from looking perfect by vetoing nearly everything.

Pins are mandatory for production promotion:

```bash
export PRED_MATCHER_PROMOTED_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_PROMPT_VERSION='semantic-contract-v1'

npm run shadow:promotion
curl http://localhost:3000/v1/shadow/promotion
```

`npm run shadow:promotion` exits non-zero when the gate is not eligible, making it suitable for a deployment check. Useful policy controls:

```bash
export PRED_MATCHER_PROMOTION_MIN_LABELED_PAIRS=100
export PRED_MATCHER_PROMOTION_MIN_ARB_PREDICTIONS=75
export PRED_MATCHER_PROMOTION_MAX_FALSE_ARB_UCB=0.05
export PRED_MATCHER_PROMOTION_MIN_ARB_PRECISION_GAIN=0.001
export PRED_MATCHER_PROMOTION_MIN_MICRO_PRECISION_DELTA=0
export PRED_MATCHER_PROMOTION_MIN_RECALL_DELTA=0
export PRED_MATCHER_PROMOTION_MIN_SEMANTIC_CONFIDENCE=0.80
export PRED_MATCHER_PROMOTION_CONFIDENCE_Z=1.96
```

### VETO_ONLY production mode

`VETO_ONLY` is opt-in and fail-closed:

```bash
export OPENAI_API_KEY='...'
export PRED_MATCHER_PROMOTED_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_PROMPT_VERSION='semantic-contract-v1'
export PRED_MATCHER_SEMANTIC_MODE=VETO_ONLY

# Optional runtime controls.
export PRED_MATCHER_VETO_BATCH_SIZE=10
export PRED_MATCHER_VETO_MAX_RELATIONS=500
```

During catalog sync the deterministic matcher runs first. Only its arb-eligible relations are sent to the pinned verifier. A relation is retained only on exact type+direction agreement and sufficient semantic confidence. The verifier cannot add a relation or upgrade `SIMILAR`/`NONE` into an arb relation.

When `VETO_ONLY` is configured, any of the following aborts the new sync before `store.replace(...)`: promotion gate failure, missing provider configuration, model/prompt pin mismatch, relation-count safety limit, timeout/refusal/provider error, or malformed verifier output. The previous durable snapshot therefore remains in place. `/ready` remains `503` until a snapshot has successfully passed the configured veto policy.

## Shadow API

```text
GET  /v1/shadow/status
GET  /v1/shadow/promotion
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
- `0.12.0`: statistical semantic promotion gate and fail-closed `VETO_ONLY` production policy.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

This remains a scanner, not an atomic two-venue execution engine. Cross-venue fills can race and settlement/venue risk remains.

Historical capture is sampled rather than tick-complete. Promotion quality is bounded by adjudicated-label coverage and by the representativeness of historical candidate selection. A passing statistical gate reduces measured risk; it does not prove semantic correctness.

`VETO_ONLY` can only reduce the current heuristic arb set. It cannot discover opportunities the deterministic matcher missed. External verifier availability becomes part of catalog-refresh availability only when `VETO_ONLY` is explicitly enabled.

SQLite remains single-process; distributed deployment should move persistence interfaces to a shared transactional database.
