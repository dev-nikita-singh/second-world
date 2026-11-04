# Wave 9 — complete the project (2026-11-04)

User (2026-11-04): "complete the project": test GitHub CI, Linux, macOS, Docker off Windows, podman and the
release workflow; create the GitHub repo (public, dev-nikita-singh); npm publish is NOT wanted yet;
licence stays as is (MIT, "The SECOND WORLD contributors"); implement SQLite history properly; build
what is still missing (`sw report`, `sw run`, `sw plugins` + the plugin system).

Branch: `main` (renamed from master). Agents do NOT commit; main reviews and commits per agent.
Rules: .agents/README.md (ownership, no npm install / package.json edits → message main, tests mandatory,
Windows + macOS + Linux portability, no AI/LLM features ever).

Definition of Done for every agent:
- unit + integration tests for everything new; `npx tsc --noEmit` clean; `npx biome check src tests` clean
  at `--error-on-warnings` for your files; your tests pass 3× in a row (no flakes).
- docs updated (the spec in docs/ must describe what is built, including honest limitations);
  CHANGELOG lines sent to main (main owns CHANGELOG.md).
- final progress file + message to main: what's done, test counts, known gaps.

## sw-sqlite-w9 — real `history.backend: "sqlite"`
Today `sqlite` is accepted and silently falls back to JSONL with a warning (docs/03-engines/evidence-and-history.md,
docs/17, docs/02 ADR 008). Build it for real with `node:sqlite` (Node ≥ 22.19 per package.json engines; dev machine is Node 24.14):
- A `SqliteHistoryStore` with the exact same interface/behaviour as the JSONL store (append, get, list, query,
  baselines, labels, trend, diff inputs, prune/retention, `history verify` incl. the audit-log chain check).
  One shared contract test suite runs against BOTH stores.
- Loading: lazy `import("node:sqlite")` only when the backend is sqlite. Suppress ONLY node:sqlite's own
  ExperimentalWarning (match on the warning name + message), never other warnings. `sw --version/--help`
  must still not load it (startup-budget test). If `node:sqlite` is unavailable → clear fallback to JSONL
  with a limitation/warning (keep today's behaviour as the fallback path).
- Concurrency & crash safety: WAL, busy_timeout, transactions; two processes appending at once (integration
  test with child processes) lose nothing; a killed writer leaves a readable DB. Schema versioning +
  migrations table.
- Migration: when switching jsonl → sqlite, existing JSONL history is imported once (idempotent), and
  `sw history` keeps showing old runs. Document how to go back.
- Measure at 10,000 runs (list / trend / show) vs JSONL; put numbers in the docs.
- Owns: src/engines/history/**, src/core/probe/** (sqlite capability only), tests/unit/history/**,
  tests/integration/history/** (new files ok), docs/03-engines/evidence-and-history.md, docs/02 (ADR 008 row only),
  docs/17 (sqlite line only). The `HistoryStore` interface is a contract for sw-plugins-w9 (plugins can register a
  store): put it in CONTRACTS.md and message sw-plugins-w9 when READY.

## sw-plugins-w9 — plugin system + `sw plugins` (docs/10)
- `definePlugin` + `apiVersion` check, exported from a new `second-world/plugin` entry (ask main for the
  package.json `exports` + tsdown entry; main does it). Load from config `plugins: [...]` (strings, and
  `{ name, optional, options }` objects — extend the schema), resolved from the PROJECT's node_modules via
  `createRequire(projectRoot)` or a relative path; no auto-discovery. `--no-plugins` global flag; plugins are
  never loaded under `--no-config-code`. Errors wrapped with the plugin name; optional plugins degrade to a limitation.
- Extension points wired for real in 0.x (each with an end-to-end test using a fixture plugin):
  reporters (new `-f` format), architecture rules (namespaced ids `acme/...`), Bug Hunter assertions,
  history stores (via the HistoryStore contract from sw-sqlite-w9), lifecycle hooks (`run.started`,
  `engine.started`, `finding.created`, `run.completed`, `run.failed`), template helpers if the template engine
  supports it. Points you do NOT wire (executor, extractor, fault injector, engine) must throw a clear
  "not supported in 0.x" error from `api.registerX` and be listed as such in docs/10.
- `sw plugins list` (name, version, apiVersion, contributions, status) and `sw plugins check` (loads, validates,
  reports problems, exit 2 on a broken required plugin). `--json` for both.
- Namespacing: contributions are prefixed with the plugin name; clashes are errors.
- Owns: src/core/plugins/** (new), src/core/world.ts (plugin loading/hooks only), src/core/config/schema.ts
  (plugins section only), src/cli/commands/plugins.ts (new), src/plugin.ts (new entry), the reporter/rule/
  assertion registries' registration seams (minimal, message main first if a file is large), docs/10,
  tests/unit/plugins/**, tests/integration/plugins/**, tests/fixtures/plugins/** (new).
  Ask sw-cli-w9 to register the `plugins` command in src/cli/main.ts and the `--no-plugins` global flag.

## sw-cli-w9 — `sw report`, `sw run`, quickstart known issues
- `sw report [reports...] [--last] -f <formats> -o <dir>`: combine and/or re-render existing report.json files
  (and history runs) into any format, no network (world.report in the API already exists — reuse it).
- `sw run <workflow>` (+ `sw run --list`): runs a config workflow via `world.run(name)`, same global flags,
  history, exit codes, dry-run, Ctrl+C as other engine commands.
- docs/quickstart.md has two "known issue being fixed" notes (≈ line 215: stress report does not mention the
  safety.maxRps cap; ≈ line 285: printed curl commands not copy-paste ready — auth header placeholder and BOLA repro
  `{{…}}` path variable). Verify against the CURRENT code (commit ea7537e may have fixed the first). Fix what is
  still broken (owner of the engine files: you, for these fixes only — reporting/curl rendering and stress
  message), add regression tests, remove or correct the notes. Re-run the quickstart commands end to end and make
  every printed output in quickstart.md match reality.
- README "Not implemented yet" line and docs/09 §"Not CLI commands in 0.1.0" must be updated.
- Owns: src/cli/** (incl. main.ts; register `plugins` from sw-plugins-w9 and `--no-plugins`), src/engines/reporting/**,
  src/engines/bugs/{curl,artifact}.ts + src/engines/stress/** (quickstart fixes only), docs/09, docs/quickstart.md,
  README.md, tests/unit/cli/**, tests/e2e/** (new files), tests/unit/reporting/**.
