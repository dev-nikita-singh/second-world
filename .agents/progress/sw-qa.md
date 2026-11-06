# Progress: sw-qa

Status: DONE (2026-10-29).

## Done
- **Stability audit** (`npx vitest run`, runs 2–3 with `--exclude "tests/system/**"`):
  - Run 1 (06:18, 413 s): 1037 pass / 1 fail / 3 skip, 107 files. Fail = tests/unit/cli/cli.test.ts:23 stale command list (sw-core mid-edit, fixed).
  - Run 2 (427 s): 1120 pass / 0 fail / 3 skip, 115 files.
  - Run 3 (464 s): 1166 pass / 0 fail / 3 skip, 123 files.
  - Extra unit-project runs (4 total): tests/unit/performance/safety-rate-cap.test.ts:90 failed 2/4 under parallel load (passes 3/3 alone). Real false positive at src/engines/performance/engine.ts:331-332 (wall-clock > 0.5 ms counted as throttled). Reported.
  - tsc: run 1 had 1 error in tests/unit/agent/validator.property.test.ts (sw-agent WIP); final tsc clean.
- **System tests** in tests/system (integration project; final run 25 tests, ~111 s total, every file < 1 min):
  - helpers.ts: freePort, portRefuses, walkFiles, snapshotTree, findSecrets, expectTrustLadder (per-engine allowed classifications)
  - full-investigation.test.ts: CLI inspect → perf → bugs → reliability → model build → analyze --dry-run → combined report (json/md/junit/sarif/html) → history list/verify; trust ladder; secret scan over every written file (incl. env-ref tokens + fake API key); nothing new under examples/
  - workflow.test.ts: world.run DAG (order, continueOnError, skipped dependant, optional, cycle/unknown rejected, evidence store, events)
  - cancellation.test.ts: abort mid perf + fault → cancelled partial results, skipped dependant, proxy port closed, cleanupAll {0,0,[]}
  - regression.test.ts: shop-fastify FIXED vs seeded; single-run diff = movement, exit 0; 5v5 via store and `sw history diff label:fixed:5 label:seeded:5` → p95 regressed, exit 1; reverse = improved
  - artifact-locations.test.ts: inspector default cache not written into inspected project (bug fixed by main)
  - example-configs.test.ts: shipped example configs validate (shop-express bug fixed)
  - safety-and-replay.test.ts: maxRps open/closed, config print + dry-run secret masking, concurrency replay fidelity (all fixed)
  - Flake seen once: full-investigation examples/ snapshot broke when another agent edited examples/*/README.md mid-run → guard now checks only for NEW paths. One earlier system run had 4 failures in one file whose output was not captured (probably the same concurrent edits; not reproduced in 7 later runs).
- **README.md** (root) and **docs/quickstart.md**. Every CLI example was run (scratch copy at scratchpad/qs/shop; servers on 3000/3002/4010, proxy 4011): doctor, init, config validate, perf, stress, inspect, bugs (with and without concurrency test), replay, reliability list/run/cleanup, model build, analyze (--last, --dry-run), history list/show/baseline set/diff (id, last:N, label:N)/verify/trend, --set safety.maxRps, -f all formats, --dry-run perf, PowerShell `npx.cmd` shortcut, programmatic API snippet (scratchpad/api/demo.mts). Not run (protocol): `npm install`, `git clone`.
- **Bugs reported to main** (see messages.log): arch default cacheDir in inspected project (fixed); shop-express config scenario auth (fixed); safety.maxRps not enforced in VU models (fixed); dry-run secret leak (fixed); history list column (fixed); scrubSecrets "Bearer" (fixed); replay false negative for concurrency findings (fixed); curl `Bearer $SW_AUTH_X` + unexpanded `{{rid}}` (sw-bugs in progress); stress doesn't report the safety cap; throttle false positive under load. Gaps: history diff single id (fixed → F8), no world.report facade, reliability workload has no auth-role reference.

## Decisions
- Combined report uses src/engines/reporting (combineResults/writeReports): public API has no report facade.
- Biome: `check --write` applied only to tests/system; 13 `noExplicitAny` warnings remain (JSON from CLI stdout).

## Blockers / requests
- none

## Wave 5
Status: DONE (2026-10-29)
- [x] packaging test: done; bugs: ESM inspect crash (FIXED a01b3c8)
- [x] every command on both apps (manual, packaged bin): done
- [x] edge cases: subfolder, --config elsewhere, down target, bad URL, invalid config, hard kill (Windows: no graceful SIGINT), zero/neg/huge rate, unwritable -o, spaces
- [x] system/e2e tests
- Servers (manual runs): payments :4610, express :4600, express2 :4602 (PAYMENTS_URL :4611), fastify :4601; PIDs in scratchpad/logs/*.pid. Work copies: %TEMP%/"sw qa work"/{express,fastify,evo}; pkg install %TEMP%/sw-qa-pkg
- Done manual: doctor, config, perf (all models, workers, formats), stress, inspect, bugs, agent, replay, reliability(+invariants), model (json/pb/pb.gz), whatif, evolve process+docker
- Bugs reported: doctor --quick (FIXED), iterations warmup (FIXED abe1419), packaged inspect (FIXED a01b3c8), evolve docker HOST/exit70 (open)
- Tests to write: e2e doctor-quick (it), perf iterations warmup (it), packaged-cli (it + typescript peer)
- Tests written: tests/e2e/qa-regressions.test.ts (9: 4 it, 5 it.fails), tests/e2e/packaged-cli.test.ts (7), tests/e2e/evolve-cli.test.ts (5: 1 it.fails, 1 docker skipIf), tests/system/shop-express-cli.test.ts (7), tests/system/shop-fastify-cli.test.ts (4); helpers.ts + copyExample/DEMO_TOKENS
- All reported bugs fixed by main; every it.fails flipped to it. Open (docs/UX, reported, no tests): README mutations and/or --yes, -o relativity, breakpoint passed+exit1, model diff arg names, whatif run N/?
- Final: tests/system + tests/e2e 13 files, 68 tests (62 pass + 6 it.fails that then passed → flipped; re-verified 14/14), 1 skipped (Windows SIGINT). tsc clean. Servers stopped, temp dirs removed, no docker containers left.
