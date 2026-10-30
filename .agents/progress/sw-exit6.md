# sw-exit6 progress — DONE (awaiting main's commit)

## Done
- (a) stress: src/engines/stress/runner.ts — exported `allErroredLimitations()`: when every stage errors,
  carry dns-rebind (→3), target-unreachable (→5), or add run-level `no-measurements` (invalidates, →5) when
  every stage's perf run had no-measurements/target-unreachable. Any other all-error stays 70; thrown exceptions still propagate.
  Also: a stage where every request failed is never "generator saturated" (5xx/reset targets used to exit 0; now breach → exit 1).
  Tests: tests/unit/stress/all-stages-error.test.ts (7), tests/integration/stress/target-failures.test.ts (3).
  Docs: docs/03-engines/stress-capacity-lab.md §7. Repro before fix: hang server → 70; 500/destroy server → 0.
- (b) evolve: git.ts `gitFailure(what, r, fallback)` classifier (stderr patterns → ConfigError SW_CONFIG_EVOLUTION_GIT (2)
  or CapabilityError SW_CAP_EVOLUTION_GIT / SW_CAP_GIT_TIMEOUT (4), with hints); gitOk uses it (fallback config);
  repoRoot passes non-"not a git repository" failures (e.g. dubious ownership) through it; GitResult.timedOut.
  worktree.ts: add() → gitFailure(fallback capability); mkdtemp ENOENT/ENOTDIR → ConfigError SW_CONFIG_EVOLUTION_TMPDIR, else CapabilityError.
  evolution.ts: baseline worktree gate failing with Config/CapabilityError is rethrown (after cleanup) instead of EVOLUTION-BASELINE-FAILED (5).
  Tests: tests/unit/experiments/git-env-exit-codes.test.ts (17). Docs: experiments.md exit-codes paragraph.

## Deliberately left as 70
- stress: a stage perf result with status "error" but no target-side/safety limitation (unknown cause = genuine bug).
- evolution: exceptions thrown by executeExperiment / internal code paths outside git/fs (genuine bugs);
  SW_ENGINE_EVOLUTION_BASELINE EngineError is internal control flow only (caught; maps to EVOLUTION-BASELINE-FAILED → 5).
- Candidate worktree failures remain per-candidate rejections (not run-level errors) by design.

## Verification
npx vitest run tests/unit/stress tests/unit/experiments tests/integration/stress tests/integration/experiments → 19 files, 138 tests pass; tsc clean; biome clean on touched files.
