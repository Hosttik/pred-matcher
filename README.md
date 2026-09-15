# pred-matcher

Prediction-market relation, contract verification, and gross opportunity engine for Polymarket and Kalshi.

Current version: **0.3.0**.

## Scope

- Public Polymarket Gamma ingestion.
- Public Kalshi Markets API ingestion.
- Common normalized market model.
- Indexed title/subtitle candidate retrieval without a naive full cross-product.
- Structured contract parsing with field provenance (`venue`, `text`, `fallback`).
- Settlement verification using resolution sources, rules similarity, thresholds, deadlines, comparator families, and early-close conditions when available.
- Relations:
  - `EQUIVALENT`
  - `SIMILAR`
  - `THRESHOLD_NESTED`
  - `TIME_NESTED`
  - `IMPLIES`
- Polymarket CLOB YES/NO top-of-book hydration for markets participating in strong relations.
- Kalshi YES/NO top-of-book prices and sizes.
- Gross opportunity detection for equivalent and implication relations.
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
curl 'http://localhost:3000/v1/opportunities?minGrossEdge=0.01'
```

## Matching pipeline

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
relation-relevant order books
        ↓
gross opportunity engine
```

Long settlement rules are deliberately excluded from the first retrieval score. They are used later by the verifier, so verbose but semantically equivalent contracts are not discarded too early.

## Contract model

A parsed contract can contain:

```json
{
  "subjectText": "above bitcoin",
  "predicateText": "will bitcoin be above 150000 by december 31 2026",
  "threshold": 150000,
  "comparator": ">",
  "deadline": "2026-12-31T23:59:59.000Z",
  "resolutionSource": "coinbase.com",
  "fieldSources": {
    "threshold": "venue",
    "comparator": "venue",
    "deadline": "text",
    "resolutionSource": "venue"
  }
}
```

Venue-provided structured fields take precedence over text extraction. A technical market close time is treated only as a fallback deadline and is explicitly marked as such.

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

Both threshold and time constraints tighten in the same logical direction. Example:

```text
BTC > $160k by June 30  =>  BTC > $150k by December 31
```

## Gross opportunity semantics

`0.3.0` uses buyable **ask** prices rather than midpoint or last trade prices.

For equivalent contracts, it checks both hedges:

```text
YES(A) + NO(B)
NO(A)  + YES(B)
```

For a verified implication `A => B`, it checks:

```text
NO(A) + YES(B)
```

Every valid state of the world pays at least `$1` per paired share. A gross opportunity exists only when the combined asks cost less than `$1`.

When both legs have top-of-book sizes, the service also reports:

```text
maxShares = min(size leg 1, size leg 2)
grossProfitAtTop = grossEdgePerShare * maxShares
```

### Fees are not included yet

This is deliberate. Kalshi fees are series-dependent, while Polymarket exposes market-specific fee configuration. `0.3.0` stores available fee metadata but does not yet apply venue fee formulas.

Therefore every opportunity contains:

```json
{
  "fees": {
    "status": "NOT_INCLUDED"
  }
}
```

and the `/v1/opportunities` response includes `"feesIncluded": false`.

A positive `grossEdgePerShare` is a **gross arbitrage candidate**, not a claim of positive net executable profit.

## API

### `GET /health`

Returns service version and the most recent sync summary.

### `POST /v1/sync`

Fetches open markets, matches contracts, verifies relations, hydrates Polymarket CLOB books only for markets in strong relations, and computes gross opportunities.

### `GET /v1/markets?venue=polymarket|kalshi`

Returns the current normalized market snapshot, including hydrated top-of-book fields when available.

### `GET /v1/contracts?marketId=...`

Returns the structured contract representation for one market.

### `GET /v1/relations?type=...`

Returns detected relations and verification evidence.

### `GET /v1/opportunities?type=...&minGrossEdge=...`

Returns positive gross opportunities sorted by gross edge per share.

Supported `type` values:

- `EQUIVALENT_ARB`
- `IMPLICATION_ARB`

`minGrossEdge` is expressed in dollars per paired share. For example, `0.02` means at least 2 cents of gross edge before fees.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: first runnable cross-venue matcher MVP.
- `0.2.0`: structured contract parsing, verification, `SIMILAR`, and composed `IMPLIES` relations.
- `0.3.0`: top-of-book hydration and gross equivalent/implication opportunity engine.
- Backward-compatible features increment `MINOR` while pre-1.0.
- Bug fixes increment `PATCH`.
- After `1.0.0`, breaking API/schema changes increment `MAJOR`.

## Important limitation

A relation or gross opportunity is **not** yet an executable net arbitrage guarantee. Fees, full depth beyond the first price level, quote freshness, venue-specific cancellation/settlement behavior, latency, partial fills, and execution risk still need to be modeled before automated trading is justified.
