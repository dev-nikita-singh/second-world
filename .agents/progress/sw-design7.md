# sw-design7 progress (wave 7, Plan §B) — DONE (awaiting main review)

## Done (all tests pass: tests/unit/design 47/47; tests/unit 1458/1459, the 1 failure is env, see Blockers)
- 1a tests/unit/design/imports.test.ts + import-graph.ts (TS-AST parser, iterative Tarjan): R1–R7 layering, cross-engine ratchet KNOWN_CROSS_ENGINE (18 pairs), no runtime cycles; 1 type-only cycle frozen.
- 1b tests/unit/design/public-api.test.ts + __snapshots__/public-api.txt (151 exports, names+kinds; runtime exports cross-checked).
- 1c tests/unit/design/schema-freeze.test.ts + __snapshots__/{evidence-v1.schema,report-v1,history-v1}.json.snap (.snap so biome never reformats them); v0 wrapper, frozen v1 record, migrateRun matrix.
- 1d tests/unit/design/startup-budget.test.ts: static (cli/main.ts reaches 0 engine/adapter modules) + measured (--version ~300ms/55MB, --help ~290ms/57MB via tsx; budget 1000ms/170MB; SW_SKIP_STARTUP_BUDGET=1, SW_STARTUP_BUDGET_MS, SW_STARTUP_BUDGET_RSS_MB).
- 2 tests/unit/design/resilience.test.ts: 4 failing before fix -> pass: undici-executor body cap overshoot; OTLP receiver push(...) RangeError >120k spans (500 -> 200); otlp.ts payloadsOf JSONL spread.
- 3 tests/unit/design/config-errors.test.ts: 8 failing before fix -> pass: unknown keys full path + did-you-mean (loader.ts zodToConfigError, knownConfigKeys, suggestKey); thresholds non-mapping / abortOnFail boolean / no double path (thresholds.ts); NaN printing (units.ts); prototype-pollution pin. loader.ts forEach lint fixed.
- 4 docs/16-system-design.md + docs/README.md link line.

## Blockers / filed to main
- tests/unit/cli/f1.test.ts:140 fails because examples/shop-express/.second-world/cache/arch exists (created 2026-11-01 04:33, not by my tests). Delete it (examples/ not my lane).
- perf --dry-run says "config valid" for invalid thresholds (src/cli/commands/perf.ts:73).
- engine input errors lack section prefix (src/engines/*/index.ts).
- Math.min/max(...xs) on tick series in reporting tty/markdown/html (not verified).
