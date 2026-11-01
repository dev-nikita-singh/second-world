# sw-robust-w8 progress (wave 8, PLAN-wave8 §sw-robust-w8)

## Done
- 1a PROVED+FIXED pid reuse vs history lock: lock of a dead holder whose pid is alive (reused) was only stale after 60 s > 10 s waiter timeout -> LockTimeoutError. Fix fsutil.ts heartbeat (holder utimes lock every 1 s; same-host lock with mtime older than 5 s is stale even if pid alive; also in breakStaleLock recheck). Test tests/unit/robust/pid-reuse.test.ts (before: LockTimeoutError after 2 s; after: acquired at once; live holder not broken).
- main request: SW_CONFIG_OUTDIR hint now "-o/--out <dir>" (run-common.ts). Test tests/unit/robust/outdir-hint.test.ts.
- 1b PROVED+FIXED double Ctrl+C: 10/10 hard aborts during writes left report temps / history body temps / `.lock` / `.lock.tmp-*`. Fix run-common.ts removeOwnTempFiles (sync, pid-named temps in outDir, history, history/runs, .second-world/model, cache/arch, and our own `.lock`) before exit(130). Test tests/integration/robust/double-sigint.test.ts (+ fixtures/double-sigint-writer.ts): after 40/40 runs clean (4 test runs). Not covered: bugs `pending-*` artifact dirs on hard abort (bugs lane).

- 1c PROVED+FIXED shared -o dir: 2/30 rounds of 2 concurrent finishRun into one dir mixed report files of both runs. Decision: keep fixed names (CI paths), write the whole set under `<outDir>/.sw-report.lock` (history withLock; on LockTimeoutError write without it + warn). Hard-abort sweep also removes our report lock. Test tests/unit/robust/shared-outdir.test.ts (after: 0/30 x4 runs). docs/02 §4.6 updated (report, stale lock heartbeat, Ctrl+C rows).
- 1d RESOLVED by sw-sec-w8 (guard.ts dnsTimeoutMs 10 s, tests/unit/security/dns-timeout.test.ts) per main; not touched.
- 1e DISMISSED no jitter: tests/integration/robust/lock-contention.test.ts (+fixtures/lock-contender.ts) 12 procs x 15 appends: 0 failed, 180/180 lines, worst append 1958/1855 ms (incl. startup), slowest process ~2.0 s. No change.

- 3 malformed inputs: tests/unit/robust/malformed-inputs.test.ts (fast-check). FOUND+FIXED 2 exit-70s in history (my lane): (i) index line with id/file but missing fields -> `sw history list` TypeError in pad() (exit 70). Fix jsonl-store.ts isIndexEntry structural check -> line treated as torn (warning, verify lists it). (ii) corrupt/missing/newer-schema run body -> raw SyntaxError/UnsupportedSchemaError (exit 70) on show/diff. Fix loadRun wraps into HistoryError SW_HISTORY_CORRUPT (exit 2 via history.ts withStore). Before: counterexamples ["",[],list] and ["null",gz(empty),diff]; after: 120 runs green. Config json/yaml (80 runs) + ts bodies (10), agent --context (40), contract loaders bugs loadContract + model fromOpenApi (150 each): no exit-70 found. `--dry-run bugs/agent` load the contract (checkBugsSession); the loader is tolerant (e.g. `paths: 5` loads with 0 ops, exit 0) -> no exit 70.

- 2 SOAK: tests/integration/robust/soak.test.ts (+fixtures/soak-entry.ts), opt-in `SW_SOAK=1` (SW_SOAK_DURATION=300, SW_SOAK_RATE=200). 300 s @200 rps vs calibrated server: RSS 55 MB at start, ramps to 225 MB by 25 s, then flat: 225 MB at 60 s, 227 MB at 300 s, peak 231 MB; heap 22-81 MB oscillating, external 7-9 MB. PASS (bounded). The compare windows are the 2nd minute vs the last minute (a 60 s run failed with a 15-60 s window because of the ramp).
- 2 LARGE INPUTS (scratch generators in the session scratchpad: gen-spec.mjs, gen-repo.mjs, catchall.mjs, measure-entry.mts):
  - 1000-op OpenAPI: `--dry-run bugs` 1.9 s / 149 MB peak RSS; `--dry-run agent` 1.4 s / 152 MB; real `sw bugs` (property-runs 2) 5000 req budget 5.7 s / 344 MB; with maxRequests 20000 it stops at 5800 sent (mutations blocked) 6.1 s / 342 MB; real `sw agent --budget requests=3000` 1.9 s / 171 MB.
  - inspect, layered synthetic TS repo: 1000 files 5.0 s/367 MB, 2000 8.2 s/407 MB, 4000 15.1 s/517 MB, 8000 28-38 s/690-730 MB. About linear. CPU profile at 8000: 11.3 s idle (sequential `await readFile` hashing, architecture/engine.ts:207), 4.4 s open, 3.2 s stat: FS-bound.
  - BUG (architecture lane) -> main: deep import graph (2000/4000 files, each imports 2 random files) -> exit 70 RangeError in TS createProgram (findSourceFile/processImportedModules recursion, 1308 frames). noResolve:true verified to fix (4082 files 5.8 s, imports still resolve). Reported to main 06:50Z.
- 4 lazy reporting: NOT done, measured. Reporting chunk import 45-120 ms, ~1 MB RSS; A/B `sw history list` built CLI eager 401 ms vs stubbed 380 ms median (ranges overlap); every engine command loads it in finishRun; lazy would make the sync world.report API async. Comment in world.ts. main: please update docs/16 gap entry.

- main fixes: run-common imports withLock/LockTimeoutError lazily from engines/history/index.js (design R5); malformed-inputs sw() takes readonly string[] (tsc).
- 1e note: under full-suite load the worst append was 6.2 s (0 failures). Bound set to the 10 s lock timeout (the real harm).

## Final verification
- `npx vitest run tests/unit tests/integration/concurrency tests/integration/history tests/integration/robust`: 176 files, 1666 passed / 1 skipped (soak, opt-in) / 1 failed (lock-contention 5 s bound under load; bound relaxed, rerun green). tests/unit/design green.
- tsc: only error is tests/unit/security/guard-fuzz.test.ts:272 (sw-sec-w8). biome --error-on-warnings clean on my files.

## Status
DONE (awaiting main review/commit).

