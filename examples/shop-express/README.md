# shop-express (fixture app with seeded defects)

A small shop API on **Express 5** used as ground truth for SECOND WORLD's engines
(docs/12-testing-and-quality.md §3). It looks like a normal app, but it contains
**ten deliberately seeded defects** (plus two discovered later and kept as ground truth), each documented in
[`expected-findings.json`](./expected-findings.json) and marked in the code with a
`SEEDED-DEFECT:<id>` comment. [`openapi.yaml`](./openapi.yaml) describes the
**intended, correct** contract.

Do not copy patterns from this app into real code.

## Run

```bash
# terminal 1: the payment provider the shop depends on
npx tsx examples/payments-fake/src/server.ts            # http://127.0.0.1:4010
# terminal 2: the shop
npx tsx examples/shop-express/src/server.ts             # http://127.0.0.1:3000
# env: PORT, PAYMENTS_URL
```

In tests, use `startExample("shop-express")` from `tests/helpers/examples.ts` (random ports, payments-fake included).

## API

| Route | Auth | Notes |
|---|---|---|
| `GET /healthz` | – | liveness |
| `POST /auth/login` `{username,password}` | – | `alice/alice-pass`, `bob/bob-pass`, `admin/admin-pass` |
| `GET /products[?category=&include=reviews]` | – | 20 products; #20 "Limited edition" has stock 1 |
| `GET /products/:id` | – | |
| `GET /cart`, `POST /cart/items {productId, qty}`, `DELETE /cart` | bearer | bulk tiers: 1–9, 10–49 (−5 %), 50–100 (−10 %) |
| `GET /orders`, `POST /orders {items:[{productId,qty}]}`, `GET /orders/:id` | bearer | POST charges payments-fake |
| `GET /admin/stats` | admin | |
| `POST /__test/reset`, `GET /__test/stats` | – | test hooks: reset data, DB query counter |

Tokens: `alice-token`, `bob-token`, `admin-token`. Each DB call waits `queryDelayMs` (default 1 ms) so query counts become latency.

## Seeded defects

| id | Engine | Where | Reproduce |
|---|---|---|---|
| `n-plus-one-reviews` | architecture / performance | `src/routes/products.ts` | `GET /products?include=reviews` → 21 queries |
| `no-timeout-outbound` | architecture / reliability | `src/payments-client.ts` | payments hangs → `POST /orders` hangs |
| `sync-crypto-login` | architecture / performance | `src/auth.ts` | concurrent logins stall `/healthz` |
| `module-cycle` | architecture | `src/services/inventory.ts` ⇄ `orders.ts` | import graph |
| `stock-race` | bugs | `src/services/inventory.ts` | 5 parallel orders of product 20 → >1 succeed |
| `idempotency-ignored` | bugs | `src/routes/orders.ts` | same `Idempotency-Key` twice → 2 orders |
| `bola-orders` | bugs (security) | `src/routes/orders.ts` | bob reads alice's order |
| `schema-drift-price` | bugs | `src/routes/products.ts` | `GET /products/1` price is a string |
| `boundary-500` | bugs | `src/pricing.ts` | `qty: 0` / `101` → 500 |
| `unbounded-retry` | reliability | `src/payments-client.ts` | payments `failNext: 25` → 26 instant attempts |
| `idempotency-key-race` (discovered, not planted) | agent / bugs | `src/routes/orders.ts` | 5 concurrent `POST /orders` with one key → several orders (consequence of `idempotency-ignored`) |
| `no-circuit-breaker` (discovered, not planted) | reliability | `src/payments-client.ts` | payments `failPct: 100` → every order keeps calling it, no fast failure |

Every defect is reproduced by `tests/integration/examples/shop-express.test.ts`.

## Finding them with `sw.config.ts`

Every defect is found by the commands below, using [`sw.config.ts`](./sw.config.ts) as it is.
For the reliability runs, start the shop with `PAYMENTS_URL=http://127.0.0.1:4011`: the
Reliability Lab starts its fault proxy on 4011 and forwards to payments-fake on 4010.

```bash
sw --config examples/shop-express/sw.config.ts inspect
sw --config examples/shop-express/sw.config.ts bugs
sw --config examples/shop-express/sw.config.ts --approve-disruptive reliability run dependency-5xx
sw --config examples/shop-express/sw.config.ts --approve-disruptive reliability run dependency-timeout
```

| Defect | Command | Finding |
|---|---|---|
| `n-plus-one-reviews` | `sw inspect` | ARCH005 at `src/routes/products.ts` |
| `no-timeout-outbound` | `sw inspect`, `sw reliability run dependency-timeout` | ARCH001; `reliability/outbound-no-timeout` |
| `sync-crypto-login` | `sw inspect` | ARCH004 at `src/auth.ts` |
| `module-cycle` | `sw inspect` | ARCH003 |
| `stock-race` | `sw bugs` | `bugs/race-lost-update` (concurrency test "last item: orders vs stock reads") |
| `idempotency-ignored` | `sw bugs`, `sw reliability run dependency-5xx` / `dependency-timeout` | `bugs/idempotency-key-ignored`; `reliability/duplicate-operation` (invariant `orders-per-operation`: client retries with the same key create extra orders) |
| `bola-orders` | `sw bugs` | `bugs/bola` GET /orders/{id} |
| `schema-drift-price` | `sw bugs` | `bugs/schema-mismatch` GET /products/{id} |
| `boundary-500` | `sw bugs` | `bugs/server-error-on-boundary` POST /cart/items and POST /orders |
| `unbounded-retry` | `sw inspect`, `sw reliability run dependency-5xx` | ARCH002; `reliability/retry-without-backoff` |
| `idempotency-key-race` | `sw bugs` | `bugs/race-lost-update` (concurrency test "same Idempotency-Key, concurrent") |
| `no-circuit-breaker` | `sw reliability run dependency-5xx` / `dependency-timeout` | `reliability/no-circuit-breaker` |

`sw perf` shows the cost of `n-plus-one-reviews` and `sync-crypto-login` as latency, but it does not
produce a finding that points at the defect.

Documented observations that are not defects (`observations` in expected-findings.json): ARCH005 in
`placeOrder` (one product read per order line), `bugs/accepts-invalid-input` for unknown `include`
values, and the `reliability/experiment` summary of each run. Detection from the config (recall and
precision 1.0) is verified by `tests/integration/examples/from-config-express.test.ts`.
If you move code, refresh the line numbers:

```bash
node examples/_tools/sync-expected-findings.mjs examples/shop-express          # update
node examples/_tools/sync-expected-findings.mjs examples/shop-express --check  # verify (CI)
```
