# shop-express (fixture app with seeded defects)

A small shop API on **Express 5** used as ground truth for SECOND WORLD's engines
(docs/12-testing-and-quality.md §3). It looks like a normal app, but it contains
**ten deliberately seeded defects** (plus one discovered later and kept as ground truth), each documented in
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

Every defect is reproduced by `tests/integration/examples/shop-express.test.ts`.
If you move code, refresh the line numbers:

```bash
node examples/_tools/sync-expected-findings.mjs examples/shop-express          # update
node examples/_tools/sync-expected-findings.mjs examples/shop-express --check  # verify (CI)
```
