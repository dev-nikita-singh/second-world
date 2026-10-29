# Progress: sw-stress

## Done
- Stress Lab: src/engines/stress/{schema,planner,analysis,usl,runner,types,index}.ts. Tests: unit 28 (planner props, analysis, runner w/ fake stages), integration 3 (step cliff, breakpoint bisection, spike recovery) — all pass, tsc clean.

- History: src/engines/history/{fsutil,jsonl-store,compare,metrics,migrations,git,types,index}.ts. Tests: unit 22 (store CRUD, crash leftovers, lock contention/stale/timeout, verify corruption, prune, v0 migration, finding diff, regression power, A/A FPR, single-run labelling, Holm, trend, git), integration 2 (two perf runs saved+diffed; stress result stored).
- TOTAL 55 tests passing (unit 50, integration 5; integration ~25 s per file, each test < 20 s, stable over 3 runs). tsc clean for my paths; biome clean.
- CONTRACTS.md "sw-stress" section READY. main messaged with wiring and reporting notes (2026-10-29).
- Status: DONE (Wave 2 sw-stress).

- Follow-up (sw-qa: safety rate cap), DONE:
  - Stages throttled by the safety rate cap are marked `capped` (perf limitation PERF-THROTTLED-BY-SAFETY or totals.throttled > 0). Optional `capped`/`throttled`/`capRps` on StageResult; `capRps` is parsed from the perf limitation message.
  - Limitation STRESS-SAFETY-RATE-CAP. Impact is "invalidates" if the capacity stage, or any stage at or above the knee (knee computed over all valid stages), is capped; otherwise "reduces-confidence". The message names the cap: "safety.maxRps N req/s", or "budget.maxRps" when budget.maxRps ≤ the cap.
  - The capacity statement says "(… rps, limited by safety.maxRps N req/s; the target's capacity was not reached)" and sets `capacity.limitedBySafetyCap`.
  - Knee and USL are computed from uncapped stages only, with a note in `StressData.notes`. Also added `StressData.safetyCap`.
  - Breakpoint mode stops at the first capped stage (stopReason "safety-cap").
  - Reporting (ownership exception): src/engines/reporting/blocks.ts puts "CAPPED" in the stage table's last cell (header unchanged, so the existing md header test still passes), adds a warning line for safetyCap, and renders notes.
  - Tests: 5 unit tests (runner.test.ts "safety rate cap") and 1 integration test (maxRps 200 via createSafetyGuard against the child server; asserts capped, limitation, statement, and "CAPPED" in the md render).
  - Coordinator: StageResult `capped`/`throttled` are optional, so the tests/fixtures/reports.ts fixture and older stored reports type-check. tsc reports 0 errors.
- Overshoot (514 vs 500 rps) cause = GCRA burst tolerance, not window edges. guard.ts reserve() uses burst = ceil(maxRps/10) cells on a FRESH lease per perf run (one per stage). With warmup/settle 0, the whole burst lands in the measured window. Measured at maxRps 200 (burst 20): settle 0 gives 209 rps over 2 s (+18 req) and 203.6 over 5 s (+18 req); settle 300 ms gives exactly 200.0 for both. The extra is a constant ≈ burst per stage, i.e. +burst/hold rps. Repro with 500/5 s predicts 510; the remaining ~+4 rps in the 514 was not reproduced here. Guard untouched; reported to main. A stress-side mitigation (min settle ≥ 1000·burst/maxRps ms when a cap applies) was not applied.
- Test robustness: the integration tests carry retry: 2, because under parallel-suite CPU contention perf's self-check can flag saturation and stress then correctly refuses conclusions. The breakpoint integration test now uses VUs (/capacity/4?ms=40, p95<105ms → deterministic boundary 8|9, since queueing latency is ceil(V/4)·40 ms). The open-model scheduling-lag rule (p99 > max(10% interval, 2 ms)) tripped under contention and also on a cold first run in a process (one ~3.4 ms outlier on a 50-sample stage → p99 = max). Reported to main as a perf self-check sensitivity issue.
- Verified: tsc 0 errors; stress, history and reporting suites 215/215, three consecutive parallel runs green; biome clean on touched files.

## In progress
- none

## Next (optional / gaps)
- node:sqlite backend (createHistoryStore({backend:"sqlite"}) currently falls back to JSONL with fallbackReason).
- Fixed-arrival mode is covered by step/breakpoint with loadType "rate"; there is no separate mode.
- Soak memory drift (needs server metrics source).
- Architecture snapshot diff in history (needs the model engine).

## Decisions
- Coordinator routing: wiring notes go to `main` (NOT sw-core) when READY.
- Stress input = perf base keys + stress keys (STRESS_KEYS); base validated with a representative stage.
- settle = per-stage perf `warmup` (load runs, excluded from metrics). Base warmup only on the first stage.
- gracefulStop defaults to 1 s per stage unless given (fast transitions; spike recovery visibility).
- sw-examples added /capacity/:n?ms=&maxQueue= (n workers, FIFO queue; knee at n*1000/ms rps).

- Integration tests run the calibrated server in a CHILD process (tests/integration/stress/child-server.ts): its precise-timer spin otherwise inflates generator CPU → false saturation.
- Perf self-check "Little's Law mismatch" alone → NOT saturation for stress (limitation STRESS-GENERATOR-LITTLES-LAW, reduces-confidence). Cause: 100 ms in-flight sampler aliases with constant arrivals (50 rps / 20 ms gave L=2.00 vs λW=1.03). Reported to main.
- Tested capacity = highest passing level strictly below the lowest breaching level (conservative). Breakpoint mode status "passed" (breach expected; finding severity low); other modes status "failed" on breach.
- Window-level abort: perf.tick p95/p99/error_rate for http-scope thresholds, k consecutive measure-phase ticks → abort stage via per-stage AbortController (stage = breached, abortedEarly).
- Shared connections (isolateStages=false): one undici executor wrapped with no-op close() injected via PerformanceDeps.executor.
- Spike recovery baseline = median pre-spike window p95; tolerance max(10%, 1 ms); 3 consecutive windows; time includes gap between spike end and recovery-stage measure start.
- Soak drift: buckets (default 10 s), Theil–Sen + Sen's rank CI (Kendall), drift iff slope>0 and CI lower>0; CUSUM warmup = first quarter.
- Regression power (compareRuns, r=5 vs 5, 20% p95 shift, 200 seeds): detection 100% at CV 3%, 97.5–98% at CV 5%, 89.5–94% at CV 6%, 65–75% at CV 8%. A/A FPR 2.5% throughout (≤ 5%). The unit test uses CV 5% (≥ 95% of 40 seeds) and 100 A/A trials (≤ 5%).
- compareRuns compares PRIMARY_METRICS by default (http p95/p99/error_rate/rps + stress capacity) because Holm costs power for every extra metric. Single run per arm → method "single-run", verdict always "inconclusive" plus movement worse/better/within-threshold (10%).
- History: index runs.jsonl (last line wins, corrupt lines skipped and reported by verify). Reports are gz with sha256 of the gz bytes. baselines.json is replaced atomically. Prune rewrites the index atomically under the lock and compacts by default (keeps the summary, so trends still work). appendLine starts on a new line when the file ends in a partial line.
- Lock: O_EXCL .lock containing {pid, host, at, token}. Stale = older than 60 s, or a dead pid on the same host. An unreadable lock is judged by mtime. Stale locks are broken via rename-then-unlink.
- USL: grid search (σ, log κ) with closed-form λ, 5 refinement rounds; refused <5 pts or R²<0.9; rate mode uses mean in-flight as N.

## Blockers / requests
