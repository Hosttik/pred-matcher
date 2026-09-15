# pred-matcher

Prediction-market relation and contract verification engine that ingests public Polymarket and Kalshi markets, normalizes their contract semantics, and detects structural relations across venues.

Current version: **0.2.0**.

## MVP scope

- Polymarket public Gamma API ingestion.
- Kalshi public Markets API ingestion.
- Common normalized market model.
- Title/subtitle candidate retrieval that avoids a naive full cross-product.
- Structured contract parsing with field provenance (`venue`, `text`, `fallback`).
- Settlement verification using resolution sources, rules similarity, and early-close conditions when available.
- Relations:
  - `EQUIVALENT`
  - `SIMILAR`
  - `THRESHOLD_NESTED`
  - `TIME_NESTED`
  - `IMPLIES`
- In-memory API for syncing and inspecting markets, parsed contracts, and relations.

The matcher remains deliberately deterministic and conservative. `SIMILAR` is used when two markets look related but the available contract evidence is not strong enough to claim equivalence or a safe implication.

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
```

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

Venue-provided structured fields take precedence over text extraction. A market close time is treated as a fallback deadline and is explicitly marked as such.

## Relation semantics

### `EQUIVALENT`

No known contract differences and enough verification evidence to treat both contracts as equivalent.

### `SIMILAR`

The markets are semantically related, but the verifier found a conflict or lacks enough evidence for a stronger relation. For example, identical titles with incompatible resolution sources are `SIMILAR`, not `EQUIVALENT`.

### `THRESHOLD_NESTED`

Same underlying predicate and compatible settlement semantics, but one threshold is stricter than the other.

### `TIME_NESTED`

Same underlying predicate and compatible settlement semantics, but one deadline is earlier than the other.

### `IMPLIES`

Both threshold and time constraints tighten in the same logical direction. Example:

```text
BTC > $160k by June 30  =>  BTC > $150k by December 31
```

## API

### `GET /health`

Returns service version and the most recent sync summary.

### `POST /v1/sync`

Fetches open markets from both venues, normalizes them, generates cross-venue candidates, parses contracts, verifies semantics, and classifies supported relations.

### `GET /v1/markets?venue=polymarket|kalshi`

Returns the current in-memory market snapshot.

### `GET /v1/contracts?marketId=...`

Returns the structured contract representation for one market in the current snapshot.

### `GET /v1/relations?type=...`

Returns detected relations, including contract comparison evidence. `type` is optional.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: first runnable cross-venue matcher MVP.
- `0.2.0`: structured contract parsing, verification, `SIMILAR`, and composed `IMPLIES` relations.
- Backward-compatible features increment `MINOR` while pre-1.0.
- Bug fixes increment `PATCH`.
- After `1.0.0`, breaking API/schema changes increment `MAJOR`.

## Important limitation

A relation is **not** an executable arbitrage guarantee. Contract resolution rules, settlement sources, fees, bid/ask depth, liquidity, venue-specific cancellation behavior, and execution risk must be verified before a relation can be turned into a trading opportunity.
