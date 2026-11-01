# sw-cli-w8 progress (wave 8, CLI completeness) — DONE (awaiting main)

## Done
- T1 `sw bugs` main concurrency request params: repeatable `--path-param <name=v>`, `--query <k=v>`, `--header <k=v>` (src/cli/main.ts, src/cli/commands/bugs.ts `concurrencyParamsFromFlags`). Same scalar coercion as --mix. Bad syntax / unknown {param} / used without --concurrency-test → exit 2 with "Expected …". tests/e2e/bugs-concurrency-params.test.ts 7/7 (before: unknown option).
- T2 dry-run: bugs/agent load contract + invariant modules + Safety-check HTTP hook URLs (`checkBugsSession`, bugs.ts); agent also reads --context reports (`checkAgentInput`); model --dry-run never starts the --receive listener and prints `warnings` for inputs the real build skips (`modelInputWarnings`). main exported loadInvariant from engines/bugs/index.ts. tests/unit/cli/dry-run-engines.test.ts 15/15 (11 failed before).
- T3 init: `initCommand(o, g, io?: InitIo)`; streams go to @clack/prompts. Fix: Ctrl+C at the final confirm → 130 (was 0). tests/unit/cli/init-interactive.test.ts 6/6 (confirm-cancel case verified failing on old code).
- T4 tests/unit/cli/help-docs-parity.test.ts 6/6 (4 failed on old docs/09); docs/09 §1 rewritten (per-command option tables, exit codes; removed non-existent sw report/run/plugins; corrected progress description). history baseline set/list got descriptions. docs-config-examples SKIP key moved 84→387.
- Suites: tests/unit/cli + tests/e2e 206 pass/1 skip; tests/unit 1653 pass / 1 fail (R5 import rule: run-common.ts → engines/history/fsutil.ts, sw-robust-w8's lane).
