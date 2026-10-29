# Progress: sw-examples

## Done
- tests/fixtures/servers/calibrated.ts READY (+ /capacity/:n for sw-stress). 18 tests: tests/integration/examples/calibrated.test.ts
- tests/helpers: servers.ts, cli.ts (runCli/spawnCli via node --import tsx loader), tmp.ts, http.ts (api()), examples.ts (startExample) READY
- examples/payments-fake, examples/shop-express (10 defects), examples/shop-fastify (7 defects + correctByDesign + FIXED variant)
  - expected-findings.json per app; locations {file,line,symbol,handler?,callee?} synced from `SEEDED-DEFECT:<id>` markers by examples/_tools/sync-expected-findings.mjs (--check in tests)
  - tests: shop-express.test.ts (15), shop-fastify.test.ts (17), expected-findings.test.ts, payments-and-helpers.test.ts
- src/engines/reporting READY: model.ts, exit-code.ts, json.ts (atomic write + EPERM/EBUSY retry), tty.ts, markdown.ts, junit.ts, index.ts. 29 unit tests in tests/unit/reporting
- tests/fixtures/reports.ts: builders makeResult/makeFinding/makePerfData/makeThreshold
- Total: 90 tests passing (integration/examples + unit/reporting); tsc clean for my paths

- tests/e2e/cli.test.ts: 10 passing (version/help, doctor --json, perf JSON stdout, -f/-o files, threshold breach exit 1, --fail-on never, public target exit 3, usage/config exit 2, --dry-run sends nothing); SIGINT test skipped on win32; config-validate engine-section test enabled after sw-core fix (11 passing)
- Wave 1 deliverables COMPLETE. Final: 101 passed / 1 skipped across tests/integration/examples, tests/unit/reporting, tests/e2e; whole-project tsc clean.

- F2 (reporting): blocks.ts (format-neutral blocks) renders StressData (stage table, verbatim Capacity block, firstBreach/knee/breakpoint/spike/soak, USL in separate Estimates section) and RunComparison (single-run movement + "no statistics"; statistical verdict/ci95/pAdjusted; findings new/fixed/regressed/unchanged) in tty/md/html; renderComparison(); sarif.ts (SARIF 2.1.0, physicalLocation, ruleId, level from severity, security-severity, partialFingerprints); html.ts (self-contained, no scripts/external requests, escaped, prefers-color-scheme, inline SVG sparklines); ASCII fold in tty ascii mode. Tests: tests/unit/reporting/stress-history.test.ts (12), sarif-html.test.ts (12).
- F4: tests/fixtures/servers/calibrated-child.ts + calibrated-child-entry.ts (startCalibratedServerInChild, RPC over stdio); header of calibrated.ts says when to use which; /fixed now also returns heldMs (server-side hrtime). Tests: tests/integration/examples/calibrated-child.test.ts (3; ELU comparison shows spin stays off the parent loop).
- After F2/F4: 128 passed / 1 skipped across my suites (stable over 3 full parallel runs); whole-project tsc clean.

- Bugs rendering: src/engines/reporting/bugs.ts (isBugsData, bugsBlocks, replayText, scrubSecrets, techniqueColumns); new `code` block kind (tty indented, md fenced sh, html <pre>); hooked into tty/md/html; JUnit matrix testcases; SARIF operation logicalLocations + replay props. Tests: tests/unit/reporting/bugs.test.ts (16), tests/integration/examples/bugs-report.test.ts (6, real runBugHunt vs shop-express, all formats, no token leaks).
- Now: unit project 69 passed (tests/unit/reporting); integration project 81 passed / 1 skipped (tests/integration/examples + tests/e2e); whole-project tsc clean. Run with `npx vitest run --project unit tests/unit/reporting` and `npx vitest run --project integration tests/integration/examples tests/e2e`.

- Reliability rendering: src/engines/reporting/reliability.ts (isReliabilityData, reliabilityBlocks, checkSummaries, detectorSummaries, DETECTOR_RULES); spark block gained `mark` (fault window); JUnit conditions + detectors; SARIF logicalLocation(). Tests: tests/unit/reporting/reliability.test.ts (15), tests/integration/examples/reliability-report.test.ts (5, real runReliability dependency-5xx on shop-express, ~8 s, no token leak).
- Now: unit 84 passed; integration 86 passed / 1 skipped. tsc: my paths clean (4 errors in src/engines/model/sources/config.ts belong to another agent).

- F7 part 1: AI (sw-ai aiBlocks/isAIData via dispatch.ts; JUnit skips AI; SARIF keeps AI/hypothesis findings as level "note" + properties.hypothesis/verified:false/aiGenerated, message prefix "[AI hypothesis, unverified]" — documented in sarif.ts header), What-If + Evolution (src/engines/reporting/experiments.ts; JUnit per variant×criterion / A/A per metric / per candidate gate). dispatch.ts `dataBlocks(r)` now picks block renderers for tty/md/html. Tests: tests/unit/reporting/ai-experiments.test.ts (14), tests/integration/examples/whatif-report.test.ts (2, real A/A r=2 vs child calibrated server).

- ModelData rendering: src/engines/reporting/model-render.ts (isModelData, isModelDiff, modelBlocks, modelDiffBlocks) + renderModelDiff; quote block gained `ascii`; tty skips `code` blocks with lang mermaid. Tests: tests/unit/reporting/model.test.ts (13), tests/integration/examples/model-report.test.ts (3, real buildModel on shop-express with sw-model fixtures, temp cacheDir).
- Now: unit 111 passed (tests/unit/reporting); integration 91 passed / 1 skipped (tests/integration/examples + tests/e2e). tsc: my paths clean (1 error in tests/unit/agent belongs to another agent).

- AgentData rendering: src/engines/reporting/agent.ts (isAgentData, agentBlocks, outcomeCell, findingsOf), dispatcher hook, JUnit per hypothesis (fails when a produced finding is >= fail-on), SARIF replay props for agent findings; replayText takes a structural type. Tests: tests/unit/reporting/agent.test.ts (10), tests/integration/examples/agent-report.test.ts (2, real heuristic runAgent vs shop-express, small budget).

- idempotency-key-race (DISCOVERED by sw-agent, not planted) recorded as ground truth: SEEDED-DEFECT markers in shop-express src/routes/orders.ts (before placeOrder) and shop-fastify src/server.ts (before the key lookup); entries in both expected-findings.json (engine agent, alsoDetectableBy bugs, rule agent/idempotency-key-race, `discovered: true`); shop-fastify correctByDesign `idempotency-honoured` now = sequential repeats only; READMEs updated; plain-HTTP repro tests in shop-express.test.ts / shop-fastify.test.ts. Synced + --check OK. bugs/agent/reliability/architecture integration suites still pass (36 + 1 skipped).
- Final: unit 121 passed (tests/unit/reporting); integration 84 (tests/integration/examples) + e2e 11 passed / 1 skipped; whole-project tsc clean.

- scrubSecrets bug (sw-qa): optional-scheme regex backtracked and replaced the scheme word next to `$SW_AUTH_*`. Rewritten in src/engines/reporting/bugs.ts: header values parsed by `scrubHeaderValue` (placeholder or "<scheme> <placeholder>" kept; else scheme kept + credential redacted, or whole value redacted), 3 passes by enclosing quote (' / " incl. JSON / unquoted) so Digest/multi-part values are redacted whole; -u and ?token= patterns kept (no optional group before the lookahead). Shared `REPRO_AUTH_HINT` ("export SW_AUTH_<ROLE>='<full header value, e.g. Bearer …>'") used by bugs + agent. Core logger redactor (src/core/log/redact.ts, sw-core) checked: requires the scheme and excludes `$`, not affected. Tests: tests/unit/reporting/scrub-secrets.test.ts (table KEEP/REDACT, every format, fast-check properties).
- Final: unit 154 passed; integration 95 passed / 1 skipped (examples + e2e); tsc clean.

## In progress
- none

- none

## Next
- Optional: NestJS/Hono fixture apps (docs/12 §3), cache-down cascade defect, SARIF/HTML reporters (phase 3).

## Decisions
- Precise timer: setTimeout(ms-20) + setImmediate spin (Windows setTimeout overshoots ~12 ms).
- /error/:pct deterministic: request n fails iff floor((n+1)p/100) > floor(np/100), per-pct counter.
- stallUntilMs is epoch ms (Date.now scale).
- Exit codes: 130 cancelled > 70 error > 1 (threshold breaches always; other open non-hypothesis/non-verified-fix findings with severity >= failOn; status failed) > 0. failOn default "high"; "never" disables 1.
- writeReports skips "tty"; files report.json / report.md / report.junit.xml.
- Example sw.config.ts are plain objects (no import of unbuilt "second-world").
- shop-express charge() loop has an AbortSignal only for clean test shutdown (defect still: no cap/backoff).

## Blockers / requests
- (resolved) sw-core fixed `config validate` for engine sections; e2e test enabled.
