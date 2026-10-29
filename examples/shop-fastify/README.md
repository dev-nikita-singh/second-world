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
`POST /orders {productId, qty}` (+ `Idempotency-Key`), `GET /orders` (own orders, each with the
`idempotencyKey` it was created with), `GET /orders/:id`,
`POST /__test/reset`, `GET /__test/stats`. Tokens: `alice-token`, `bob-token`, `admin-token`.
Product 40 has stock 1.

## Seeded defects

| id | Engine | Reproduce |
|---|---|---|
| `slow-search` | evolution / performance / architecture | `GET /products/search?q=red` → 41 queries; `FIXED=1` → 1 |
| `retry-no-jitter` | reliability / architecture | payments `failNext: 3` → constant 50 ms retry gaps |
| `no-circuit-breaker` | reliability | payments `failPct: 100` → 4 attempts on every order, forever |
| `boundary-500-limit` | bugs | `GET /products?limit=0` → 500 |
| `bfla-delete-product` | bugs (security) | bob `DELETE /products/1` → 204 |
| `sync-fs-in-handler` | architecture | `readFileSync` in the `/terms` handler |
| `schema-drift-created-at` | bugs | `GET /orders/:id` → `createdAt` is a number |
| `idempotency-key-race` (discovered, not planted) | agent / bugs / reliability | 5 concurrent `POST /orders` with one `Idempotency-Key` → several orders (sequential repeats are replayed correctly) |

## Finding them with `sw.config.ts`

Every defect is found by the commands below, using [`sw.config.ts`](./sw.config.ts) as it is.
For the reliability runs, start the shop with `PAYMENTS_URL=http://127.0.0.1:4011`: the
Reliability Lab starts its fault proxy on 4011 and forwards to payments-fake on 4010.

```bash
sw --config examples/shop-fastify/sw.config.ts inspect
sw --config examples/shop-fastify/sw.config.ts bugs
sw --config examples/shop-fastify/sw.config.ts --approve-disruptive reliability run dependency-5xx
sw --config examples/shop-fastify/sw.config.ts --approve-disruptive reliability run dependency-latency
```

| Defect | Command | Finding |
|---|---|---|
| `slow-search` | `sw inspect` | ARCH005 at `src/server.ts` (query in a loop) |
| `retry-no-jitter` | `sw inspect`, `sw reliability run dependency-5xx` | ARCH002; `reliability/retry-without-jitter` |
| `no-circuit-breaker` | `sw reliability run dependency-5xx` | `reliability/no-circuit-breaker` |
| `boundary-500-limit` | `sw bugs` | `bugs/server-error-on-boundary` GET /products |
| `bfla-delete-product` | `sw bugs` | `bugs/bfla` DELETE /products/{id} |
| `sync-fs-in-handler` | `sw inspect` | ARCH004 at `src/server.ts` |
| `schema-drift-created-at` | `sw bugs` | `bugs/schema-mismatch` GET /orders/{id} |
| `idempotency-key-race` | `sw bugs`, `sw reliability run dependency-latency` | `bugs/race-lost-update` (concurrency test "same Idempotency-Key, concurrent"); `reliability/duplicate-operation` (invariants `one-order-per-key` and `orders-per-operation`: payments answers in 1.5 s, clients time out after 1 s and retry with the same key while the first request is still in flight) |

`sw bugs` also runs a mixed orders/stock-reads concurrency test on product 40. It must stay
linearizable here (atomic decrement). The FIXED/`slow-search` comparison (What-If / Evolution)
needs two app variants and is not part of the config.

Documented observations that are not defects (`observations` in expected-findings.json):
`bugs/accepts-invalid-input` on GET /products (page/limit not validated), `bugs/undocumented-status`
414 for a very long order id, and the `reliability/experiment` summary of each run.

`dependency-timeout` is not part of this list. The shop's outbound budget (4 × 2 s + delays) is longer
than the clients' 1 s timeout, so with this config the Reliability Lab reports the timeout check as
inconclusive (`timeout-window-too-short`) rather than as a finding.

## Correct by design (must not be reported)

Idempotency-Key honoured for sequential repeats · order ownership checked (no BOLA) · atomic stock decrement ·
outbound timeout (2 s) · order qty validated (1..100).

All of the above are verified by `tests/integration/examples/shop-fastify.test.ts`. Detection from the
config (recall and precision 1.0) is verified by `tests/integration/examples/from-config-fastify.test.ts`.
