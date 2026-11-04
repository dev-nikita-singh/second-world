# Quickstart: investigate `shop-express` in 15 minutes

This walkthrough runs every main SECOND WORLD engine against **shop-express**, the bundled Express
example app. It contains ten documented, deliberately seeded defects (see
[`examples/shop-express/README.md`](../examples/shop-express/README.md) and its `expected-findings.json`).
You will measure the app, stress it, inspect its code, hunt API bugs, inject a fault, summarise and compare
runs, combine reports and run several engines as one workflow.

All output below was captured on Windows 11 / Node 24 and trimmed (`…`). Your numbers will differ.

> Only point SECOND WORLD at systems you own or are authorised to test. The defaults allow
> loopback targets only.

## 0. Prerequisites

- Node.js **≥ 22.19** (`node --version`), git.
- A clone of this repository with its dependencies installed (`npm install` in the repo root).
- This walkthrough runs SECOND WORLD from source. (Outside the repo, install the packed tarball instead and use
  `npx sw`: see [Install](../README.md#install).) Define a `sw` shortcut that points at the CLI entry:

```bash
# bash / zsh (adjust the path)
sw() { npx tsx /path/to/second-world/src/cli/main.ts "$@"; }
```

```powershell
# PowerShell: use npx.cmd (npx.ps1 does not forward @args)
function sw { npx.cmd tsx C:\path\to\second-world\src\cli\main.ts @args }
```

## 1. Start the example app

From the repository root, start three processes in three terminals:

```bash
# the payment provider the shop depends on, http://127.0.0.1:4010
npx tsx examples/payments-fake/src/server.ts
# the shop, http://127.0.0.1:3000
npx tsx examples/shop-express/src/server.ts
# a second shop instance that reaches payments through port 4011.
# The Reliability Lab's fault proxy will listen there (step 8).
PORT=3002 PAYMENTS_URL=http://127.0.0.1:4011 npx tsx examples/shop-express/src/server.ts
```

In PowerShell, set the variables first for the third one:
`$env:PORT=3002; $env:PAYMENTS_URL="http://127.0.0.1:4011"; npx tsx examples/shop-express/src/server.ts`.

Then work in a **copy** of the example, so reports, history and caches stay out of the repository:

```bash
cp -r examples/shop-express ~/sw-shop && cd ~/sw-shop
rm sw.config.ts          # we let `sw init` write one first
```

## 2. `sw doctor`: check the environment

```text
$ sw doctor
SECOND WORLD doctor
✔ Node 24.14.0
ℹ win32 x64 10.0.26200
✔ worker_threads
✔ node:sqlite
✔ 16 CPUs
✔ 15.7 GiB memory
✔ git 2.51.0
⚠ docker 29.3.0 (client) — daemon not reachable → Start Docker Desktop or the docker service (`docker info` must succeed); until then the Reliability Lab uses the built-in proxy and the Evolution docker sandbox is unavailable
ℹ toxiproxy not found
ℹ k6 not found
ℹ non-TTY output (line-based progress)
ℹ no sw.config.* found here or in parent folders → Run `sw init` to create one, or pass a URL: `sw perf http://127.0.0.1:3000`
✔ typescript 6.0.3 (sw inspect, sw model build)

0 problem(s), 1 warning(s)
```

Missing optional tools (Toxiproxy, k6) or a stopped Docker daemon only disable the features that need them.
Nothing in this walkthrough needs them.

## 3. `sw init`: scaffold a config

```text
$ sw init
✔ wrote …/sw-shop/sw.config.ts
✔ added .second-world/ to .gitignore
ℹ detected: npm · frameworks: none · OpenAPI: openapi.yaml · start script: not found
ℹ target http://127.0.0.1:3000 (from openapi.yaml servers[0], health /healthz)
ℹ no start script found: start your service yourself before running a test (hooks.start is not set)
ℹ perf scenario: GET /products (from openapi.yaml; add your own under performance.scenarios)
ℹ next: start your service, then run `sw doctor` and `sw perf`
SECOND WORLD is for testing systems you own or are explicitly authorised to test.
```

The generated `sw.config.ts` has local-only safety defaults: `allowHosts` loopback only,
`allowPublic: false`, `allowMutations: false`, and budgets `maxRps: 500`, `maxDuration: "15m"`. It also
has starter `performance`, `stress`, `architecture`, `bugs` and `report` sections. Run `sw init --force` to overwrite.

For this walkthrough, switch to the example's ready-made config. It has weighted scenarios, auth roles, a reset
hook, Bug Hunter concurrency tests and a `reliability` section whose fault proxy listens on :4011 (the port the
second shop instance calls payments through):

```bash
cp /path/to/second-world/examples/shop-express/sw.config.ts .
```

```text
$ sw config validate
✔ config valid (…/sw-shop/sw.config.ts)
⚠ Literal string at auth.admin.token in sw.config.ts looks like a secret (log output would redact it); use { env: "NAME" } or { file: "path" } instead
⚠ Literal string at auth.other.token in sw.config.ts looks like a secret (log output would redact it); use { env: "NAME" } or { file: "path" } instead
⚠ Literal string at auth.user.token in sw.config.ts looks like a secret (log output would redact it); use { env: "NAME" } or { file: "path" } instead
```

The warnings are expected here because the example uses demo tokens. In a real project, write
`token: { env: "API_TOKEN" }`. Resolved secrets are redacted from logs and reports. Every command repeats
these three warnings on stderr (`WARN …`); they are left out of the output below.

## 4. `sw perf`: Performance Lab

The config runs an open-model load at 50 iterations/s with weighted scenarios (browse, browse with
reviews, checkout) and two thresholds. `--duration` overrides the config:

```text
$ sw perf --duration 10s
[1s warmup] rps=86.8 p95=0.0ms errors=0 inFlight=4
[7s measure] rps=88.0 p95=122.9ms errors=0 inFlight=1
SECOND WORLD run 01M6K9V9WDXMYVSTHTSQNB2HJ5 · 12.1s · 0.1.0
✔ PASS (exit 0, fail-on high) completed: no failing thresholds or findings at or above 'high'

[performance] passed 12.1s
target http://127.0.0.1:3000  model open/constant  measured 10.0s  stop completed
┌──────────┬─────┬────────┬──────┬────────────┬────────┬───────┬───────┬───────┐
│ requests │  ok │ failed │  rps │ error rate │    p50 │   p95 │   p99 │   max │
├──────────┼─────┼────────┼──────┼────────────┼────────┼───────┼───────┼───────┤
│      903 │ 903 │      0 │ 90.3 │      0.00% │ 8.30ms │ 123ms │ 145ms │ 163ms │
├──────────┴─────┴────────┴──────┴────────────┼────────┼───────┼───────┼───────┤
│                   raw (uncorrected) latency │ 8.29ms │ 123ms │ 145ms │ 163ms │
└─────────────────────────────────────────────┴────────┴───────┴───────┴───────┘
rate target 50/s — achieved 50/s
┌─────────────────────────────┬──────────┬──────┬────────┬────────┬────────┬────────┐
│ endpoint                    │ requests │  rps │ errors │    p50 │    p95 │    p99 │
├─────────────────────────────┼──────────┼──────┼────────┼────────┼────────┼────────┤
│ GET /products               │      456 │ 45.6 │  0.00% │ 7.64ms │  140ms │  154ms │
├─────────────────────────────┼──────────┼──────┼────────┼────────┼────────┼────────┤
│ GET /products/{{rand 1 20}} │      403 │ 40.3 │  0.00% │ 7.84ms │ 16.0ms │ 17.7ms │
├─────────────────────────────┼──────────┼──────┼────────┼────────┼────────┼────────┤
│ POST /orders                │       44 │  4.4 │  0.00% │ 43.4ms │ 59.1ms │ 62.7ms │
└─────────────────────────────┴──────────┴──────┴────────┴────────┴────────┴────────┘
generator: event-loop p99 23.7ms, cpu 15%, lag p99 1.18ms
Thresholds
┌───┬───────────────────────┬────────┐
│   │ threshold             │ actual │
├───┼───────────────────────┼────────┤
│ ✔ │ http.p95: < 200ms     │  123ms │
├───┼───────────────────────┼────────┤
│ ✔ │ http.error_rate: < 1% │  0.00% │
└───┴───────────────────────┴────────┘
report: …/sw-shop/.second-world/reports/report.json
history: saved run 01M6K9V9WDXMYVSTHTSQNB2HJ5
```

How to read it:
- "Rate target 50/s" counts scenario iterations. `rps` counts HTTP requests, and the browse scenario sends two.
- `GET /products` has a p95 about 10x higher than `GET /products/{id}`. That gap comes from the seeded
  N+1 query behind `?include=reviews`, which the endpoint table groups under `GET /products`.
- The `generator` line is the load generator's self-check. A saturated generator would invalidate the run.
- Every run is saved to history (`--no-history` skips that) under the run id in the header. Reports go to
  `.second-world/reports/`, and **each run overwrites `report.json`**. Use `-o <dir>` to keep one directory
  per run, and `-f tty,json,md,junit,sarif,html` to choose formats.

## 5. `sw stress`: Stress & Capacity Lab

`sw stress` inherits the Performance Lab's load model, so with this config `--steps` are arrival rates
(iterations/s). To step through virtual users instead, set `stress.loadType`:

```text
$ sw --set stress.loadType=vus stress --steps 10,25,50 --hold 5s
stage 0 step 10 VUs level=10 → passed p95=59.2ms tput=505.0/s err=0.00%
stage 1 step 25 VUs level=25 → passed p95=32.7ms tput=510.6/s err=0.00%
stage 2 step 50 VUs level=50 → passed p95=56.4ms tput=511.2/s err=0.00%
SECOND WORLD run 01M6K9VT6Q6G3F60CRZNXHY872 · 15.8s · 0.1.0
✔ PASS (exit 0, fail-on high) completed: no failing thresholds or findings at or above 'high'

[stress] passed 15.8s
  mode         step
  load type    virtual users (closed)
  target       http://127.0.0.1:3000
  stop reason  completed
Capacity
  Highest tested load that met all requirements in this environment: 50 VUs (511.2 rps, limited by safety.maxRps 500 req/s; the target's capacity was not reached). This is not a capacity of the target.
  tested capacity  50 VUs
Stages
┌───┬────────┬────────┬────────────┬────────┬────────┬────────┬────────────┬────────────────┬─────────┐
│ # │  level │ status │ throughput │    p50 │    p95 │    p99 │ error rate │ breach reasons │ invalid │
├───┼────────┼────────┼────────────┼────────┼────────┼────────┼────────────┼────────────────┼─────────┤
│ 0 │ 10 VUs │ passed │      505/s │ 5.75ms │ 59.2ms │ 84.5ms │      0.00% │                │ CAPPED  │
├───┼────────┼────────┼────────────┼────────┼────────┼────────┼────────────┼────────────────┼─────────┤
│ 1 │ 25 VUs │ passed │    510.6/s │ 6.25ms │ 32.7ms │ 84.0ms │      0.00% │                │ CAPPED  │
├───┼────────┼────────┼────────────┼────────┼────────┼────────┼────────────┼────────────────┼─────────┤
│ 2 │ 50 VUs │ passed │    511.2/s │ 6.13ms │ 56.4ms │  112ms │      0.00% │                │ CAPPED  │
└───┴────────┴────────┴────────────┴────────┴────────┴────────┴────────────┴────────────────┴─────────┘
⚠ CAPPED: stage(s) 0, 1, 2 were throttled by the safety rate cap (500 req/s); their throughput reflects the cap, not the target, so the capacity statement does not describe the target.
⚠ Knee and USL fit computed from the 0 uncapped stage(s) only; 3 stage(s) throttled by safety.maxRps 500 req/s were excluded.
  first breach  none
  knee          none detected
p95 by load level █▁▇ 32.7..59.2 ms
Estimates (model fit, not measured)
USL estimate refused: USL needs at least 5 valid stages (got 0)
Limitations
  • 3 stage(s) (step 10 VUs, step 25 VUs, step 50 VUs) were throttled by safety.maxRps 500 req/s: their throughput reflects the cap, not the target's capacity; the capacity statement does not describe the target. Raise the cap (if allowed for this environment) to test higher load. [STRESS-SAFETY-RATE-CAP] invalidates
report: …/sw-shop/.second-world/reports/report.json
history: saved run 01M6K9VT6Q6G3F60CRZNXHY872
```

Capacity is always stated as **tested** capacity. Here throughput is flat at about 510/s because the example
config sets `safety.maxRps: 500` and the Safety Guard throttles every load model to it. The report says so in
the capacity line, marks each stage `CAPPED`, keeps capped stages out of the knee and USL estimates, and adds the
`STRESS-SAFETY-RATE-CAP` limitation. To look past the cap, raise it (`sw --set safety.maxRps=5000 …`). On the
machine above, the single-threaded load generator then saturates first (about 1200 req/s at 10 VUs, generator CPU
99 %), and the report marks that stage `INVALID` (`STRESS-GENERATOR-SATURATED`) instead of calling it capacity.
Model-fit estimates (USL) appear in a separate section, and only when there is enough data. Other modes are
`--mode ramp|spike|soak|breakpoint`. For a breakpoint search, use `--rate-from/--rate-to/--step`.

## 6. `sw inspect`: Architecture Inspector

This is static analysis only. Nothing from the project is executed.

```text
$ sw inspect
SECOND WORLD run 01M6K9WDS47JZW0W2VBCQNPRCV · 1.3s · 0.1.0
✖ FAIL (exit 1, fail-on high) 2 finding(s) at or above severity 'high'

[architecture] failed 1.3s
Findings (6)
│ severity │ class          │ finding                                                                             │ where                         │
│ ✖ high   │ suspected-risk │ Outbound HTTP call without timeout: charge (src/payments-client.ts)                 │ src/payments-client.ts:22:25  │
│ ✖ high   │ suspected-risk │ Retry without max attempts or backoff: charge (src/payments-client.ts)              │ src/payments-client.ts:17:3   │
│   medium │ suspected-risk │ Database query inside a loop (possible N+1): GET /products (src/routes/products.ts) │ src/routes/products.ts:18:29  │
│   medium │ suspected-risk │ Database query inside a loop (possible N+1): placeOrder (src/services/orders.ts)    │ src/services/orders.ts:29:27  │
│   medium │ suspected-risk │ Module dependency cycle: src/services/inventory.ts                                  │ src/services/inventory.ts:4:1 │
│   medium │ suspected-risk │ Synchronous heavy work in request path: login (src/auth.ts)                         │ src/auth.ts:47:19             │
Limitations
  • Static analysis only: runtime wiring (…) and production topology (…) are not visible [ARCH_STATIC_ONLY] reduces-confidence
  …
```

Static findings are `suspected-risk`, rung L1 of the [trust ladder](01-vision-and-principles.md#5-finding-classification-the-trust-ladder).
Measurements or reproductions from the other engines promote them. Exit code 1 means findings at or
above `--fail-on` (default `high`). Use `sw inspect --graph mermaid` to print the dependency graph.

## 7. `sw bugs`: API Bug Hunter

State-changing requests are off unless you opt in once: `--allow-mutations` (or `safety.allowMutations`,
which the example config sets), `environment: isolated|staging`, or an approval (`--yes`). The
opt-in is written to the audit log. The concurrency test on the command line (for this run it replaces the
config's `bugs.concurrency` tests) checks that the last item in stock (product 20, stock 1) is sold only once:

```text
$ sw --yes bugs --allow-mutations --concurrency-test "POST /orders" --burst 5 --role user --body '{"items":[{"productId":20,"qty":1}]}' --invariant linearizable:stock:1
technique contract: 12 requests, 1 finding(s), 0.5s
technique boundary: 43 requests, 4 finding(s), 1.2s
…
technique concurrency: 5 requests, 7 finding(s), 0.1s
technique replay: 36 requests, 7 finding(s), 1.3s
SECOND WORLD run 01M6K9WN8JM48JE0Z7WDJRGWPA · 11.4s · 0.1.0
✖ FAIL (exit 1, fail-on high) 3 finding(s) at or above severity 'high'

[bugs] failed 11.4s
  mode       contract
  target     http://127.0.0.1:3000
  contract   shop-express (intended contract) v3.1 (11 operations)
  seed       42
  requests   428 sent, 18 replays, 27 hook runs
  mutations  allowed
  duration   11.4s
Coverage
  operations exercised            11/11
…
Bug findings (7)
│ classification    │ severity │ rule                          │ operation          │ technique   │ replays                                       │ seen │ …
│ reproduced-defect │ critical │ bugs/bola                     │ GET /orders/{id}   │ auth        │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │ 1x   │ …
│ reproduced-defect │ high     │ bugs/idempotency-key-ignored  │ POST /orders       │ stateful    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │ 1x   │ …
│ reproduced-defect │ high     │ bugs/race-lost-update         │ POST /orders       │ concurrency │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │ 1x   │ …
│ reproduced-defect │ medium   │ bugs/schema-mismatch          │ GET /products/{id} │ contract    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │ 8x   │ …
│ reproduced-defect │ medium   │ bugs/server-error-on-boundary │ POST /cart/items   │ boundary    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │ 2x   │ …
│ reproduced-defect │ medium   │ bugs/server-error-on-boundary │ POST /orders       │ boundary    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │ 2x   │ …
│ observation       │ info     │ bugs/accepts-invalid-input    │ GET /products      │ boundary    │ observed (not replayed)                       │ 9x   │ …
Reproductions
Credentials are never printed. Before running these commands: export SW_AUTH_<ROLE>='<full header value, e.g. Bearer …>'
bugs/bola on GET /orders/{id} (seed 42) — other accessed user's order via GET /orders/{id} (expected 403/404): got 200
    curl -sS -X POST 'http://127.0.0.1:3000/orders' -H "authorization: $SW_AUTH_USER" -H 'content-type: application/json' --data-raw '{"items":[{"productId":1,"qty":1}]}'
    curl -sS -X GET 'http://127.0.0.1:3000/orders/ord_1' -H "authorization: $SW_AUTH_OTHER"
…
bugs/race-lost-update on POST /orders (seed 42) — Not linearizable against stock(1): 4 of 5 concurrent takes succeeded; statuses [201, 201, 201, 201, 409]
    for i in $(seq 1 5); do curl -sS -X POST 'http://127.0.0.1:3000/orders' -H "authorization: $SW_AUTH_USER" -H 'content-type: application/json' --data-raw '{"items":[{"productId":20,"qty":1}]}' & done; wait
bugs/schema-mismatch on GET /products/{id} (seed 42) — /price must be number (value "7.50")
    curl -sS -X GET 'http://127.0.0.1:3000/products/1'
…
```

All six seeded API defects are reproduced, and each failure was replayed 3 times before being called a
`reproduced-defect`. Each finding's reproduction is stored under `.second-world/artifacts/` (JSON plus a HAR
file), and `sw replay <fingerprint>` re-runs it.

The printed curl commands are copy-paste ready in a POSIX shell (bash, zsh, Git Bash; in Windows PowerShell
`curl` is a different command). Put each role's full header value in `SW_AUTH_<ROLE>`. Multi-step
reproductions use the ids recorded in the failing run (`ord_1`), so reset the app to the same starting state first:

```bash
export SW_AUTH_USER='Bearer alice-token' SW_AUTH_OTHER='Bearer bob-token'   # the example's demo accounts
curl -sS -X POST http://127.0.0.1:3000/__test/reset
curl -sS -X POST 'http://127.0.0.1:3000/orders' -H "authorization: $SW_AUTH_USER" -H 'content-type: application/json' --data-raw '{"items":[{"productId":1,"qty":1}]}'
curl -sS -X GET 'http://127.0.0.1:3000/orders/ord_1' -H "authorization: $SW_AUTH_OTHER"
# → 200 with alice's order: bob can read it (BOLA)
```

## 8. `sw reliability run`: Reliability Lab

Fault injection is disruptive, so it needs `--approve-disruptive` (or `--yes`). Target the second shop on :3002. Its
payments calls go through :4011, where the Reliability Lab now starts its fault proxy
(`reliability.dependencies.payments` in the config). The config's workload sends 8 orders/s; clients give up after
1 s and retry with the same `Idempotency-Key`, and the experiment runs twice (`repeat: 2`):

```text
$ sw reliability list
dependency-latency     Dependency latency
                       injectors: builtin, toxiproxy; params: latency, jitter, percent
dependency-timeout     Dependency black-hole (timeout)
                       injectors: builtin, toxiproxy, docker; params: -
dependency-5xx         Dependency returns 5xx
                       injectors: builtin; params: status, percent
…

$ sw --approve-disruptive reliability run dependency-5xx --target http://127.0.0.1:3002 --dependency payments --steady-phase 3s --duration 5s --recovery 5s
fault applied (run 0)
fault reverted (run 0)
fault applied (run 1)
fault reverted (run 1)
SECOND WORLD run 01M6K9X6TPW71PYYZ72XYF8ZMK · 26.2s · 0.1.0
✖ FAIL (exit 1, fail-on high) 2 finding(s) at or above severity 'high'

[reliability] failed 26.2s
  scenario     dependency-5xx
  fault        HTTP 503
  dependency   payments
  injector     builtin-proxy
  environment  local
  workload     8 req/s poisson over orders
  repetitions  2
  verdict      hypothesis held
Experiment timeline
│ phase            │ duration │ requests │ error rate │ timeouts │    p50 │    p95 │  rps │
│ steady (run 1)   │     3.0s │       22 │      0.00% │        0 │ 73.4ms │ 90.1ms │  8.7 │
│ fault (run 1)    │     5.0s │       92 │     82.61% │       76 │ 1001ms │ 1010ms │ 18.4 │
│ recovery (run 1) │     5.0s │       42 │      0.00% │        0 │ 65.6ms │  280ms │  8.4 │
│ steady (run 2)   │     3.0s │       21 │      0.00% │        0 │ 65.3ms │ 91.4ms │  8.3 │
│ fault (run 2)    │     5.0s │       90 │     77.78% │       70 │ 1001ms │ 1010ms │ 18.0 │
│ recovery (run 2) │     5.0s │       38 │      0.00% │        0 │ 78.4ms │  207ms │  7.7 │
…
Detectors
│ retry amplification  │ FLAGGED │ 31.91x dependency calls per request (fault 30.52 vs steady 0.957; 2808 calls / 92 requests) — retry storm [run 1; flagged in 2/2] │
│ circuit breaker      │ FLAGGED │ no-breaker: calls/request baseline 0.957, early 113.0, late 24.34 — still 24.34 dependency calls per request after 76 client-visible failures [run 1; flagged in 2/2] │
…
Invariants (after recovery)
│ orders-per-operation (run 1) │ count-matches │ VIOLATED │ 159 resource(s) created; 82 confirmed + 19 ambiguous operation(s) allow 82..101 → duplicates │
│ orders-per-operation (run 2) │ count-matches │ VIOLATED │ 151 resource(s) created; 81 confirmed + 13 ambiguous operation(s) allow 81..94 → duplicates  │
…
Rule hits across repetitions
│ reliability/retry-without-backoff │  2/2 │ reproduced-defect │
│ reliability/no-circuit-breaker    │  2/2 │ reproduced-defect │
│ reliability/duplicate-operation   │  2/2 │ reproduced-defect │
Findings (4)
│ ✖ high   │ reproduced-defect │ Duplicate operations: 151 resources created for at most 94 operation(s) (orders-per-operation) │ dependency:payments │
│ ✖ high   │ reproduced-defect │ Retry storm: 38x dependency calls per request to payments (unbounded retries without backoff)  │ dependency:payments │
│   medium │ reproduced-defect │ No circuit breaker: payments keeps being called on every request during a sustained failure    │ dependency:payments │
│   info   │ observation       │ dependency-5xx on payments: hypothesis held, 77.8% errors during fault, recovered in 1.0 s     │ dependency:payments │
```

While payments answered 503, the shop retried it about 30 to 40 times per order (the seeded `unbounded-retry`
defect) and never opened a circuit breaker. Its clients timed out after 1 s and retried with the same
`Idempotency-Key`, and the shop created a new order for many of those retries, so there are more orders than
logical operations. Each detector hit in both repetitions, so all three are `reproduced-defect`s (with `repeat: 1`
they would be observations). The fault is always reverted, even on Ctrl+C. To double-check:

```text
$ sw reliability cleanup
✔ cleanup: 0 in-process, 0 from ledger, 0 error(s)
```

## 9. `sw analyze`: summarise earlier runs

`sw analyze` prints a deterministic summary of earlier runs. Every number is counted or copied from the
reports: nothing is inferred and nothing is sent anywhere. `--last` takes the newest history run, here the
reliability experiment:

```text
$ sw analyze --last
analyzing history run 01M6K9X6TPW71PYYZ72XYF8ZMK
1 run(s) (reliability) produced 4 finding(s), 2 of severity high or critical.
- Severity: 2 high, 1 medium, 1 info.
- Evidence strength: 3 reproduced-defect, 1 observation.
- [high] Duplicate operations: 151 resources created for at most 94 operation(s) (orders-per-operation) (reliability, reproduced-defect).
- [high] Retry storm: 38x dependency calls per request to payments (unbounded retries without backoff) (reliability, reproduced-defect).
…
- Run status: 1 failed.
```

The summary lists counts by severity and by trust-ladder classification (strongest first), the top findings
(`--top N`, default 5), run statuses and any limitation that invalidates a result. You can also pass report
files, several at once, to summarise them together: `sw analyze path/to/report.json other/report.json`.
`--json` prints the same data as an object (`headline`, `bullets`, `counts`, `topFindings`). `sw analyze`
exits 0 whenever it could read its input, because it reports on runs and does not judge them.

## 10. `sw history`: compare runs

Every engine run was recorded. Run `sw perf --duration 10s` once more, then:

```text
$ sw history list
ID                          CREATED                   LABEL     STATUS    FINDINGS  P95(ms)
01M6K9Y839C7G09JVCYZEXAYTW  2026-11-04T12:53:41.234Z  perf      passed    0         127
01M6K9X6TPW71PYYZ72XYF8ZMK  2026-11-04T12:53:21.138Z  reliability failed    4         -
01M6K9WN8JM48JE0Z7WDJRGWPA  2026-11-04T12:52:48.399Z  bugs      failed    7         -
01M6K9WDS47JZW0W2VBCQNPRCV  2026-11-04T12:52:32.203Z  inspect   failed    6         -
01M6K9VT6Q6G3F60CRZNXHY872  2026-11-04T12:52:25.054Z  stress    passed    0         -
01M6K9V9WDXMYVSTHTSQNB2HJ5  2026-11-04T12:52:04.783Z  perf      passed    0         123

$ sw history baseline set main 01M6K9V9WDXM
baseline "main" → 01M6K9V9WDXMYVSTHTSQNB2HJ5

$ sw history diff baseline:main last:1 --engine performance
  baseline  01M6K9V9WDXMYVSTHTSQNB2HJ5
  current   01M6K9Y839C7G09JVCYZEXAYTW
  method    single-run
0 metric regression(s); findings: 0 new, 0 regressed, 0 fixed, 0 unchanged
Single-run metrics: one value per side, no statistics. Movement beyond the change threshold is shown, not significance.
Metrics
│ metric                      │ method     │ baseline │ current │ change │ verdict / movement               │ ci95 │ p (adj.) │
│ performance.http.error_rate │ single-run │        0 │       0 │   0.0% │ within-threshold (no statistics) │    - │        - │
│ performance.http.p95        │ single-run │    122.7 │   127.0 │  +3.5% │ within-threshold (no statistics) │    - │        - │
│ performance.http.p99        │ single-run │    145.4 │   150.3 │  +3.3% │ within-threshold (no statistics) │    - │        - │
│ performance.http.rps        │ single-run │    90.30 │   90.34 │  +0.0% │ within-threshold (no statistics) │    - │        - │
…

$ sw history verify
✔ history intact: 6 run(s) checked, 0 error(s), 0 warning(s)
✔ audit log intact: 63 entries hash-chained (…/sw-shop/.second-world/audit.log)
```

Ids can be shortened to a unique prefix. With one run per side, `diff` shows *movement* but makes no
statistical claim, and exits 0. For a verdict, label at least 5 runs per side and compare the groups.
The diff exits 1 on a significant regression:

```text
$ sw --label before perf -d 3s        # ×5; change something; then:
$ sw --label after perf -d 3s         # ×5
$ sw history diff label:before:5 label:after:5
  baseline  01M6KA2MXRNF4Z4TX2JA63GW8W, 01M6KA2CJJBVBWZ3CV6BAHFDBP, 01M6KA242K44PFKGKS6NHJHBA8, 01M6KA1VG1QN8H2YBW9E92S3CD, 01M6KA1K3FPJ23TWFR1Y2DQ8E8
  current   01M6KA3Z8SQG5P36P33VE0SMDQ, 01M6KA3PS38Y9JVBNYB3CQ5BG0, 01M6KA3EH45ZRA5CVC4MKPSFDM, 01M6KA364W3NZ94EEGXCKBQDVC, 01M6KA2X8CEFS8SFHHBCQVM606
  method    statistical
0 metric regression(s); findings: 0 new, 0 regressed, 0 fixed, 0 unchanged
Metrics
│ metric                      │ method      │ baseline │ current │ change │ verdict / movement    │                  ci95 │ p (adj.) │
│ performance.http.error_rate │ statistical │        0 │       0 │   0.0% │ no-significant-change │                [0, 0] │     1.00 │
│ performance.http.p95        │ statistical │    136.2 │   132.9 │  -2.4% │ inconclusive          │    [-0.0568, 0.00963] │     1.00 │
│ performance.http.p99        │ statistical │    155.5 │   153.2 │  -1.5% │ inconclusive          │     [-0.0519, 0.0280] │     1.00 │
│ performance.http.rps        │ statistical │    89.33 │   89.52 │  +0.2% │ no-significant-change │ [-0.0000112, 0.00358] │     1.00 │
…
```

Here nothing changed between the groups, so no metric regressed. Error rate and throughput are
`no-significant-change`; the p95/p99 confidence intervals are still wider than the ±5 % equivalence band, so
they are `inconclusive` (more runs would settle them). The system test
`tests/system/regression.test.ts` runs the same flow against shop-fastify (seeded vs `FIXED=1`), and
there `diff` reports the p95 regression and exits 1. Use `sw history trend --metric p95` to follow a
metric over time.

## 11. `sw report`: combine and re-render reports

`sw report` turns earlier results into one combined report in any format, without running anything. Inputs are
`report.json` files, `--last` and `--run <id>` (history runs; ids may be prefixes). Files are written only when
`-f` or `-o` is given, so it never overwrites `.second-world/reports/report.json` by accident:

```text
$ sw report --run 01M6K9WDS4 --run 01M6K9WN8J -f md,html -o combined
combined 2 result(s) from 2 source(s)
report: …/sw-shop/combined/report.md
report: …/sw-shop/combined/report.html
```

The verdict is recomputed over all results at `--fail-on`: this one exits 1 (the inspect and bugs findings),
and `sw --fail-on never report …` exits 0. Without `-f`/`-o` it prints the terminal report of the combined runs.

## 12. `sw run`: several engines in one command

A workflow is a DAG of engine steps in the config. Add one to `sw.config.ts`:

```ts
// add inside the exported object in sw.config.ts
workflows: {
  smoke: {
    steps: {
      inspect: { engine: "architecture" },
      api: { engine: "bugs", input: { techniques: ["contract", "boundary"] } },
      load: { engine: "performance", after: ["api"], input: { duration: "5s" } },
    },
  },
},
```

```text
$ sw run --list
smoke  (3 step(s))
  inspect: architecture
  api: bugs
  load: performance after api

$ sw --dry-run run smoke
✔ workflow "smoke" valid: 3 step(s), order inspect → api → load
  ✔ inspect (architecture): input valid
  ✔ api (bugs): input valid, ✔ safety check passed for http://127.0.0.1:3000
  ✔ load (performance): input valid, ✔ safety check passed for http://127.0.0.1:3000
dry run: nothing was sent

$ sw run smoke -f json,html
step: bugs started
step: architecture started
step: architecture failed 0.4s
step: bugs failed 2.0s
step: performance started
…
step: performance passed 7.2s
workflow "smoke": all required steps completed
  ✖ inspect (architecture): failed
  ✖ api (bugs): failed
  ✔ load (performance): passed
history: saved run 01M6KA9XA8Q2CGC6NX07NZESKY
report: …/sw-shop/.second-world/reports/report.json
report: …/sw-shop/.second-world/reports/report.html
```

`inspect` and `api` run in parallel; `load` waits for `api`. `failed` is the engines' status (they found
defects), not a crash: every step completed. The run writes one combined report and one history run labelled
`smoke` (both under the same id), and exits like the combined report (1 here). A step that cannot start (bad input,
blocked target) exits with its own code (2, 3, 5) and skips its dependants. See [09 – CLI & API](09-cli-and-api.md#sw-run).

## Where next

- `sw model build` combines code, the OpenAPI contract and earlier runs into one system graph.
- `sw whatif` / `sw evolve` compare variants or candidate changes with statistics. See [experiments](03-engines/experiments.md).
- Plugins (reporters, rules, assertions, history stores, hooks): [10 – Plugins](10-plugins-and-extensibility.md), `sw plugins list|check`.
- Config reference: [08 – Configuration](08-configuration.md). CLI and API: [09 – CLI & API](09-cli-and-api.md).
- Safety model: [11 – Safety, security & privacy](11-safety-security-privacy.md).
