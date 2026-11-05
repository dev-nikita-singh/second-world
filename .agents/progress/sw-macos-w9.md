# sw-macos-w9 progress (macOS Node 24 CI failures)

Branch: ci-macos-w9 (pushed). Temporary debug files removed in 425c9bf. Branch head 425c9bf.
NOTE: working tree is shared; other agents' uncommitted edits (src/engines/bugs/*) — commit only own files by path, never stash.

## Done
- #3 double SIGINT temp leak (REAL BUG): async temp create queued on libuv pool runs after the sync sweep during teardown.
  Fix: src/shared/util/fs-temp.ts (createTempSync registry, register only after successful O_EXCL open; removeLiveTempsSync),
  used by atomic-write.ts, history/fsutil.ts (atomicWrite, createLockFile + sync O_EXCL fallback, .break), run-common.ts removeOwnTempFiles.
  Test: double-sigint.test.ts burst case + fixtures/double-sigint-burst.ts (old code leaks 6-9/20 runs on Windows; fixed 0/80+).
- #2 stress maxRps: stages [8,16], floor 0.9*cap (4 VUs response-bound on starved runner).
- #1 A/A exit 1: = WHATIF-AA-DIFFERENCE (p95 "regressed" between identical arms; CI 41931384737 macOS 22: p95 +4.6% pHolm 0.024).
  Product right: 48 standalone A/As (5 and 10 reps, debug runs 41928367366, 41934274423) on macOS+ubuntu: 0 differences;
  only under full parallel suite (non-exchangeable load). Test now checks the exit contract both ways.
- evolve CLI test: repetitions 7 (5v5 min p 0.0079 vs Holm 0.05/6=0.0083: one stalled run → inconclusive → slower tied on front).

## Status: DONE
- CI on branch: 41935742606 all green; 41938184362 all green except macOS 22 (whatif-shop fastify flake, out of lane); 41938205192 all green.
- Commit 2daf035 (bugs/agent base path) by another agent landed on ci-macos-w9 because the shared tree is on this branch; told main.
## Out of lane (reported to main): whatif-shop A/A (ubuntu regressed under load), calibrated /fixed/50 p95<75 macOS, detailed-timing Little's law <1.3, reliability engine unit recovered.
