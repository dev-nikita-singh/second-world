# Progress: sw-core

## Done (all Wave-1 deliverables 1–11; 224 unit tests green in tests/unit/core + tests/unit/cli; `tsc --noEmit` = 0 errors repo-wide)
- 1 units (config/units.ts), 2 thresholds (config/thresholds.ts) — property tests
- 3 clock.ts (systemClock, createFakeClock), rng.ts (xoshiro128**/splitmix32, fork)
- 4 log/logger.ts (stderr, json, memory logger), log/redact.ts (headers, exact secrets, patterns, entropy)
- 5 events.ts, evidence/store.ts (+createFinding, defaultFingerprint)
- 6 safety/gcra.ts, safety/guard.ts (classification, wildcard/CIDR/port allow-list, budgets+lease, approvals, audit JSONL hash chain + verifyAuditLog, killSwitch), context.ts
- 7 probe/probe.ts (+doctorChecks)
- 8 config/schema.ts + config/loader.ts (c12 for TS/JS, own JSON/YAML + extends, env overlay, --set, profiles, origins, noConfigCode, secret warnings)
- 9 registry.ts (lazy, builtin performance), orchestrator.ts (shared topoSort, concurrency, skip-on-failure), world.ts
- 10 cli/main.ts + cli/output.ts + cli/commands/{doctor,config,perf}.ts (reporting wired, signals, exit codes)
- 11 src/index.ts exports the full public API
- Tests: tests/unit/core/{units,thresholds,clock-rng,redact-logger,events-store,safety,probe,config,world}.test.ts, tests/unit/cli/cli.test.ts

## F1 (done)
- registry builtins: performance, stress, architecture. world: `stress` handle, `architecture.inspect`, `history {store(), save()}`; `buildStressInput` (perf base keys + config.stress + input), `buildArchitectureInput` (paths resolved vs config cwd); generic `parse<Id>Input` lookup; world skips re-adding findings an engine already put in ctx.evidence (architecture does).
- config: `history.enabled` (default true).
- CLI: src/cli/run-common.ts (worldFromGlobals, installSignals, attachProgress, finishRun = report + history auto-save + exit code); commands stress.ts, inspect.ts, history.ts, init.ts; perf refactored onto run-common; `--no-history` on perf/stress/inspect.
- Tests: tests/unit/cli/f1.test.ts (flag mapping, inspect on examples/shop-express with temp cache, stress+history round trip vs child calibrated server, verify corruption → 1, history disabled, init --yes). Suites core+cli+e2e: 245 passed, 1 skipped; tsc 0 errors.

## Bugs + F5 (done)
- `sw bugs` / `sw replay` (src/cli/commands/bugs.ts). Registry builtin `bugs`. world: `bugs` handle, `buildBugsInput` (bugs.contract → openapi, cwd = config dir, roles from config.auth bearer/basic/header with secrets resolved, hooks.setup/reset from config.hooks, target names), `world.buildInput(id, input)`, `world.context(engineId, signal?)`.
- Reproductions: input.artifactsDir = .second-world/artifacts/pending-<ulid>, renamed to <runId> after the run (result.artifacts paths patched). Replay finds `bugs-<fp>.json` by prefix (newest artifacts dir first), falls back to history (results[].data.reproductions); exit 1 = still reproduces, 0 = not, 2 = not found/ambiguous.
- F5 DNS pinning in safety/guard.ts: `pinHost(url)` (resolve all, classify every address, strictest class; blocked class → SW_SAFETY_DNS_CLASS; unresolvable → TargetError SW_TARGET_DNS exit 5), preflight pins, `lookup`/`pinnedLookup` (net.LookupFunction; honours options.all/family; unpinned hosts are checked → resolved → pinned once; blocked → cb(err) with err.code = SW_SAFETY_*), `recheckDns(host)` (class change or new address class → kill switch + SW_SAFETY_DNS_REBIND), `pins()`, `checkRedirect(from, location)`. Injected `resolver` option for tests.
- sw-perf agreed the hook: it reads `ctx.safety.lookup` (duck-typed) and passes it to undici `connect: { lookup }` in src/adapters/http (their change).
- Tests: tests/unit/core/dns-pinning.test.ts (8), tests/unit/cli/bugs.test.ts (6). unit core+cli: 249 passed; e2e 11 passed / 1 skipped; tsc 0 errors.

## Reliability (done)
- `sw reliability list|run|cleanup` (src/cli/commands/reliability.ts). Registry builtin `reliability`; world `reliability` handle + `buildReliabilityInput` (known keys from config.reliability; docs/08 shorthand proxyListen→listen, upstream target name→URL, injector auto→builtin; environment from config).
- Flags: --dependency --duration --steady-phase --recovery --steady (rep) --hypothesis (rep) --param k=v (rep) --rate --route name=METHOD /path (rep) --repeat --abort-error-rate --allow-production; approval via global --approve-disruptive / --yes (guard approve). Routes with headers/body come from config reliability.workload.routes.
- cleanup: cleanupAll({ledgerPath?}) via --ledger; exit 1 if errors.
- Ctrl+C: run-common installSignals aborts the world signal first → engine reverts faults.
- Tests: tests/unit/cli/reliability.test.ts (6: mapping, list --json, no approval → 3, production → 3, cleanup → 0), tests/integration/cli/reliability.test.ts (1: real dependency-latency via engine-started builtin proxy, ~10 s; asserts proxy port closed + history). NOTE: tests/integration/cli/ is a new dir I created (owner sw-core).
- unit core+cli: 255 passed; integration e2e + cli: 12 passed / 1 skipped; tsc 0 errors.

## AI + experiments (done)
- core AiSchema mirrors sw-ai options (engine extras optional w/o defaults; sendSourceCode false|none|snippets|full|full-files; cache.ttl → ttlMs). tests/unit/core/ai-config.test.ts.
- `sw analyze <reports...> [--last] [-q] [--provider] [--model] [--no-cache] [--json]` (+ global --dry-run): world.analyze (registry `ai`), no history; tty via reporting.renderBlocksTty(aiBlocks(data)); --dry-run --json prints data.dryRun. tests/unit/cli/analyze.test.ts (7, mock Anthropic via tests/unit/ai/helpers/mock-ai-server.ts).
- `sw whatif <name|file>` / `sw evolve` (src/cli/commands/experiments.ts): registry whatif/evolution → engines/experiments; world.whatif/evolution, buildWhatIfInput/buildEvolutionInput, PARSE_ALIASES; schema `whatif.experiments`; loader `loadObjectFile`; evolve `--repo` added (keeps CLI output out of the evolved repo); skipped+EVOLUTION-NO-SANDBOX → exit 4. tests/unit/cli/experiments.test.ts (5), tests/integration/cli/experiments.test.ts (2: A/A whatif, evolve ranking).

- `sw model build|show|diff` (src/cli/commands/model.ts): registry `model`; world.model.{build,diff}, buildModelInput (project/cacheDir vs config dir; openapi defaults to bugs.openapi|contract; serviceName = project.name). build pulls latest performance/reliability/bugs results from history (and architecture with --from-history), saves snapshot via saveModelSnapshot + history (label "model"); `--config-file` (global -c collides), `--graph dot|mermaid|json` (global -f collides), `--receive N` OTLP receiver. show [snapshot|latest] --graph/--node/--k; diff a b (exit 0). tests/integration/cli/model.test.ts (3).
- Totals: unit core+cli 284 passed; integration e2e+cli 17 passed / 1 skipped; tsc: only a foreign error in tests/unit/agent/validator.property.test.ts.

## F8–F10 (done)
- F8 `sw history diff <sel> <sel> [--engine]`: selectors `id[,id…]` | `last:N` (filtered by global `--label`/`--engine`) | `label:<name>[:N]` | `baseline:<name>` → id arrays to store.diff (parseRunSelector/resolveRunSelector exported from cli/commands/history.ts). New GLOBAL `--label <name>` names the history entry of any run (perf/stress/inspect/bugs/reliability/whatif/evolve/model). Tests: tests/unit/cli/history-selectors.test.ts (14), tests/integration/cli/history-diff.test.ts (5×/fixed/10 vs 5×/fixed/60 → statistical "regressed", exit 1).
- F9 world.report.{combine, write, render, renderComparison, exitCode} (reporting module preloaded in createWorld so combine/render are sync) and world.history.compare({baseline, current, options}) (strings: id/prefix/baseline:<name>/bare baseline name; objects: EngineResult(s)/combined report → pseudo HistoryRun via extractMetrics; arrays → statistical). history.save accepts a combined report. src/index.ts exports combineResults, computeExitCode, REPORT_FORMATS, renderComparison, renderReport, writeReports (+ types CombinedReport, FailOn, ReportFormat, ReportMeta, WorldReport, WorldHistory, RunRef). Tests: tests/unit/core/world-report.test.ts (5).
- F10 reliability `workload.routes[].auth: "<role>"`: world resolves config.auth (bearer/basic/header; {env}/{file}) into headers (explicit headers win) via `authHeadersFor`; unresolved roles stay on the route → runner adds limitation RELIABILITY_AUTH_UNRESOLVED and sends without credentials. Ownership exception (main): added optional `auth` to RouteSchema (src/engines/reliability/schema.ts) + the limitation loop in runner.ts. Tests: tests/unit/core/reliability-auth.test.ts (2); tests/integration/cli/reliability.test.ts now uses auth role with {env} token and asserts the token is absent from stdout and report.json/md/html.
- Totals: unit (core, cli, reliability) 358 passed; integration reliability 9+1 skipped; integration cli + e2e + system 35 passed / 1 skipped; tsc 0 errors.

## sw agent (done)
- Registry `agent`; world.agent + `buildAgentInput` (bugs-derived base: target, openapi ← bugs.contract, roles from config.auth resolved, hooks, values, headers, timeout, cwd; then `agent` section (contract → openapi; agent.auth.roles resolved) and call input).
- `sw agent` (src/cli/commands/agent.ts): --target --openapi --planner --bandit --budget requests=,iterations=,time=,patience=,rps=,concurrency= --techniques --include/--exclude --allow-mutations --allow-destructive (needs --yes, else exit 3) --context (rep) --export-tests <dir> --json --no-history; --planner llm without ai.provider → SW_CONFIG_AGENT_LLM exit 2 (pre-checked); exported test filenames are basename-sanitised; config snippets printed on stderr.
- Tests: tests/unit/cli/agent.test.ts (6), tests/integration/cli/agent.test.ts (1: shop-express heuristic run, budget 150 respected, exported files parse as TS with no secrets, history label, examples/ untouched).
- Totals: unit core+cli 311; integration cli+e2e+system 36 passed / 1 skipped; tsc 0 errors.

## In progress
- none

## Next (when resumed)
- engines could call `ctx.safety.recheckDns(host)` periodically and `checkRedirect` on redirects
- `sw model`, `sw whatif`, `sw evolve`, `sw analyze`, `sw report merge|render`, `sw run [workflow]`, `sw plugins list` (later waves)

## Decisions
- Subcommand flags must not reuse global names (-c/--config, -f/--format, --dry-run, --seed): commander binds them to the program. Use --config-file / --graph instead.
- DNS: a host whose resolved addresses are in a stricter class than its name needs that class's permission (listed name OR all addresses listed); same-class IP churn is not a rebind.
- `sw replay` builds its input from config + flags (target from config/--target), uses world.context('bugs') so safety/approvals/audit apply.
- history diff exits 1 when `regressions` is non-empty; verify exits 1 when !ok; HistoryError → exit 2 (SecondWorldError with its SW_HISTORY_* code).
- Cancelled runs are not saved to history.
- `sw inspect --graph` prints only the graph on stdout (report files still written).
- sw init writes sw.config.ts with a type-only `import type { ConfigInput } from "second-world"` (stripped by jiti, so it loads before install); non-TTY or --yes → defaults; existing config → exit 2 unless --force.
- Bash heredocs break in this harness when content has quotes: write files with the Write tool.
- Threshold metric canonical `<scope>.<stat>`; bare stat → scope "http"; p999 → p99.9.
- Redaction marker `«redacted:<8hex sha256>»`; SENSITIVE key names redact whole value.
- RNG fork depends only on (seed, name), not on parent draws.
- Guard SafetyConfig uses ms (`maxDurationMs`); world maps config.safety.maxDuration (ms after schema).
- Public target needs allowHosts + allowPublic + (approve flag | interactive confirm via preflight()).
- environment: production → every target needs approval (production-target).
- Lease: take() false on exhausted/expired/killed; throttle() = GCRA wait (burst = ceil(rps/10)).
- Config: strict top-level (typos fail). Env overlay only maps known sections, so SW_TEST_USER_TOKEN-style secrets are ignored. SW_TARGET → performance.target. Arrays replace on merge.
- JSON/YAML `extends` supports local paths only; npm presets need TS/JS config (c12).
- User config: env-paths("second-world").config/config.{json,yaml}, only `ai`/`ui` keys; SW_USER_CONFIG_DIR overrides (tests).
- Audit log default `<cwd>/.second-world/audit.log` only when a config file exists.
- CLI usage errors (commander) → exit 2. doctor exits 4 if a check fails (unsupported Node).
- `sw config validate` also validates the performance section via the engine schema + parseThresholds (placeholder loopback target if none).
- node:sqlite detection via module.isBuiltin (importing it prints ExperimentalWarning).
- World adds engine findings to evidence (sw-perf does not) and emits finding.created.

## Blockers / requests
- none
