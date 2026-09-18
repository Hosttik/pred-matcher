# pred-matcher

Durable prediction-market semantic matcher and executable-opportunity scanner for Polymarket and Kalshi.

Current version: **0.16.0**.

## Scope

- Indexed cross-venue candidate retrieval and structured contract verification.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth books, fee-aware VWAP/slippage, quote freshness, and executable-size checks.
- Live Polymarket/Kalshi books with relation-local recomputation.
- SQLite/WAL operational state, labels, settlements, historical snapshots, and replay.
- Precision/recall/F1 and `falseArbRate` evaluation plus frozen CI regression gates.
- Pluggable semantic verifier with OpenAI and TypeSafe Jev providers in observational shadow mode.
- Historical multi-model A/B with prompt/model/matcher versioning, usage/cost accounting, and disagreement review.
- Statistical semantic promotion gate.
- Controlled semantic rollout with `DRY_RUN`, `AUTO`, `ENFORCED`, durable rollout evidence, cohort canaries, and latching circuit breakers.

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
GET  /v1/semantic/evidence
GET  /v1/semantic/events
GET  /v1/semantic/decisions
GET  /v1/semantic/cohorts
GET  /v1/semantic/attribution
GET  /v1/semantic/canary/status
POST /v1/semantic/circuit/reset
POST /v1/semantic/canary/reset?cohort=...
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
export PRED_MATCHER_SHADOW_PROVIDER=openai
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODEL='gpt-5.6-luna'
export PRED_MATCHER_SHADOW_MIN_CANDIDATE_SCORE=0.20
export PRED_MATCHER_SHADOW_MAX_PAIRS=50
export PRED_MATCHER_SHADOW_BATCH_SIZE=10

curl -X POST http://localhost:3000/v1/shadow/run
curl http://localhost:3000/v1/shadow/report
```

The verifier receives contract-semantic fields only: IDs, venue, title/subtitle, rules, resolution source, close time, and structured settlement/strike metadata. Prices and order books are excluded. OpenAI Responses requests use `store: false`, and runtime OpenAI API-key traffic is fixed to `https://api.openai.com/v1`.

TypeSafe Jev is also available as a shadow/evaluation provider:

```bash
export PRED_MATCHER_SHADOW_ENABLED=true
export PRED_MATCHER_SHADOW_PROVIDER=typesafe
export TYPESAFE_API_KEY='...'
export PRED_MATCHER_SHADOW_MODEL='jev-1.13.0'
curl -X POST http://localhost:3000/v1/shadow/run
```

The Jev adapter sends each contract pair as structured state and asks independent Noul questions for same-event identity, equivalence, both implication directions, threshold nesting, time nesting, and material settlement differences. A deterministic local combiner maps those calibrated probabilities into the existing relation types. The default is the pinned `jev-1.13.0`; aliases such as `jev-latest` are accepted but are not recommended for promotion evidence because aliases can move.

The prompt is versioned as `semantic-contract-v1`. Shadow observations also store the deterministic matcher version (`heuristic-v1`). Matcher provenance is independent from package SemVer; changing deterministic matcher semantics requires a matcher-version bump before promotion evidence can be reused.

## Historical shadow A/B

Historical evaluation is explicit and not part of normal sync:

```bash
export OPENAI_API_KEY='...'
export TYPESAFE_API_KEY='...'
export PRED_MATCHER_SHADOW_MODELS='openai:gpt-5.6-luna,typesafe:jev-1.13.0'
export PRED_MATCHER_SHADOW_BACKFILL_FRAMES=100
export PRED_MATCHER_SHADOW_BACKFILL_MAX_PAIRS=300
export PRED_MATCHER_SHADOW_BATCH_SIZE=10
npm run shadow:backfill
```

Every configured model receives the same deduplicated selected pair set. Entries in `PRED_MATCHER_SHADOW_MODELS` may be provider-qualified (`openai:model` or `typesafe:model`); unqualified names use `PRED_MATCHER_SHADOW_PROVIDER`, which defaults to OpenAI. Runs persist provider/prompt/model/matcher identity, token usage, cumulative latency, estimated cost, quality on overlapping gold labels, pairwise disagreement, and review candidates.

```bash
curl 'http://localhost:3000/v1/shadow/experiments?limit=20'
curl 'http://localhost:3000/v1/shadow/experiment?id=EXPERIMENT_ID'
curl 'http://localhost:3000/v1/shadow/review?experimentId=EXPERIMENT_ID&limit=100'
```

Cost accounting is an estimate, not billing truth. Unknown model IDs produce `estimatedCostUsd: null` instead of a guessed number.

## Semantic promotion gate

Promotion evaluates the **combined heuristic + semantic veto policy**, not the LLM as a replacement matcher. An arb-eligible heuristic relation survives only when the pinned semantic model returns the exact same relation type/direction at or above the configured confidence threshold. Non-arb relations are unchanged.

Default promotion requirements:

- exact model, prompt-version, and matcher-version pins;
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

Historical runs created before matcher-version provenance was introduced do not satisfy the current promotion gate. Run a fresh `shadow:backfill` before enabling semantic production rollout.

## Controlled veto rollout

Four rollout modes are supported:

- `OFF`: deterministic matcher only; no semantic production call.
- `DRY_RUN`: run semantic veto and compute what it would suppress, but persist the deterministic baseline.
- `AUTO`: start as `DRY_RUN`; after the configured global safe streak, enter enforcement. In `0.15.0`, AUTO enforcement is canary-gated by default.
- `ENFORCED`: apply semantic veto while promotion and runtime guards remain safe. Existing full-enforcement behavior is preserved unless canary is explicitly enabled.

`PRED_MATCHER_SEMANTIC_MODE=VETO_ONLY` remains a backward-compatible alias for `ENFORCED`.

Recommended rollout:

```bash
export OPENAI_API_KEY='...'
export PRED_MATCHER_SHADOW_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_MODEL='gpt-5.6-luna'
export PRED_MATCHER_PROMOTED_PROMPT_VERSION='semantic-contract-v1'
export PRED_MATCHER_PROMOTED_MATCHER_VERSION='heuristic-v1'

export PRED_MATCHER_SEMANTIC_MODE=AUTO
export PRED_MATCHER_AUTO_PROMOTION_SAFE_SYNCS=12
```

A global sync counts toward AUTO only when the formal promotion gate is eligible, the provider response is valid, veto rate stays within bounds, candidate opportunities are monotonic, and opportunity retention stays above the configured floor. An unsafe sync resets the global streak. State survives restart only when model/prompt/matcher pins still match.

Runtime safeguards:

```bash
export PRED_MATCHER_VETO_BATCH_SIZE=10
export PRED_MATCHER_VETO_MAX_RELATIONS=500
export PRED_MATCHER_VETO_MAX_RATE=0.35
export PRED_MATCHER_VETO_MIN_OPPORTUNITY_RETENTION=0.50
```

The semantic policy is remove-only: it can retain or remove heuristic arb relations, never add or upgrade one.

### Global circuit breaker

`ENFORCED`, including AUTO after promotion, rolls back to the deterministic baseline and latches the global circuit open when promotion/provider/runtime guards fail. The circuit does not auto-close:

```bash
curl -X POST http://localhost:3000/v1/semantic/circuit/reset
curl -X POST http://localhost:3000/v1/sync
```

## Cohort canary enforcement — v0.15.0

After global AUTO promotion, veto enforcement is partitioned by `relationType × venuePair`. Each cohort has an independent exposure stage, safe streak, error budget, and latching circuit. Default stages are:

```text
10% -> 25% -> 50% -> 100%
```

Stable SHA-256 sampling over `cohort|pairKey` determines which vetoed relations are in treatment, so assignments remain stable across syncs and restarts. Canary always starts from the deterministic relation graph and removes only sampled `VETOED` relations; it cannot introduce a new relation or opportunity.

Defaults:

```bash
# AUTO: enabled by default. ENFORCED: disabled unless explicitly true.
export PRED_MATCHER_CANARY_ENABLED=true
export PRED_MATCHER_CANARY_STAGES='0.10,0.25,0.50,1.0'
export PRED_MATCHER_CANARY_SAFE_SYNCS_PER_STAGE=6
export PRED_MATCHER_CANARY_MIN_DECISIONS=5
export PRED_MATCHER_CANARY_MAX_VETO_RATE=0.35
export PRED_MATCHER_CANARY_MIN_OPPORTUNITY_RETENTION=0.50
```

A cohort can advance only when it has enough current decisions and its full semantic candidate stays inside both cohort budgets: veto rate and opportunity retention. After the configured safe streak it advances one stage. A budget violation opens only that cohort's circuit and forces its exposure to 0%; other cohorts continue independently.

Inspect or reset canaries:

```bash
curl http://localhost:3000/v1/semantic/canary/status
curl -X POST 'http://localhost:3000/v1/semantic/canary/reset?cohort=EQUIVALENT%7Ckalshi-polymarket'
# Omit cohort to reset every cohort.
curl -X POST http://localhost:3000/v1/semantic/canary/reset
```

Canary state is embedded in durable `SyncResult` and rollout evidence. It is restored only when requested mode plus model/prompt/matcher pins still match. One-sync transition flags are cleared on restore, so restart does not synthesize duplicate stage/circuit events.

## Production rollout evidence

Every non-`OFF` semantic sync writes durable evidence to the quality SQLite database before the production snapshot is replaced. Evidence includes requested/effective mode, promotion eligibility, global safe streak/circuit, semantic opportunity impact, canary state, and one `CONFIRMED`/`VETOED` record per checked arb relation. Decision evidence also records whether a veto was actually enforced by the current canary sample.

```bash
curl 'http://localhost:3000/v1/semantic/evidence?limit=100'
curl 'http://localhost:3000/v1/semantic/events?limit=500'
curl 'http://localhost:3000/v1/semantic/decisions?action=VETOED&limit=1000'
curl 'http://localhost:3000/v1/semantic/cohorts?limit=5000'
curl 'http://localhost:3000/v1/semantic/attribution?limit=5000'
```

`/v1/semantic/events` includes global rollout transitions plus `CANARY_STAGE_ADVANCED` and `CANARY_CIRCUIT_OPENED`. Cohort analytics report proposed vetoes and actual enforced vetoes separately.

Attribution is deliberately conservative. `MANUAL`/`ADJUDICATED` labels can classify a veto as `CORRECT_VETO_BY_LABEL` or `FALSE_VETO_BY_LABEL`. Settlement outcomes can strongly falsify a relation (`PREVENTED_SETTLEMENT_VIOLATION`), but a consistent settlement is only `NOT_FALSIFIED_BY_SETTLEMENT`; one matching outcome does not prove semantic equivalence or implication.

## Observability

`GET /metrics` exposes global semantic mode/circuit/safe-streak metrics plus canary enabled state, aggregate exposure, eligible/enforced veto counts, stage advances, and cohort trips.

`GET /health` includes application/matcher versions and the latest durable sync. `GET /v1/semantic/status` includes current semantic and canary runtime status.

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
- `0.14.0`: durable rollout evidence, `AUTO` safe-streak promotion, transition events, cohort analytics, and conservative post-settlement veto attribution.
- `0.15.0`: stable cohort canary enforcement, staged exposure, independent cohort budgets/circuits, enforced-veto evidence, and canary metrics/API.
- `0.16.0`: TypeSafe Jev semantic verifier adapter, provider-selectable live shadow, and mixed-provider historical A/B.

Backward-compatible features increment `MINOR` while pre-1.0; bug fixes increment `PATCH`.

## Important limitations

This remains a scanner, not an atomic two-venue execution engine. Cross-venue fills can race and settlement/venue risk remains.

Historical capture is sampled rather than tick-complete. Promotion quality is bounded by adjudicated-label coverage and historical representativeness. Statistical gates, safe streaks, and canaries reduce measured rollout risk; they do not prove semantic correctness.

Semantic veto can only reduce the heuristic arb set. It cannot discover opportunities the deterministic matcher missed. Global circuit failure intentionally returns to the deterministic baseline; a cohort circuit returns only that cohort to baseline.

SQLite remains single-process; distributed deployment should move persistence interfaces to a shared transactional database.
