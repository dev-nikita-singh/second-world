# Quickstart: investigate `shop-express` in 15 minutes

This walkthrough runs every main SECOND WORLD engine against **shop-express**, the bundled Express
example app. It contains ten documented, deliberately seeded defects (see
[`examples/shop-express/README.md`](../examples/shop-express/README.md) and its `expected-findings.json`).
You will measure the app, stress it, inspect its code, hunt API bugs, inject a fault, compare runs and
summarise them.

All output below was captured on Windows 11 / Node 24 and trimmed (`…`). Your numbers will differ.

> Only point SECOND WORLD at systems you own or are authorised to test. The defaults allow
> loopback targets only.

## 0. Prerequisites

- Node.js **≥ 22.19** (`node --version`), git.
- A clone of this repository with its dependencies installed (`npm install` in the repo root).
- SECOND WORLD runs from source for now. Define a `sw` shortcut that points at the CLI entry:

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
✔ docker 29.3.0
ℹ toxiproxy not found
ℹ k6 not found
ℹ non-TTY output (line-based progress)

0 problem(s), 0 warning(s)
```

Missing optional tools (Toxiproxy, k6) only disable the features that need them.

## 3. `sw init`: scaffold a config

```text
$ sw init
✔ wrote …/sw-shop/sw.config.ts
✔ added .second-world/ to .gitignore
ℹ detected: npm, OpenAPI openapi.yaml
next: start your service, then `sw doctor` and `sw perf`
SECOND WORLD is for testing systems you own or are explicitly authorised to test.
```

The generated `sw.config.ts` has local-only safety defaults: `allowHosts` loopback only,
`allowPublic: false`, `allowMutations: false`, and budgets `maxRps: 500`, `maxDuration: "15m"`. It also
has starter `performance`, `stress`, `architecture`, `bugs` and `report` sections. Run `sw init --force` to overwrite.

For this walkthrough, switch to the example's ready-made config, which has scenarios, auth roles and a reset hook.
Then append a `reliability` section that tells the Reliability Lab where to put its fault proxy:

```bash
cp /path/to/second-world/examples/shop-express/sw.config.ts .
```

```ts
// add inside the exported object in sw.config.ts
reliability: {
  dependencies: {
    // built-in fault proxy on :4011 → payments-fake (target "payments")
    payments: { injector: "builtin", upstream: "payments", proxyListen: 4011 },
  },
  workload: {
    rate: 5,
    routes: [
      {
        name: "orders",
        method: "POST",
        path: "/orders",
        headers: { "content-type": "application/json", authorization: "Bearer alice-token" },
        body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
        dependsOn: ["payments"],
      },
    ],
  },
},
```

```text
$ sw config validate
✔ config valid (…/sw-shop/sw.config.ts)
⚠ reliability.workload.routes[0].headers.authorization: value in sw.config.ts looks like a secret; use { env: "NAME" } or { file: "path" } instead
⚠ auth.admin.token: value in sw.config.ts looks like a secret; use { env: "NAME" } or { file: "path" } instead
…
```

The warnings are expected here because the example uses demo tokens. In a real project, write
`token: { env: "API_TOKEN" }`. Resolved secrets are redacted from logs and reports.

## 4. `sw perf`: Performance Lab

The config runs an open-model load at 50 iterations/s with weighted scenarios (browse, browse with
reviews, checkout) and two thresholds. `--duration` overrides the config:

```text
$ sw perf --duration 10s
[1s warmup] rps=87.9 p95=0.0ms errors=0 inFlight=3
[6s measure] rps=93.0 p95=129.5ms errors=0 inFlight=1
[11s measure] rps=96.0 p95=17.7ms errors=0 inFlight=1
SECOND WORLD run 01M62MFGASDQ4JGBPSJDWSYR2Z · 12.0s · 0.1.0-dev
✔ PASS (exit 0, fail-on high) completed: no failing thresholds or findings at or above 'high'

[performance] passed 12.0s
target http://127.0.0.1:3000  model open/constant  measured 10.0s  stop completed
┌──────────┬─────┬────────┬──────┬────────────┬────────┬───────┬───────┬───────┐
│ requests │  ok │ failed │  rps │ error rate │    p50 │   p95 │   p99 │   max │
├──────────┼─────┼────────┼──────┼────────────┼────────┼───────┼───────┼───────┤
│      903 │ 903 │      0 │ 90.3 │      0.00% │ 9.57ms │ 132ms │ 158ms │ 168ms │
├──────────┴─────┴────────┴──────┴────────────┼────────┼───────┼───────┼───────┤
│                   raw (uncorrected) latency │ 9.54ms │ 132ms │ 158ms │ 168ms │
└─────────────────────────────────────────────┴────────┴───────┴───────┴───────┘
rate target 50/s — achieved 50/s
┌─────────────────────────────┬──────────┬──────┬────────┬────────┬────────┬────────┐
│ endpoint                    │ requests │  rps │ errors │    p50 │    p95 │    p99 │
├─────────────────────────────┼──────────┼──────┼────────┼────────┼────────┼────────┤
│ GET /products               │      456 │ 45.6 │  0.00% │ 9.39ms │  143ms │  161ms │
│ GET /products/{{rand 1 20}} │      403 │ 40.3 │  0.00% │ 8.54ms │ 15.8ms │ 17.3ms │
│ POST /orders                │       44 │  4.4 │  0.00% │ 44.2ms │ 58.0ms │ 60.1ms │
└─────────────────────────────┴──────────┴──────┴────────┴────────┴────────┴────────┘
generator: event-loop p99 22.4ms, cpu 4%, lag p99 0.25ms
Thresholds
│ ✔ │ http.p95: < 200ms     │  132ms │
│ ✔ │ http.error_rate: < 1% │  0.00% │
report: …/sw-shop/.second-world/reports/report.json
history: saved run 01M62MFW5T84WD8Y98EECREQTJ
```

How to read it:
- "Rate target 50/s" counts scenario iterations. `rps` counts HTTP requests, and the browse scenario sends two.
- `GET /products` has a p95 about 10x higher than `GET /products/{id}`. That gap comes from the seeded
  N+1 query behind `?include=reviews`, which the endpoint table groups under `GET /products`.
- The `generator` line is the load generator's self-check. A saturated generator would invalidate the run.
- Every run is saved to history (`--no-history` skips that). Reports go to `.second-world/reports/`, and
  **each run overwrites `report.json`**. Use `-o <dir>` to keep one directory per run, and
  `-f tty,json,md,junit,sarif,html` to choose formats.

## 5. `sw stress`: Stress & Capacity Lab

```text
$ sw stress --steps 10,25,50 --hold 5s
stage 0 step 10 VUs level=10 → passed p95=79.1ms tput=505.8/s err=0.00%
stage 1 step 25 VUs level=25 → passed p95=72.2ms tput=511.2/s err=0.00%
stage 2 step 50 VUs level=50 → passed p95=81.2ms tput=514.0/s err=0.00%
✔ PASS (exit 0, fail-on high) completed: no failing thresholds or findings at or above 'high'

[stress] passed 15.8s
  mode         step
  load type    virtual users (closed)
  target       http://127.0.0.1:3000
  stop reason  completed
Capacity
  Highest tested load that met all requirements in this environment: 50 VUs (514.0 rps achieved). This is not a maximum capacity.
  tested capacity  50 VUs
Stages
│ # │  level │ status │ throughput │    p50 │    p95 │   p99 │ error rate │
│ 0 │ 10 VUs │ passed │    505.8/s │ 6.37ms │ 79.1ms │ 111ms │      0.00% │
│ 1 │ 25 VUs │ passed │    511.2/s │ 12.2ms │ 72.2ms │ 146ms │      0.00% │
│ 2 │ 50 VUs │ passed │      514/s │ 12.9ms │ 81.2ms │ 142ms │      0.00% │
  first breach  none
  knee          none detected
Estimates (model fit, not measured)
USL estimate refused: USL needs at least 5 valid stages (got 3)
```

Capacity is always stated as **tested** capacity. Model-fit estimates (USL) appear in a separate section,
and only when there is enough data. Other modes are `--mode ramp|spike|soak|breakpoint`. For a
breakpoint search, use `--rate-from/--rate-to/--step`.

> Notice that throughput is flat at about 510/s: the example config sets `safety.maxRps: 500`, and the
> safety guard throttles every load model to it. Here the cap was measured, not the app (an earlier run
> without the cap reached 2945 req/s at 50 VUs). Raise `safety.maxRps` (for example
> `sw --set safety.maxRps=5000 stress …`) to find the app's limit. The stress report does not yet
> mention the cap explicitly.

## 6. `sw inspect`: Architecture Inspector

This is static analysis only. Nothing from the project is executed.

```text
$ sw inspect
✖ FAIL (exit 1, fail-on high) 2 finding(s) at or above severity 'high'

[architecture] failed 908ms
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
opt-in is written to the audit log. The concurrency test checks that the last item in stock (product 20, stock 1)
is sold only once:

```text
$ sw --yes bugs --allow-mutations --concurrency-test "POST /orders" --burst 5 --role user --body '{"items":[{"productId":20,"qty":1}]}' --invariant linearizable:stock:1
technique contract: 12 requests, 1 finding(s), 0.3s
technique boundary: 43 requests, 4 finding(s), 1.2s
…
technique concurrency: 5 requests, 7 finding(s), 0.1s
technique replay: 36 requests, 7 finding(s), 1.2s
✖ FAIL (exit 1, fail-on high) 3 finding(s) at or above severity 'high'

[bugs] failed 9.9s
  contract   shop-express (intended contract) v3.1 (11 operations)
  requests   396 sent, 18 replays, 27 hook runs
Coverage
  operations exercised            11/11
Bug findings (7)
│ classification    │ severity │ rule                          │ operation          │ technique   │ replays                                       │
│ reproduced-defect │ critical │ bugs/bola                     │ GET /orders/{id}   │ auth        │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │
│ reproduced-defect │ high     │ bugs/idempotency-key-ignored  │ POST /orders       │ stateful    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │
│ reproduced-defect │ high     │ bugs/race-lost-update         │ POST /orders       │ concurrency │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │
│ reproduced-defect │ medium   │ bugs/schema-mismatch          │ GET /products/{id} │ contract    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │
│ reproduced-defect │ medium   │ bugs/server-error-on-boundary │ POST /cart/items   │ boundary    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │
│ reproduced-defect │ medium   │ bugs/server-error-on-boundary │ POST /orders       │ boundary    │ reproduced 3/3 (Wilson 95% CI 43.85%–100.00%) │
│ observation       │ info     │ bugs/accepts-invalid-input    │ GET /products      │ boundary    │ observed (not replayed)                       │
Reproductions
Credentials are never printed: export SW_AUTH_<ROLE> (e.g. SW_AUTH_USER='Bearer …') before running these commands.
bugs/schema-mismatch on GET /products/{id} (seed 42) — /price must be number (value "7.50")
    curl -sS -X GET 'http://127.0.0.1:3000/products/1'
…
```

All six seeded API defects are reproduced, and each failure was replayed 3 times before being called a
`reproduced-defect`. Each finding's reproduction is stored under `.second-world/artifacts/`, and
`sw replay <fingerprint>` re-runs it.

> Known issue being fixed: some printed curl commands are not yet copy-paste ready. The auth header
> placeholder and the BOLA repro's `{{…}}` path variable are being reworked. `sw replay` is not
> affected, because it replays the stored case directly.

## 8. `sw reliability run`: Reliability Lab

Fault injection is disruptive, so it needs `--approve-disruptive` (or `--yes`). Target the second shop on :3002. Its payments
calls go through :4011, where the Reliability Lab now starts its fault proxy:

```text
$ sw reliability list
dependency-latency     Dependency latency
dependency-timeout     Dependency black-hole (timeout)
dependency-5xx         Dependency returns 5xx
…

$ sw --approve-disruptive reliability run dependency-5xx --target http://127.0.0.1:3002 --dependency payments --steady-phase 3s --duration 5s --recovery 5s
fault applied (run 0)
fault reverted (run 0)
✖ FAIL (exit 1, fail-on high) 1 finding(s) at or above severity 'high'

[reliability] failed 13.1s
  scenario     dependency-5xx
  fault        HTTP 503
  injector     builtin-proxy
Experiment timeline
│ phase    │ duration │ requests │ error rate │ timeouts │    p50 │    p95 │ rps │
│ steady   │     3.0s │       16 │      0.00% │        0 │ 76.9ms │ 94.5ms │ 6.3 │
│ fault    │     5.0s │       21 │      0.00% │        0 │ 1445ms │ 4841ms │ 4.2 │
│ recovery │     5.0s │       24 │      0.00% │        0 │ 72.1ms │ 94.7ms │ 4.7 │
p95 per second ▁▁█▇▆▄▃▂▁▁▁▁▁ 71.3..5062.5 ms
                  ^^^^^      fault window (5.0s)
Detectors
│ retry amplification  │ FLAGGED │ 1425x dependency calls per request (…; 28171 calls / 21 requests) — retry storm │
│ recovery             │ ok      │ recovered in 0ms (…)                                                           │
Single repetition: detector hits are observations. Use repeat ≥ 2 to classify reproduced defects.
Findings (2)
│ ✖ high   │ observation │ Retry storm: 1425.3x dependency calls per request to payments (unbounded retries without backoff) │
```

The shop never returned an error. Instead it retried payments about 1400 times per order: that is the seeded
`unbounded-retry` defect. With `--repeat 2` or more, a detector that hits in every repetition becomes a
`reproduced-defect`. The fault is always reverted, even on Ctrl+C. To double-check:

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
analyzing history run 01M62MQBWYBXP07CFTNDPDDVXC
1 run(s) (reliability) produced 2 finding(s), 1 of severity high or critical.
- Severity: 1 high, 1 info.
- Evidence strength: 2 observation.
- [high] Retry storm: 1544.3x dependency calls per request to payments (unbounded retries without backoff) (reliability, observation).
…
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
…                           (newer runs trimmed)
01M62MN77M1M2RWBZ96HMX44H9  2026-10-29T01:33:42.004Z  perf      passed    0         139
01M62MMEG9XRB5KH14KRWK6BK8  2026-10-29T01:33:16.681Z  reliability failed    2         -
01M62MJS1PRTGZDJFSG8HAS0GS  2026-10-29T01:32:21.942Z  bugs      failed    7         -
01M62MJ4VFP81024AXNEJ2E86M  2026-10-29T01:32:01.264Z  inspect   failed    6         -
01M62MGNS3B1S1Y8YSR79TK6TC  2026-10-29T01:31:13.059Z  stress    passed    0         -
01M62MFW5T84WD8Y98EECREQTJ  2026-10-29T01:30:46.843Z  perf      passed    0         132

$ sw history baseline set main 01M62MFW5T84
baseline "main" → 01M62MFW5T84WD8Y98EECREQTJ

$ sw history diff baseline:main last:1 --engine performance
  baseline  01M62MFW5T84WD8Y98EECREQTJ
  current   01M62MR0XWCYCFF01816646W1R
  method    single-run
0 metric regression(s); …; 2 metric(s) moved worse in a single-run comparison (no statistics): performance.http.p95, performance.http.p99
│ performance.http.p95        │ single-run │    131.6 │   150.5 │ +14.4% │ worse (no statistics)            │
│ performance.http.rps        │ single-run │    90.30 │   89.33 │  -1.1% │ within-threshold (no statistics) │

$ sw history verify
✔ history intact: 6 run(s) checked, 0 error(s), 0 warning(s)
```

Ids can be shortened to a unique prefix. With one run per side, `diff` shows *movement* but makes no
statistical claim, and exits 0. For a verdict, label at least 5 runs per side and compare the groups.
The diff exits 1 on a significant regression:

```text
$ sw --label before perf -d 3s        # ×5; change something; then:
$ sw --label after perf -d 3s         # ×5
$ sw history diff label:before:5 label:after:5
  method    statistical
0 metric regression(s); findings: 0 new, 0 regressed, 0 fixed, 0 unchanged
│ metric                      │ method      │ baseline │ current │ change │ verdict / movement    │                ci95 │
│ performance.http.p95        │ statistical │    141.7 │   141.6 │  -0.1% │ no-significant-change │  [-0.0225, 0.00452] │
│ performance.http.p99        │ statistical │    156.5 │   161.0 │  +2.9% │ no-significant-change │  [-0.00873, 0.0440] │
```

Here nothing changed between the groups, so the verdict is `no-significant-change`. The system test
`tests/system/regression.test.ts` runs the same flow against shop-fastify (seeded vs `FIXED=1`), and
there `diff` reports the p95 regression and exits 1. Use `sw history trend --metric p95` to follow a
metric over time.

## Where next

- `sw model build` combines code, the OpenAPI contract and earlier runs into one system graph.
- `sw whatif` / `sw evolve` compare variants or candidate changes with statistics. See [experiments](03-engines/experiments.md).
- Config reference: [08 – Configuration](08-configuration.md). CLI and API: [09 – CLI & API](09-cli-and-api.md).
- Safety model: [11 – Safety, security & privacy](11-safety-security-privacy.md).
