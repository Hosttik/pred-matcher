# pred-matcher

Prediction-market relation engine that ingests public Polymarket and Kalshi markets and detects structural relations between contracts.

Current version: **0.1.0**.

## MVP scope

- Polymarket public Gamma API ingestion.
- Kalshi public Markets API ingestion.
- Common normalized market model.
- Cross-venue candidate generation.
- Relations:
  - `EQUIVALENT`
  - `THRESHOLD_NESTED`
  - `TIME_NESTED`
- In-memory API for syncing and inspecting results.

The current matcher is deliberately deterministic and conservative. It is a baseline for measuring precision before adding embeddings/LLM contract parsing.

## Requirements

- Node.js 24+
- npm 11+

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
curl 'http://localhost:3000/v1/relations?type=THRESHOLD_NESTED'
```

## API

### `GET /health`

Returns service version and the most recent sync summary.

### `POST /v1/sync`

Fetches open markets from both venues, normalizes them, generates cross-venue candidates, and classifies supported relations.

### `GET /v1/markets?venue=polymarket|kalshi`

Returns the current in-memory market snapshot.

### `GET /v1/relations?type=...`

Returns detected relations. `type` is optional.

## Versioning

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`).

- `0.1.0`: first runnable MVP.
- Backward-compatible features increment `MINOR` while pre-1.0.
- Bug fixes increment `PATCH`.
- After `1.0.0`, breaking API/schema changes increment `MAJOR`.

## Important limitation

A relation is **not** an executable arbitrage guarantee. Contract resolution rules, settlement sources, fees, bid/ask depth, and execution risk must be verified before a relation can be turned into a trading opportunity.
