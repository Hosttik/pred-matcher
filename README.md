# pred-matcher

Prediction-market relation, contract verification, and net executable opportunity engine for Polymarket and Kalshi.

Current version: **0.4.0**.

## Scope

- Public Polymarket Gamma ingestion.
- Public Kalshi Markets API ingestion.
- Common normalized market model.
- Indexed title/subtitle candidate retrieval without a naive full cross-product.
- Structured contract parsing with field provenance (`venue`, `text`, `fallback`).
- Settlement verification using resolution sources, rules similarity, thresholds, deadlines, comparator families, and early-close conditions when available.
- Relations: `EQUIVALENT`, `SIMILAR`, `THRESHOLD_NESTED`, `TIME_NESTED`, `IMPLIES`.
- Full-depth Polymarket CLOB YES/NO order books for markets participating in strong relations.
- Full-depth Kalshi YES/NO books derived from public bid books.
- Venue fee metadata and taker-fee calculation.
- VWAP/slippage simulation for arbitrary target sizes.
- Quote freshness checks and stale-snapshot filtering.
- Maximum executable and maximum still-profitable size estimates.
- In-memory HTTP API for markets, parsed contracts, relations, and opportunities.

## Requirements

- Node.js 24+
- npm 11+

Pinned development versions:

- `@types/node 24.13.4`
- `tsx 4.23.13`
- `typescript 7.0.2`
- `vitest 5.0.0`

## Run

```bash
npm install
npm run dev
```

Then:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/v1/sync
curl 'http://localhost:3000/v1/markets?venue=polymarket'
curl --get 'http://localhost:3000/v1/contracts' --data-urlencode 'marketId=polymarket:MARKET_ID'
curl 'http://localhost:3000/v1/relations?type=IMPLIES'
curl 'http://localhost:3000/v1/opportunities?minNetEdge=0.01'
curl 'http://localhost:3000/v1/opportunities?targetShares=250&maxQuoteAgeMs=10000'
```

## Pipeline

```text
Polymarket + Kalshi
        ↓
normalized markets
        ↓
title/subtitle candidate retrieval
        ↓
structured contract parsing
        ↓
settlement verification
        ↓
relation graph
        ↓
relation-relevant full-depth books + fee metadata
        ↓
VWAP + taker-fee execution simulator
        ↓
net executable opportunities
```

Long settlement rules are deliberately excluded from the first retrieval score. They are used later by the verifier, so verbose but semantically equivalent contracts are not discarded too early.

## Relation semantics

### `EQUIVALENT`

No known contract differences and enough verification evidence to treat both contracts as equivalent.

### `SIMILAR`

The markets are related, but the verifier found a conflict or lacks enough evidence for a stronger relation. `SIMILAR` is never used by the opportunity engine.

### `THRESHOLD_NESTED`

Same underlying predicate and compatible settlement semantics, but one threshold is stricter than the other.

### `TIME_NESTED`

Same underlying predicate and compatible settlement semantics, but one deadline is earlier than the other.

### `IMPLIES`

Both threshold and/or time constraints establish a verified implication. Example:

```text
BTC > $160k by June 30  =>  BTC > $150k by December 31
```

## Executable opportunity semantics

For equivalent contracts, the engine evaluates both hedges:

```text
YES(A) + NO(B)
NO(A)  + YES(B)
```

For a verified implication `A => B`, it evaluates:

```text
NO(A) + YES(B)
```

Every valid state of the world pays at least `$1` per paired share. Unlike `0.3.0`, `0.4.0` does not stop at best asks. It walks both books level by level, calculates per-leg VWAP and taker fees, and only returns a positive opportunity when the simulated net cost remains below the guaranteed payout.

Each result includes:

```text
grossCostPerShare
grossEdgePerShare
maxExecutableShares
maxProfitableShares
bestExecution.shares
bestExecution.totalFees
bestExecution.netCost
bestExecution.netProfit
bestExecution.netEdgePerShare
oldestQuoteAt
quoteAgeMs
isStale
```

When `targetShares` is supplied, the result also contains `targetExecution` and only survives if that exact size is executable and net profitable.

## Fee model

### Polymarket

The service hydrates CLOB market info using the market `conditionId` and applies the venue taker curve:

```text
fee = contracts × feeRate × price × (1 - price)
```

The fee rate is taken from current CLOB market metadata. Fee-free markets remain explicitly supported as zero-fee rather than being treated as unknown.

### Kalshi

For standard quadratic event-contract fees:

```text
fee = round_up(multiplier × 0.07 × contracts × price × (1 - price))
```

The multiplier and fee type are resolved from event overrides and Series metadata. The current schedule rounds so `fee + positionCost` lands on a centicent.

`flat` or otherwise unresolved Kalshi fee schedules are intentionally **fail-closed**: those markets are not promoted to net executable opportunities until their fee model is explicitly implemented.

## Quote freshness

Polymarket books use the CLOB snapshot timestamp. Kalshi's public orderbook response does not expose a snapshot timestamp, so the service records local capture time when the response is received.

By default `/v1/opportunities` rejects books older than 15 seconds. Override with:

```text
maxQuoteAgeMs=5000
includeStale=true
```

`includeStale=true` is intended for diagnostics, not execution decisions.

## API

### `GET /health`

Returns service version and the most recent sync summary.

### `POST /v1/sync`

Fetches open markets, builds relations, and hydrates full-depth books plus fee metadata only for markets participating in strong relations.

### `GET /v1/markets?venue=polymarket|kalshi`

Returns the normalized market snapshot, including hydrated books and fee metadata when available.

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

The response reports `feesIncluded: true` and `depthIncluded: true`.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: first runnable cross-venue matcher MVP.
- `0.2.0`: structured contract parsing, verification, `SIMILAR`, and composed `IMPLIES` relations.
- `0.3.0`: top-of-book hydration and gross equivalent/implication opportunity engine.
- `0.4.0`: full-depth VWAP, venue taker fees, quote freshness, target-size simulation, and net executable opportunity estimates.
- Backward-compatible features increment `MINOR` while pre-1.0.
- Bug fixes increment `PATCH`.
- After `1.0.0`, breaking API/schema changes increment `MAJOR`.

## Important limitations

`0.4.0` is materially closer to execution reality, but it is still a scanner, not an atomic trading system. It does not guarantee that both legs will fill simultaneously. Network latency, book changes between snapshot and order placement, partial fills, venue pauses/cancellations, account-specific fee discounts, capital/position limits, and settlement disputes can still destroy an apparent arbitrage.

The service therefore treats stale or fee-unknown data conservatively and should not be used as an unattended auto-trader without an execution/risk layer.
