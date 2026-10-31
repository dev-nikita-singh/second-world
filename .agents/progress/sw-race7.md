# sw-race7 progress (wave 7, Plan §A)

## Persistent-state write map (step 1)

| # | What | Where (file:line) | Mechanism before wave 7 | Owner |
|---|---|---|---|---|
| W1 | History index `runs.jsonl` | src/engines/history/jsonl-store.ts append → fsutil.ts appendLine | O_APPEND + fsync, inside `.lock` (O_EXCL lock file, stale = >60 s old or dead local pid) | me |
| W2 | History run bodies `runs/<id>.json.gz` | jsonl-store.ts append → fsutil.ts atomicWrite | temp `.tmp-<pid>-<rand>` + fsync + rename (retry EPERM/EBUSY), inside lock | me |
| W3 | Baselines `baselines.json` | jsonl-store.ts setBaseline | read-modify-write inside lock, atomicWrite | me |
| W4 | Index rewrite by prune | jsonl-store.ts prune | atomicWrite inside lock | me |
| W5 | world.history.save | src/core/world.ts history.save | get(runId) then append(id=runId) (ids are ULIDs) | me |
| W6 | Report files report.{json,md,junit.xml,sarif,html} | src/cli/run-common.ts finishRun → src/engines/reporting/json.ts writeFileAtomic | unique temp + rename (retry); fixed names → last writer wins per file | reporting (not mine) |
| W7 | Bugs artifacts | src/cli/commands/bugs.ts:287-310 (pending-<ulid> → rename to runId), src/engines/bugs/engine.ts:414-437 plain writeFile | unique dir per run | bugs (not mine) |
| W8 | Architecture cache `.second-world/cache/arch` | src/engines/architecture/cache.ts:93-110 | temp `<file>.<pid>.tmp` + rename (temp name not unique within a process) | arch (not mine) |
| W9 | Model snapshots `.second-world/model/*.json`, latest.json | src/engines/model/snapshot.ts:22-27 | temp `<file>.<pid>.tmp` + rename, no retry | model (not mine) |
| W10 | Safety audit log `.second-world/audit.log` | src/core/safety/guard.ts:363 appendFileSync | O_APPEND, one write per record, no lock | core/safety (unowned → main) |
| W11 | Fault ledger | src/adapters/faults/cleanup.ts | lock + temp+rename (already hardened earlier) | sw-design7 lane |
| W12 | agent --export-tests, init config | src/cli/commands/agent.ts:99, init.ts | plain writeFileSync (user-invoked, single file) | not mine |
| W13 | Evolution worktrees | src/engines/experiments/worktree.ts | mkdtemp parent + git worktree add/remove; cleanupAll on success/error/abort | me (lifecycle) |

## Done
- B1 FIXED history lock stale-break race: N waiters seeing the same stale lock each renamed "it" away -> could remove a fresh lock -> 3 simultaneous holders. Fix: fsutil.ts breakStaleLock (`.break` O_EXCL + recheck). Test tests/unit/concurrency/history-lock.test.ts (before: worst=3, after 1; 3/3 runs).
- B2 FIXED Ctrl+C before an engine reserved its lease -> SW_SAFETY_KILLED exit 3 (bugs, agent, performance). Fix: world.ts runEngine maps it to AbortError (exit 130) when the run signal is aborted. Test tests/unit/concurrency/cancel-before-start.test.ts (3/4 failed before) + lifecycle.test.ts "bugs: exit 130".
- B3 FIXED writer killed between open("wx") and write left an EMPTY lock, judged stale only after 60 s > 10 s waiter timeout -> history saves failed (LockTimeoutError holder null) for a minute. Fix: createLockFile (temp + hard link, O_EXCL fallback) + 2 s grace for unreadable locks; prune removes `.lock.tmp-*`. Test cli-parallel.test.ts "killed mid-write": 5/25 failed before, 25/25 pass after; unit tests in history-lock.test.ts.
- NEW history reads report skipped/torn index lines via onWarning (world -> log.warn). Test history-writers.test.ts.
- Tests: unit/concurrency/{history-lock,history-writers,cancel-before-start,safety-rate}; integration/concurrency/{cli-parallel,lifecycle,evolve-interrupt} (+ helpers.ts, fixtures/sw-entry.ts, fixtures/history-writer.ts).
- Reported to main: safety.maxRps per-lease (guard.ts reserve new Gcra) -> 2 leases = 2x cap (safety-rate.test.ts it.fails).

- safety.maxRps per-lease: fixed by sw-infra8/main in guard.ts; safety-rate.test.ts flipped to `it` (passes).
- Out-of-lane, it.fails tests: tests/unit/concurrency/snapshot-writers.test.ts (model snapshot.ts:22-27 and arch cache.ts:93-110 temp `<file>.<pid>.tmp` -> 4/8 parallel in-process saves reject).
- docs/02-architecture.md §4.6 Concurrency model (tested claims only).
- sqlite: recommend removing from schema/docs for now (node:sqlite ExperimentalWarning on Node 24.14 on every run; JSONL list 15 ms @1k runs, 81 ms @10k, 325 ms @50k; default retain 200).
- Final runs: focused set 44 files 503 passed/2 expected fail; tests/unit 142 files 1504 passed/2 expected fail; concurrency suites 2x green; tsc only error is tests/integration/agent/ownership-resources.test.ts (not mine); biome clean on my files.

## Status
DONE (awaiting main review/commit).
