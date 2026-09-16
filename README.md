# pred-matcher

Durable prediction-market semantic matcher and executable-opportunity scanner for Polymarket and Kalshi.

Current version: **0.13.0**.

## Scope

- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth books, fee-aware VWAP/slippage, quote freshness, and executable-size checks.
- Live Polymarket/Kalshi books with relation-local recomputation.
- SQLite/WAL operational state, labels, settlements, historical snapshots, and replay.
- Precision/recall/F1 and `falseArbRate` evaluation plus frozen CI regression gates.
- OpenAI semantic verifier in observational shadow mode.
- Historical multi-model A/B with prompt/model/matcher versioning, usage/cost accounting, and disagreement review.
- Statistical semantic promotion gate.
- Controlled production rollout with `DRY_RUN`, `ENFORCED`, opportunity-impact accounting, and a latching circuit breaker.

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
GET  /v1/semantic/status
POST /v1/semantic/circuit/reset
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

Shadow output is observational only: it never replaces production relations and never creates an opportunity.

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

The OpenAI prompt is versioned as `semantic-contract-v1`. New shadow observations also store the deterministic matcher version (`heuristic-v1` in `0.13.0`). Matcher-version provenance is separate from the package version: any future semantic matcher change must bump that matcher version before promotion evidence can be reused.

## Historical shadow A/B

Historical evaluation is an explicit CLI operation, not part of normal sync:

```bash
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODELS='gpt-5.6-luna,gpt-5.6-terra'
export PRED_MATCHER_SHADOW_BACKFILL_FRAMES=100
export PRED_MATCHER_SHADOW_BACKFILL_MAX_PAIRS=300
export PRED_MATCHER_SHADOW_BATCH_SIZE=10
npm run shadow:backfill
```

Every configured model receives the same deduplicated selected pair set. Runs persist prompt/model/matcher identity, token usage, cumulative latency, estimated cost, quality on overlapping gold labels, pairwise model disagreement, and review candidates.

```bash
curl 'http://localhost:3000/v1/shadow/experiments?limit=20'
curl 'http://localhost:3000/v1/shadow/experiment?id=EXPERIMENT_ID'
curl 'http://localhost:3000/v1/shadow/review?experimentId=EXPERIMENT_ID&limit=100'
```

Cost accounting is an estimate, not billing truth. Unknown model IDs produce `estimatedCostUsd: null` instead of a guessed number.

## Semantic promotion gate

Promotion evaluates the **combined heuristic + semantic veto policy**, not the LLM as a replacement matcher. An arb-eligible heuristic relation survives only when the pinned semantic model returns the exact same relation type/direction at or above the configured confidence threshold. Non-arb relations are unchanged.

Default promotion requirements:

- exact model pin, prompt-version pin, and matcher-version pin;
- evidence no older than 7 days;
- at least 100 overlapping non-`PSEUDO` labeled pairs;
- at least 75 arb-eligible predictions retained after veto;
- 95% Wilson upper bound for candidate `falseArbRate` <= 5%;
- arb precision improvement of at least 0.1 percentage points over the heuristic baseline;
- no micro-precision regression;
- no recall regression.

The Wilson bound prevents a small `0/N` sample from being treated as zero risk. The retained-arb minimum prevents a trivial policy from looking perfect by vetoing nearly everything.

Pins are mandatory for deploy promotion:

```bash
export PRED_MATCHER_PROMOTED_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_PROMPT_VERSION='semantic-contract-v1'
export PRED_MATCHER_PROMOTED_MATCHER_VERSION='heuristic-v1'

npm run shadow:promotion
curl http://localhost:3000/v1/shadow/promotion
```

`npm run shadow:promotion` exits non-zero when the gate is ineligible or when the promoted matcher pin is not the current matcher version.

Useful policy controls:

```bash
export PRED_MATCHER_PROMOTION_MAX_EVIDENCE_AGE_MS=604800000
export PRED_MATCHER_PROMOTION_MIN_LABELED_PAIRS=100
export PRED_MATCHER_PROMOTION_MIN_ARB_PREDICTIONS=75
export PRED_MATCHER_PROMOTION_MAX_FALSE_ARB_UCB=0.05
export PRED_MATCHER_PROMOTION_MIN_ARB_PRECISION_GAIN=0.001
export PRED_MATCHER_PROMOTION_MIN_MICRO_PRECISION_DELTA=0
export PRED_MATCHER_PROMOTION_MIN_RECALL_DELTA=0
export PRED_MATCHER_PROMOTION_MIN_SEMANTIC_CONFIDENCE=0.80
export PRED_MATCHER_PROMOTION_CONFIDENCE_Z=1.96
```

Because `0.13.0` introduces matcher-version pinning, historical runs created before `0.13.0` do not satisfy the new promotion gate. Run a new `shadow:backfill` to generate matcher-pinned evidence before enabling enforcement.

## Controlled veto rollout — v0.13.0

Three rollout modes are supported:

- `OFF`: deterministic matcher only; no semantic production call.
- `DRY_RUN`: run semantic veto and compute what it would suppress, but persist the original deterministic relation graph and opportunities.
- `ENFORCED`: apply semantic veto only while the promotion gate is eligible and the circuit breaker remains closed.

The legacy value `PRED_MATCHER_SEMANTIC_MODE=VETO_ONLY` remains a backward-compatible alias for `ENFORCED`.

Recommended rollout:

```bash
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_PROMPT_VERSION='semantic-contract-v1'
export PRED_MATCHER_PROMOTED_MATCHER_VERSION='heuristic-v1'

export PRED_MATCHER_SEMANTIC_MODE=DRY_RUN
curl -X POST http://localhost:3000/v1/sync
curl http://localhost:3000/v1/semantic/status

# After reviewing dry-run impact and a passing promotion report:
export PRED_MATCHER_SEMANTIC_MODE=ENFORCED
```

Every semantic sync records baseline-vs-candidate opportunity impact:

- baseline and candidate opportunity counts;
- suppressed and unexpectedly introduced opportunities;
- opportunity retention rate;
- aggregate best-execution net profit of suppressed opportunities;
- maximum suppressed net edge per share.

Runtime safeguards:

```bash
export PRED_MATCHER_VETO_BATCH_SIZE=10
export PRED_MATCHER_VETO_MAX_RELATIONS=500
export PRED_MATCHER_VETO_MAX_RATE=0.35
export PRED_MATCHER_VETO_MIN_OPPORTUNITY_RETENTION=0.50
```

The semantic policy is monotonic by design: it can retain or remove heuristic arb relations, never add or upgrade one. A response batch must contain exactly one correctly oriented decision per requested pair.

### Circuit breaker

`ENFORCED` automatically rolls back to the deterministic baseline and latches the circuit open when any enforcement guard fails, including:

- promotion evidence expires or becomes ineligible after new adjudication;
- model/prompt/matcher pin mismatch;
- missing or failing semantic provider;
- malformed/incomplete semantic response;
- semantic relation safety limit exceeded;
- veto rate above `PRED_MATCHER_VETO_MAX_RATE`;
- opportunity retention below `PRED_MATCHER_VETO_MIN_OPPORTUNITY_RETENTION`;
- a non-monotonic candidate unexpectedly introduces an opportunity.

A circuit-open sync still writes the fresh deterministic baseline snapshot, so catalog freshness is preserved. `/health` reports the semantic rollout as degraded while the base service remains operational. `/ready` stays ready after a successful rollback sync.

The circuit state is included in durable `SyncResult` and restored on restart. It does **not** auto-close after a healthy sample; explicit reset is required:

```bash
curl -X POST http://localhost:3000/v1/semantic/circuit/reset
curl -X POST http://localhost:3000/v1/sync
```

The reset alone does not prove the next sync safe. In `ENFORCED`, the following sync still has to pass all promotion and runtime guards before the semantic candidate becomes effective.

## Observability

`GET /metrics` includes semantic rollout gauges for requested/effective mode, circuit state, veto rate, opportunity retention, and suppressed opportunity count.

`GET /health` includes current app version, matcher version, semantic status, promotion evidence status, and circuit state.

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
- `0.12.0`: statistical semantic promotion gate and opt-in semantic veto policy.
- `0.13.0`: matcher-pinned/expiring promotion evidence, dry-run vs enforced rollout, opportunity-impact accounting, and latching circuit breaker.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

This remains a scanner, not an atomic two-venue execution engine. Cross-venue fills can race and settlement/venue risk remains.

Historical capture is sampled rather than tick-complete. Promotion quality is bounded by adjudicated-label coverage and historical representativeness. A passing statistical gate reduces measured risk; it does not prove semantic correctness.

Semantic veto can only reduce the heuristic arb set. It cannot discover opportunities the deterministic matcher missed. When the circuit opens, production intentionally returns to that deterministic baseline.

SQLite remains single-process; distributed deployment should move persistence interfaces to a shared transactional database.
