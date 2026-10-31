# payments-fake

A tiny fake payment provider used by `shop-express` and `shop-fastify`.
It lets tests (and SECOND WORLD's Reliability/Bug engines) inject latency, failures and hangs
deterministically.

```bash
npx tsx examples/payments-fake/src/server.ts          # PORT=4010 by default
```

| Route                                                        | Purpose                                               |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `POST /charges` `{orderId, amount}`                          | 201 captured, or 503 when failing                     |
| `GET /__control`                                             | current behaviour + stats (attempts, attemptsByOrder) |
| `POST /__control` `{latencyMs?, failPct?, failNext?, hang?}` | change behaviour                                      |
| `POST /__control/reset`                                      | defaults + zero stats                                 |
| `GET /healthz`                                               | liveness                                              |

Programmatic: `startPaymentsFake({ latencyMs, failPct })` → `{ url, setBehavior, stats, reset, close }`.
Failure injection is deterministic by attempt counter (`failPct: 10` → exactly 10 of every 100 attempts fail).
