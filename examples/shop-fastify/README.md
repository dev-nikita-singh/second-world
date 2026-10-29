# shop-fastify (fixture app with seeded defects)

The shop domain on **Fastify 5**, with a **different subset** of seeded defects than
[`shop-express`](../shop-express/README.md), plus several behaviours that are implemented
**correctly on purpose** so engines can be checked for false positives (precision).
Ground truth: [`expected-findings.json`](./expected-findings.json) (`defects` and
`correctByDesign`). Intended contract: [`openapi.yaml`](./openapi.yaml).

## Run

```bash
npx tsx examples/payments-fake/src/server.ts                 # :4010
npx tsx examples/shop-fastify/src/server.ts                  # :3001, seeded variant
FIXED=1 npx tsx examples/shop-fastify/src/server.ts          # indexed search (the "fixed" variant)
```

PowerShell: `$env:FIXED="1"; npx tsx examples/shop-fastify/src/server.ts`.
Tests: `startExample("shop-fastify", { fixed?: boolean })` from `tests/helpers/examples.ts`.

## API

`GET /healthz` (reports `variant`), `GET /products?page=&limit=`, `GET /products/search?q=`,
`GET /products/:id`, `DELETE /products/:id` (admin per contract), `GET /terms`,
`POST /orders {productId, qty}` (+ `Idempotency-Key`), `GET /orders/:id`,
`POST /__test/reset`, `GET /__test/stats`. Tokens: `alice-token`, `bob-token`, `admin-token`.
Product 40 has stock 1.

## Seeded defects

| id | Engine | Reproduce |
|---|---|---|
| `slow-search` | evolution / performance | `GET /products/search?q=red` → 41 queries; `FIXED=1` → 1 |
| `retry-no-jitter` | reliability | payments `failNext: 3` → constant 50 ms retry gaps |
| `no-circuit-breaker` | reliability | payments `failPct: 100` → 4 attempts on every order, forever |
| `boundary-500-limit` | bugs | `GET /products?limit=0` → 500 |
| `bfla-delete-product` | bugs (security) | bob `DELETE /products/1` → 204 |
| `sync-fs-in-handler` | architecture | `readFileSync` in the `/terms` handler |
| `schema-drift-created-at` | bugs | `GET /orders/:id` → `createdAt` is a number |
| `idempotency-key-race` (discovered, not planted) | agent / bugs | 5 concurrent `POST /orders` with one `Idempotency-Key` → several orders (sequential repeats are replayed correctly) |

## Correct by design (must not be reported)

Idempotency-Key honoured for sequential repeats · order ownership checked (no BOLA) · atomic stock decrement ·
outbound timeout (2 s) · order qty validated (1..100).

All of the above are verified by `tests/integration/examples/shop-fastify.test.ts`.
