# orders-jobs-api (realistic example app with seeded defects)

An orders API whose payments run **asynchronously**: placing an order queues a payment job, a pool
of background workers charges an outbound **payment provider**, the provider confirms the capture
with a **webhook** (at-least-once delivery, `Idempotency-Key`), and order reads go through a
**read cache**. Plain **node:http** (a regex route table) and **node:sqlite**, no dependencies
beyond Node ≥ 22.19. It is the ground truth for SECOND WORLD's second realistic project (wave 8):
**five deliberately seeded defects**, documented in [`expected-findings.json`](./expected-findings.json)
and marked in the code with a `SEEDED-DEFECT:<id>` comment. Everything else is meant to be correct.
[`openapi.yaml`](./openapi.yaml) describes the **intended, correct** contract.

Do not copy the seeded patterns into real code.

## Run

```bash
npx tsx examples/orders-jobs-api/provider/server.ts   # fake PSP on 4020 (LATENCY_MS=300, webhooks → 3200)
npx tsx examples/orders-jobs-api/src/server.ts        # app on 3200 (PROVIDER_URL, WORKERS=4)
```

Node prints `ExperimentalWarning: SQLite is an experimental feature` on start; that is expected.
In tests, `startProvider()` (provider/server.ts) and `start(0, { providerUrl })` (src/server.ts) run
both on random 127.0.0.1 ports; `provider.setWebhookUrl(app.url + "/webhooks/payments")` wires them.
`provider/` is not part of the app under test (`sw inspect` reads `src/` only).

## API

Auth: `Authorization: Bearer <token>`; another user's order or job answers 404 like a missing one.

| Route                                     | Auth   | Notes                                                                 |
| ----------------------------------------- | ------ | --------------------------------------------------------------------- |
| `GET /healthz`                            | –      | liveness                                                              |
| `GET /orders?limit&offset`                | bearer | the caller's orders, newest first                                     |
| `POST /orders`                            | bearer | 201 + `paymentJobId`; the payment job is queued                       |
| `GET`/`PUT`/`DELETE /orders/{id}`         | bearer | GET is cached (LRU 1000 entries, TTL 30 s); PUT replaces note/address |
| `GET /orders/{id}/payment?refresh`        | bearer | payment state; `refresh=true` also asks the provider                  |
| `GET /jobs/{id}?wait=<ms>`                | bearer | payment job; long-polls up to 5 s until it finishes                   |
| `POST /webhooks/payments`                 | –      | provider events; `Idempotency-Key` header; must match an order total  |
| `POST /__test/reset`, `GET /__test/stats` | –      | test hooks: reseed; queue depth, provider calls, cache hits           |

Seed data (`src/db.ts`): users `alice` / `bob` (tokens `alice-token`, `bob-token`); order 1 (alice,
2 x TEA-001 = 2500, paid with charge `ch_seed_1`), order 2 (bob, pending). The webhook has no
provider signature in this example: it only accepts events naming one of our orders with its
exact total (a real deployment also verifies the signature).

## Seeded defects

| id                              | Engine      | Where                    | Reproduce                                                                     |
| ------------------------------- | ----------- | ------------------------ | ----------------------------------------------------------------------------- |
| `retry-storm-no-jitter`         | reliability | `src/provider-client.ts` | provider answers 503 → 8 attempts per job, fixed 100 ms apart, 4 workers      |
| `refresh-no-timeout`            | reliability | `src/provider-client.ts` | provider hangs → `GET /orders/1/payment?refresh=true` hangs with it           |
| `webhook-replay-not-idempotent` | bugs        | `src/routes/webhooks.ts` | same event + key twice → two records, order 1 `amountPaid` 2500 → 7500        |
| `unbounded-queue`               | stress      | `src/queue.ts`           | orders faster than ≈13 jobs/s → job waits grow without bound, never a 503     |
| `stale-cache-after-update`      | bugs        | `src/routes/orders.ts`   | `GET /orders/1`, `PUT /orders/1 {note:"new"}`, `GET /orders/1` → the old note |

## Finding them with `sw.config.ts`

Work in a copy (reports and history are written next to the config), with the provider and the
app running. For reliability, start a second app with `PROVIDER_URL=http://127.0.0.1:4021`: the
fault proxy listens there and forwards to `targets.payments`.

| Defect                          | Command                                 | Finding                                                                                          |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `retry-storm-no-jitter`         | `sw reliability run dependency-5xx`     | `reliability/retry-storm` (≈5x calls per request)                                                |
|                                 | `sw inspect`                            | ARCH002 "fixed delay: no exponential backoff and no jitter" at `src/provider-client.ts`          |
| `refresh-no-timeout`            | `sw reliability run dependency-timeout` | `reliability/outbound-no-timeout` (the `refresh` route tracks the black-hole)                    |
|                                 | `sw inspect`                            | ARCH001 at `src/provider-client.ts`                                                              |
| `webhook-replay-not-idempotent` | `sw bugs`, `sw agent`                   | `bugs/idempotency-key-ignored` POST /webhooks/payments (agent also `agent/idempotency-key-race`) |
| `unbounded-queue`               | `sw stress`                             | `STRESS-FIRST-BREACH` "endpoint.GET /jobs/{{job}}.p95 < 2000ms first breached at 48 rps"         |
| `stale-cache-after-update`      | `sw bugs`                               | `bugs/race-lost-update` (concurrency test "order note: …", register model)                       |

Config notes:
- `bugs.values` gives the webhook body a real order (1), charge (`ch_seed_1`) and total (2500).
- `bugs.concurrency` reads order 1, replaces its note twice at once and reads it again: a register
  must return the last write. The model-based stateful technique and `sw agent` do not find the stale
  read on their own (see expected-findings.json).
- `performance.thresholds` holds the job-wait SLO the stress run checks: the checkout scenario
  long-polls `GET /jobs/{id}?wait=5000`, so its latency is the time until the payment job ran.
- `stress.loadType: "rate"`: stress does not inherit `performance.model`/`rate`.
- The reliability workload's `orders` route has `dependsOn: []`: placing an order does not call the
  provider in the request (the job does), so only `refresh` is judged for timeouts.
- `sw perf` holds its thresholds at the configured 10 iterations/s; `sw reliability`'s
  `reliability/experiment` summary is a documented observation.

If you move code, refresh the line numbers:

```bash
node examples/_tools/sync-expected-findings.mjs examples/orders-jobs-api          # update
node examples/_tools/sync-expected-findings.mjs examples/orders-jobs-api --check  # verify
```

## Tests

- `tests/system/orders-jobs.test.ts` reproduces every defect by hand, then runs `sw inspect`, `bugs`,
  `agent`, `perf`, `stress` and `reliability run dependency-5xx` / `dependency-timeout` (from source)
  with this folder's `sw.config.ts` and scores each command (≈ 70 s).
- The packed-tarball user journey (build → `npm pack` → `npm i <tgz>` in a fresh project → every
  command) is in the same file and is **skipped unless `SW_SYSTEM_PACK=1`**:

```bash
SW_SYSTEM_PACK=1 npx vitest run tests/system/orders-jobs.test.ts
```
