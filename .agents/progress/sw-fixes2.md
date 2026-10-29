# sw-fixes2 (Wave 5)

## Status: DONE (all 3 items). Suites: 41 files / 356 tests pass; tsc clean (excl. *.coverage.test.ts).

## Log
- Bug 1 DONE: git.ts stateExcludePathspecs + workingTreeChecksum(repo, ignore); schema ignorePaths; CLI ownStatePaths; working tree changed -> status failed (exit 1). Tests: tests/integration/experiments/evolution-own-state.test.ts, tests/unit/experiments/state-excludes.test.ts. Doc B.3.
- Bug 2 DONE: arch engine.ts stat(root) -> ConfigError SW_CONFIG_PROJECT. Empty existing dir stays ARCH_NO_FILES/exit 0. Tests: tests/unit/architecture/project-path.test.ts, tests/integration/architecture/inspect-missing-path.test.ts. Doc §1.
- Bug 3 DONE (experiments only): repoRoot missing dir/not a repo -> ConfigError SW_CONFIG_EVOLUTION_REPO; resolveCommit -> SW_CONFIG_EVOLUTION_REF; whatif NO_TARGET -> ConfigError; whatif all runs failed -> + no-measurements limitation (exit 5); EVOLUTION-BASELINE-FAILED added to TARGET_LIMITATIONS (exit 5). Test: tests/unit/experiments/user-side-exit-codes.test.ts. Doc B.3.
## Open (not mine / doubtful)
- perf safety-abort -> 70; stress all-stages-error w/o target-unreachable -> 70; world.ts buildEvolutionInput could call ownStatePaths for API users (main).
