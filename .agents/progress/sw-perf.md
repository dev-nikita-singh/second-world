# Progress: sw-perf

## Done
- `src/adapters/http/errors.ts` (classifyError: timeout, connect-timeout, econnrefused, econnreset, epipe, dns, socket, aborted, other) and `undici-executor.ts` (one Pool per origin, keepAlive, pre-merged flat headers, byte-counting body drain or buffered body when needed, per-request AbortController timeout, close()).
- `src/engines/performance/`: schema.ts, templates.ts, prepare.ts (scenario compile, extract, data feeder CSV/JSON/JSONL), scheduler/{open,closed,iterations}.ts, metrics.ts, self-check.ts, thresholds.ts, types.ts (PerformanceData), engine.ts (run loop), index.ts (performanceEngine, runPerformance, parsePerformanceInput).
- Tests: 40 unit tests (schema, templates, open schedule, CO, thresholds, errors/prepare, engine with fake transport, self-check) and 7 integration tests against the calibrated server. All 47 pass. tsc and biome are clean for my paths.
- Measured on Windows: closed /fixed/50 gives p50 51.2 ms. Open 100 rps for 3 s gives 300 requests, rps 100.05, sched-lag p99 0.13 ms, CPU 5.7%. Open 1000 rps for 3 s gives 3000 requests, rps 1000, p99 7 ms, generator not saturated.
- CONTRACTS rows marked READY. sw-core and sw-examples have been messaged.

## Follow-ups (done)
- F3: `InFlightIntegrator` in self-check.ts integrates the in-flight count exactly at each request start and end, clipped to the measured window (stop moves the window end). It replaces the 100 ms sampler, which only samples sockets now. The Little's Law rule needs at least 100 completed requests and a window of at least 1 s. Regressions are in tests/unit/performance/littles-law.test.ts and the sw-stress case (50 rps, 20 ms, 1 s and 3 s) in tests/integration/performance/detailed-timing.test.ts.
- Detailed timing: src/adapters/http/phase-timing.ts.
  - Connection phases: a wrapped undici connector plus a wrapped DNS lookup give DNS/TCP/TLS per connection.
  - Request phases: a dispatch interceptor reads `opts.opaque` (a RequestTracker) and times wait, server and transfer per request.
  - Why not diagnostics_channel: undici v8 publishes only beforeConnect/connected (no DNS or TLS split), and request:create cannot be correlated when the Pool queues the request. The socket 'lookup' event is not emitted on the autoSelectFamily path.
  - Basic mode installs nothing. The `timing-detailed-partial` limitation was removed. TLS was verified manually with a self-signed cert (no portable cert generation for tests).
- F5: the executor accepts `lookup` (net.LookupFunction) and passes it via Pool `connect` (also through the timed connector). The engine uses `ctx.safety.lookup` (signature agreed with sw-core). A lookup that fails with SW_SAFETY_* is classified as error kind "safety".
- Tests: 57 perf tests (unit + integration) and the stress suites (88 total) pass. tsc and biome are clean.

## F6 (done): executor uses the guard's checkRedirect and recheckDns
- `createUndiciExecutor({ safety?: ExecutorSafety, dnsRecheckIntervalMs? })`. ExecutorSafety = {lookup?, recheckDns?, checkRedirect?}, duck-typed from ctx.safety; `safety.lookup` is used when `lookup` is not given.
- Redirects: `HttpRequestSpec.followRedirects` (true = 5 hops, or a number). Follows 301/302/303/307/308 manually and calls checkRedirect on every hop.
  - A denied hop gives error kind "safety"; the 3xx status is kept and the hop is not followed. Over the limit gives kind "redirect-limit".
  - 303 (and 301/302 for non-GET) switch to GET without a body. Credentials (authorization, cookie, proxy-authorization) are stripped on cross-origin hops.
  - Result fields `redirects` and `finalUrl`. Step schema has `followRedirects` (default false).
- DNS re-check: lazy timestamp check per host on the request path (first sighting only records the time), at most once per interval (default 10 s). Runs async and is never awaited. IP literals are skipped. The executor exposes `safetyError` and `dnsRechecks`.
- Engine: a kill switch whose reason is SW_SAFETY_DNS_REBIND (or executor.safetyError) aborts in-flight requests. It gives stopReason "safety-abort", status "error", limitation `dns-rebind` (invalidates) and a finding PERF-DNS-REBIND (security, critical, observation). `PerformanceDeps.dnsRecheckIntervalMs` is a test hook.
- Ownership exception (granted by main for F6 only): added `safety: ctx.safety` to the executor construction in src/engines/stress/runner.ts (sharedExecutor got a `safety` param, passed at its single call), src/engines/bugs/http.ts, src/engines/bugs/hooks.ts and src/engines/reliability/runner.ts. Caveat: `biome check --write` was run on those files and reformats whole files. No backup or git to diff against, but tsc and their unit suites pass.
- Tests: tests/unit/performance/f6-safety.test.ts (7): 3xx unfollowed by default, hop limit, 303→GET, a blocked hop, engine redirect steps, recheck rate limit, rebind mid-run → status error. Unit suites for perf, stress, bugs and reliability: 184 passed. Perf integration: 13 passed.

## Safety rate cap in VU models (sw-qa, done)
- engine.ts: closed/iterations reserve maxRps = min(budget.maxRps, safety config maxRps), and every request awaits `lease.throttle()` (GCRA) before the transport call, so the wait is not latency. A VU that receives its token after the schedule end does not start a new iteration (this had inflated rps by about 10%). Limitation `PERF-THROTTLED-BY-SAFETY` (reduces-confidence) when any request waited; `totals.throttled`. The open model still refuses rate > ceiling up front.
- Tests: tests/unit/performance/safety-rate-cap.test.ts (5); tests/integration/performance/safety-rate-cap.test.ts (closed 20 VUs at maxRps 100 for 3 s gives rps ≤ 105 with the limitation; stress 50-VU step at maxRps 200 gives throughput ≤ 210).

## Scenario-level auth (sw-qa, done)
- schema.ts: `AuthRefSchema` = role name string | credential object. Allowed on scenarios (new) and on the section (now also accepts a string).
- prepare.ts: scenario auth overrides section auth for that scenario's steps; explicit step headers still win. A role string that reaches the engine unresolved throws ConfigError SW_CONFIG_AUTH with a hint.
- Ownership exception (main): src/core/world.ts got the helper `resolvePerfAuthRoles(cfg, merged, section, env)` (section + scenarios[i].auth, error `<section>.scenarios.<i>.auth "<role>" is not defined in config.auth`). It is used in buildPerformanceInput, buildStressInput and buildEvolutionInput's default workload; it replaces the two previous section-only blocks. buildWhatIfInput passes call input through unchanged and the Agent does not use perf inputs.
- `sw config validate -c examples/shop-express/sw.config.ts` exits 0. sw-qa's it.fails in tests/system/example-configs.test.ts can be flipped (not edited by me).
- Tests: tests/unit/performance/scenario-auth.test.ts (5); tests/integration/performance/scenario-auth.test.ts (echo server shows each token only on its scenario's requests and none in the result JSON; CLI validate exits 0).
- Suites: unit perf+stress+cli+core 400/400; perf integration 17/17 (plus the new files). tsc clean except model/ and experiments/evolution.ts (not mine).

## In progress
- none. Wave 1 tasks are DONE.

## Next
- Optional: worker_threads sharding (stretch), diagnostics_channel phase timing (timing: "detailed").

## Decisions
- Timeline: [0,warmup) is warm-up (excluded, bucketed by INTENDED start). [warmup, warmup+duration) is measured. rampUp starts at t0. Then a gracefulStop drain, after which in-flight requests are aborted and counted as `interrupted` (excluded from error rate).
- Open model: offsets come from the inverse of the cumulative rate curve, `(x*1000)/rate` (exactly drift-free). Poisson uses unit-rate exponential cumulative counts mapped through the same inverse, so ramp-up gives a correct NHPP. spinMs defaults to 16 on win32 and 2 elsewhere. Spin time is subtracted from generator CPU.
- Closed CO correction: expected interval = per-VU EWMA (α=0.1) of the cycle (iteration duration + mean think), floored at 1 ms. Correction uses LatencyHistogram.recordCorrected and applies to the corrected histogram only.
- An open-model arrival is one scenario iteration. Only the first step is measured from the intended start; later steps are measured from their actual start.
- A failed step (transport, status, assertion, extract) ends the iteration.
- Default maxInFlight = max(64, min(10000, 1.1·rate·timeout)), clamped to safety.config.maxConcurrency. Connections default to min(maxInFlight, 1024) for open and to vus for closed.
- Status: cancelled > error (all requests unreachable) > failed (any threshold fails) > passed.
- Findings: only threshold-breach (PERF-THRESHOLD, high). Confidence is 0.9, or 0.6 if the generator is saturated.
- Templates are seeded (uuid/ulid come from the rng), so runs are reproducible.
- (superseded in Wave 4) workers>1 or "auto" used to add an informational limitation and run single-threaded.

## Blockers / requests
- none

## Wave 4: worker_threads sharding (DONE)
- Done. `workers: N | "auto"` works. "auto" = min(availableParallelism − 1, 8), at least 1. A count of 1 uses the in-process path, unchanged.
- Refactor of engine.ts:
  - `prepareRun` does the safety checks, thresholds, the lease and the caps.
  - `runLoad` is one generator: scheduler, executor, metrics, and the per-generator self-check.
  - `finalizePerformance` builds the result from metrics that may have been merged.
  - `executePerformance` dispatches: if effectiveWorkers > 1 and no executor is injected, it does a dynamic import of sharded.js.
- New files in src/engines/performance/:
  - shard.ts: the split math, `deriveWorkerSeed` (createRng(seed).fork("perf-worker:k")), `planShards`, `snapshotMetrics`, and `mergeSnapshots` (an exact HDR add plus counter sums; the error reservoir is re-sampled with weights; series windows are aligned on the shared t0).
  - sharded.ts: the main thread. It spawns, runs RPC, stops, ticks, merges, and holds `mergeHealth`, `resolveWorkerEntry` and `liveWorkerCount`.
  - worker.ts: the worker entry, which runs `runLoad`.
  - worker-protocol.ts: the message types.
- Splitting:
  - Open model: `ArrivalCurve.shard {count,index}`. Constant arrivals use global arrival indices k, k+N, … (exact interleaving, ramp-up included). Poisson uses unit gaps Exp(mean N), giving rate/N per shard.
  - Closed model: VUs are split by splitEven. Local VU j maps to global VU j·N+k on the ramp (`ClosedSchedulerOptions.startOffset`).
  - Iterations: splitEven.
  - maxInFlight, connections and the request budget (lease.remaining) are also split by splitEven.
  - Template `seq` is strided, so it stays unique across shards. A data feeder partitions rows by idx % N.
- Start: the main thread waits for all workers to send "ready", then sends `startAtEpochMs` = now + 20 ms. Each worker uses t0 = epoch − performance.timeOrigin, so phases align across threads.
- Safety:
  - The worker never resolves DNS itself. The lookup, recheckDns and checkRedirect hooks are RPCs to the main thread's ctx.safety. The executor's checkRedirect may now be async: `await`, with type `SafetyDecision | Promise<SafetyDecision>`.
  - Kill switch, ctx.signal and the lease signal broadcast a stop. Cancel and safety-abort are hard: in-flight requests abort at once. After `workerTerminateGraceMs` (default 2 s) the remaining workers are `terminate()`d. Workers are always terminated at the end, and a worker failure terminates all of them and throws.
  - Closed-model rate cap: each worker has a local GCRA at cap/N (burst ceil(rate/10)). When VUs % N ≠ 0 the limitation `workers-rate-cap-split` (informational) is added.
  - Request budget: each worker gets a quota. Main does lease.take(delta) on every tick and on done.
- abortOnFail: workers attach a metrics snapshot (without windows) to each tick. Main merges them and evaluates.
- Self-check: it runs per worker. A worker uses `process.threadCpuUsage` (GeneratorMonitor uses it only when !isMainThread). mergeHealth gives max of ELD, lag and cpu, sums of rates, inFlight and sockets, reasons prefixed "worker k:", plus `generator.workers` and `generator.perWorker`.
- Report fields: `data.config.workers` and `generator.workers`. With N > 1, `methods.percentiles` mentions the merge.
- Limitations:
  - `workers-unavailable`: no worker entry was found (e.g. a dist built without the perf-worker entry). The run continues in-process.
  - `workers-not-supported`: an executor was injected, or the load is too small to split.
  - `workers-terminated`: some workers never reported.
- Worker entry:
  - Under sources (vitest, tsx): `worker.ts` with `execArgv ["--import", <tsx loader file URL>]`.
  - Under dist: `perf-worker.{mjs,js,cjs}` beside the chunk or one level up.
- dist status:
  - tsdown emits .mjs/.cjs. The perf-worker entry needs this tsdown entry (main must add it): `entry: { index: "src/index.ts", cli: "src/cli/main.ts", "perf-worker": "src/engines/performance/worker.ts" }`.
  - Verified with a temp config built into a scratch dir: `node dist/cli.mjs perf http://127.0.0.1:<p>/ --rate 1000 --duration 3s --warmup 1s --workers 2` gives workers 2, 3000 requests, 1000 rps. `--workers auto` gave 8 workers.
  - The official `npx tsdown` dist (without the entry) falls back to `workers-unavailable`.
- CLI: `sw perf --workers <n|auto>` (main.ts and commands/perf.ts).
- Tests:
  - tests/unit/performance/shard.test.ts (13): auto/effective counts, splitEven property, planShards, seeds, open-shard union equals the global schedule, Poisson rate/N, exact merge (open and closed CO-corrected; encode equal), mergeHealth, entry resolution.
  - tests/integration/performance/workers.test.ts (9): open 400 rps within 5%, closed 10 VUs, iterations exact 101, cancel quickly with 0 live workers, maxRps 100 across 2 workers ≤ 105, DNS through the guard (1 resolution), redirect via RPC, kill switch, DNS rebind gives an error.
  - Suites: perf unit + stress unit + perf integration 135/135; cli/reliability/experiments unit + stress integration 175/175. tsc is clean for my files; the one error is in src/engines/bugs/cases.ts (not mine).
- Measured (tsx, child server, /fixed/5, 3 s): achieved = target exactly, with 0.00% error, at 400, 1000 and 1900 rps for both 1 and 2 workers.
- Cold start:
  - Workers start cold (JIT). Without warmup, the first-second p99 is about 40 ms with 2 workers versus about 25 ms with 1. With `warmup: 1s` they are the same (about 10 ms).
  - Per-worker scheduling-lag p99 is about 10 ms under tsx and about 2 ms from dist.
- Known gaps:
  - The live merge happens only for abortOnFail. perf.tick is summed from per-worker payloads, and its p95/p99 is a max (approximate).
  - On cancel, sharded mode interrupts in-flight requests at once (in-process waits for gracefulStop).
  - Series windows older than 120 s are merged approximately (max of percentiles).
  - Each worker rechecks DNS independently, so there are N× rechecks.
  - Decoded HDR `max` is the bucket's highest equivalent value (within 10^-digits).
  - The tty and markdown reporters (src/engines/reporting, not mine) do not print the worker count yet.
