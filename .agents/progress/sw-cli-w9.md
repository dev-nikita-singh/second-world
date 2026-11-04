# sw-cli-w9 progress — DONE (2026-11-04)

## Done
- `sw report [reports...] [--last] [--run <id>] [--json]` (src/cli/commands/report.ts). Tests: tests/unit/cli/report-command.test.ts (6).
- `sw run [workflow] [--list] [--json] [--no-history]` (src/cli/commands/run.ts). finishRun accepts EngineResult[]; with several results history is saved first and the combined report reuses the history id. Tests: tests/e2e/run-workflow.test.ts (8; SIGINT one skipped on win32), tests/unit/cli/run-cancel.test.ts (in-process SIGINT, 1).
- Plugins wiring (request from sw-plugins-w9): main.ts `plugins list|check`, `--no-plugins`, `-f` help; run-common noPlugins + plugin formats in the locked write (tolerant of worlds without `plugins`); report.ts plugin formats via world.report.write. tests/integration/plugins green (incl. the CLI test that auto-enables).
- Quickstart: both known issues were already fixed in code (stress cap reported: capacity line, CAPPED, STRESS-SAFETY-RATE-CAP; curl: "$SW_AUTH_<ROLE>", recorded ids, no {{…}}). CLI-level regression: tests/e2e/quickstart-output.test.ts (2). docs/quickstart.md re-run end to end on Windows and rewritten from captured output; new §11 sw report, §12 sw run.
- docs/09 (commands table, sw report / sw run / sw plugins sections, --no-plugins), README commands table + global flags; "Not implemented yet" removed.
- tsc clean; biome clean on my files; my suites 3x green (251 passed, 1 skipped).

## Known gaps
- WARN log lines for secret-looking config values read `«redacted:…» in sw.config.ts` (the redactor eats the word "value" in "token: value"): src/core/log, not mine; reported to main.
- Workflow bugs steps: reproductions only in history (no .second-world/artifacts/ HAR); sw replay finds them there.
- Workflow progress lines name the engine, not the step id (run.* events carry only engine).
- `sw stress` has no `--workers`; uncapped stress on shop-express saturates the single generator (~1200 req/s).
