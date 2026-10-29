# Progress: sw-reliability

## Status: DONE (all deliverables). 62 tests pass + 1 skipped (Docker live test; daemon not running). tsc: 0 errors repo-wide.

## Done
- Adapters `src/adapters/faults/`: types.ts (FaultSchema, FaultInjector, selectByCounter, flapActive), cleanup.ts
  (CleanupStack LIFO, global stack + SIGINT/SIGTERM/SIGBREAK/uncaughtExceptionMonitor/exit hooks installed only
  while non-empty, armTtl, ledger file, detached watchdog process, cleanupAll), builtin-proxy.ts (http + tcp modes),
  external.ts (base for out-of-process injectors: ledger + watchdog + TTL + flapping emulation), toxiproxy.ts
  (REST via fetch), docker.ts (execa CLI), index.ts.
- Engine `src/engines/reliability/`: detectors.ts (pure), schema.ts, scenarios.ts (10 scenarios), types.ts,
  runner.ts (experiment loop + analysis), findings.ts, index.ts (reliabilityEngine, runReliability,
  parseReliabilityInput, listScenarios, cleanupAll).
- Tests: unit (proxy 14, cleanup-injectors 11, detectors 18, engine 11) and integration (shop-fastify 1,
  shop-fastify-timeout 1, shop-express 2, precision 3, crash-cleanup 2 + 1 docker skipIf). Each integration file < 30 s.
- Detection results: fastify retry-no-jitter → retry-without-jitter (reproduced-defect 2/2, lag ~60 ms, z≈20);
  fastify no-circuit-breaker → no-circuit-breaker (reproduced 2/2, 3.9 calls/request late in fault); express
  unbounded-retry → retry-without-backoff (amplification > 10x); express no-timeout-outbound → outbound-no-timeout.
  Precision: fastify outbound timeout recognised (effective ~8.2 s = 4×2 s + delays, not flagged); mini-app with
  timeout+full-jitter+breaker → breaker detected, zero defects; full jitter w/o breaker → no jitter finding.
- CONTRACTS.md section added (READY). main messaged with CLI wiring notes.

## Decisions
- Workload: ONE continuous runPerformance run (open, Poisson) per repetition; recording HttpExecutor via
  deps.executor captures per-request records; route tagged by `x-sw-route` header. Phases cut by clock time.
  Steady stats only use requests that also finished before the fault.
- Failure = transport error or 5xx (4xx are app answers). Windows = 1 s by request start.
- Blackholed http requests are held and forwarded on revert (models recovery), destroyed on close.
- Jitter detector: pairwise-lag histogram (10–1000 ms, 5 ms bins); 20 ms peak window vs p90 of all 20 ms windows,
  z ≥ 5 and ≥ 1.25x. p90 (not median) because Windows timer ticks (15.6 ms) put setTimeout-driven retries on a
  lattice → periodic peaks everywhere (caused a false positive with full jitter before the change).
- Amplification: steady baseline used only with ≥ 10 steady requests. > 10x → retry-without-backoff;
  jitter hit → retry-without-jitter (includes amplification evidence, no separate storm finding); else > 3x → retry-storm.
- Breaker: needs a sustained (≥ 90 %, non-flapping) fault ≥ 3 s; late-half calls/request vs baseline.
- Timeout: only for 100 % black-hole; no answers during fault + latency tracking revert/client timeout → no-timeout.
- Engine does not add findings to ctx.evidence (World does, per sw-core). Engine reverts only its own faults
  on injectors passed via deps; injectors it creates are closed.
- Docker revert treats "no such container"/"not paused" as already reverted (apply never tolerates errors).

## Gaps / follow-ups
- Toxiproxy/Docker only tested against a fake REST server / fake exec (no live daemon here); docker live test skipIf.
- Isolation uses `dependsOn` from config (System Model later). Duplicate-operation invariant checks not implemented.
- CLI `sw reliability list|run|cleanup` not wired (owner sw-core / main).
- One biome style warning (optional chain) in runner.ts.

## Blockers / requests
- none

## Wave 4

### Status: DONE: duplicate-operation invariants. 239 tests pass across tests/unit/reliability, tests/integration/reliability and tests/unit/reporting (+1 docker skip). tsc: 0 errors.

### Done
- `src/engines/reliability/invariants.ts` (new):
  - Schemas: `IdempotencySchema` (route-level) and `InvariantSchema` (no-duplicates | count-matches | conserved).
  - Iterative path helpers: selectPath (`a.*.b`, `[]`), itemsOf, sumField.
  - `OpLedger`: exact per-route counters; per-key detail capped at 20k; key = `sw-<10 chars of newId>-r<run>-<n>`.
  - `opExecutor`: one key per logical operation, retries with the same key (backoff·2^k), `$SW_OP_KEY` marker substituted in path/body/headers.
  - Pure evaluators: evalNoDuplicates, evalCount, evalConserved.
  - Collection fetcher (safety-checked, 32 MiB cap, 100k items cap).
  - Also takeBaselines, evaluateInvariants and invariantDetections.
- Schema:
  - `workload.routes[].idempotency {header, retries, backoff, retryOn}`.
  - Top-level `invariants[]` (max 20).
- Runner:
  - Baselines are taken before the workload starts; ledger.phase is set to steady/fault/recovery.
  - Invariants are evaluated after the recovery phase.
  - RunAnalysis gets `invariants?` and `operations?`.
  - Detections use `group` (one finding per invariant) and `notes` (evidence); everything is redacted with createRedactor (route and invariant header values plus the built-in patterns).
  - validateInvariants raises ConfigError for unknown routes/headersFrom and for no attributable route.
- Findings:
  - Rule IDs: `reliability/duplicate-operation` (no-duplicates, count excess), `reliability/lost-write` (count deficit), `reliability/invariant-violated` (conserved). All severity high.
  - Classification follows the existing trust ladder: observation, or reproduced-defect when hit in every one of ≥ 2 runs.
  - The summary observation lists each invariant's verdict.
- Reporting: an "Invariants (after recovery)" table and a "Logical operations" table; `invariantRows()` is exported.
- Tests:
  - unit/reliability/invariants.test.ts: 17 tests.
  - unit/reporting/reliability.test.ts: +2 tests.
  - integration/reliability/invariants.test.ts: 3 tests, ~22 s.
    - In-test store behind the proxy with a slow-body fault (response lost after the POST was applied). The buggy store gives reproduced-defect 2/2 for all 3 invariants; the idempotent store gives no finding.
    - shop-express `idempotency-ignored`: black-holed payments with an 800 ms client timeout; count-matches flags the excess.

### Decisions
- Ambiguous = timeout/reset/5xx with no success; it may have been applied once, so it widens the upper bound.
- A 4xx after an ambiguous attempt counts as ambiguous, not rejected.
- Unsent = refused/DNS/safety.
- no-duplicates `scope: workload` (default) only checks keys this run generated. If none of them are found, the result is "error", not "held".
- The builtin proxy's latency/reset faults never forward after the client gives up, so they cannot cause duplicates. slow-body (with a client timeout) and blackhole (the app's held outbound call) do.

### Gaps / follow-ups
- Core: RESOLVED. main added "invariants" to RELIABILITY_KEYS. tests/unit/reliability/invariants-config.test.ts (2 tests) checks that it flows from sw.config: loadConfig → buildReliabilityInput → parseReliabilityInput, including headersFrom using auth-resolved headers. Final run: 241 tests pass.
- docs/03-engines/reliability-lab.md does not yet document the `invariants` / `idempotency` config (docs owner).
- shop-fastify has no collection endpoint (no GET /orders), so it is not covered. Concurrent same-key races are only caught if the workload sends the same key concurrently, which it does not.
- Collections are read with a single request (no pagination).
