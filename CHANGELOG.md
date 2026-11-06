# Changelog

All notable changes to SECOND WORLD are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries reference the commit that made the change.

## [Unreleased]

### Added

- Real SQLite history backend: `history.backend: "sqlite"` uses Node's built-in `node:sqlite`
  (`.second-world/history/history.db`, WAL, transactions, schema migrations). It behaves the same as the
  JSONL store (one contract suite runs against both). Existing JSONL history is imported once and left
  unchanged. At 10,000 runs `list`/`show` go from ~150 ms to ~1 ms and `verify` from 29 s to 5 s (6c86516).
- `sw history export --to jsonl`: copy SQLite history back into the JSONL files (9ab6279).
- Plugin system (docs/10): `plugins: [...]` in the config (package names from the project's `node_modules`,
  or relative paths; `{ name, optional, options }`), `definePlugin` with an `apiVersion` check from the new
  `second-world/plugin` entry. Plugins can add report formats (`-f ns/name`), architecture rules, Bug Hunter
  assertions, history stores and lifecycle hooks; unsupported extension points fail with a clear error.
  `sw plugins list|check [--json]`, global `--no-plugins`; plugins never load under `--no-config-code` (bec7735).
- `sw report [reports...] [--last] [--run <id>]`: combine and re-render earlier reports and history runs in any
  format; no network (bec7735).
- `sw run <workflow>` and `sw run --list`: run a config workflow (a DAG of engine steps) as one run with one
  combined report and one history entry; `--dry-run` validates every step (bec7735).
- CI: a job that runs the repository's own GitHub Action; the release workflow has a manual rehearsal mode
  (every check, then `npm publish --dry-run`) (3ae5722).

### Changed

- `history.backend: "sqlite"` no longer silently uses JSONL; it falls back to JSONL with a warning only when
  `node:sqlite` is unavailable. Only node:sqlite's own ExperimentalWarning is hidden (6c86516).
- `report.formats` and `history.backend` accept plugin ids (`namespace/name`) (bec7735).
- GitHub Actions in the workflows and `action.yml` are pinned to commit SHAs (3ae5722).

### Security

- `sw replay`: the "only load invariant modules inside the project" check compared paths without resolving
  symlinks, so a symlink inside the project pointing outside it passed and its code could be imported. Paths are
  now compared as real paths (this also fixes a false "outside the project" on macOS, where `/var` links to
  `/private/var`).

### Fixed

- `sw bugs` / `sw agent` ignored the OpenAPI `servers` path (`servers: [{ url: "/api" }]`, or an absolute URL's
  path, or Swagger 2 `basePath`): every request went to `/transactions` instead of `/api/transactions`. The path
  now applies when the target URL has none. Found by testing a real open-source API (gunjit-web/expense-tracker-api).
- `sw bugs` / `sw agent` read-back checks (create → read) compared fields at the top of the response, so an API
  that wraps resources (`{"transaction": {...}}`) got false "state-model mismatch" findings. Fields are now
  compared inside the envelope named by `idPointer` (`/transaction/id` → `/transaction`), and a field the read
  does not return at all (`categoryId` → `category.id`) is no longer a mismatch. Agent scenarios gain
  `ifPresent` on `json` assertions.
- Performance Lab with `workers > 1` could count a VU's first iteration as warmup (timers fire up to ~1.5 ms
  early on Linux), under-reporting requests (100 of 101). VUs now never start before their scheduled instant.
- Reliability: the jitter detector missed constant-delay retries with precise timers (Linux/macOS); it now also
  scores a 10 ms window, guarded against periodic lattices.
- Reliability: `no-circuit-breaker` could be missed on slow machines; the late-fault client outcome now counts
  only requests answered before the revert (in-flight ones were answered by the restored dependency).
- Reliability: a recovery phase too short to confirm recovery no longer reports a false "No recovery within N s";
  `slow-recovery` needs the app to still be out of bounds at the end, otherwise limitation `recovery-unconfirmed`.
- A second Ctrl+C during report or history writes no longer leaves `*.tmp`, `.lock.tmp-*` or `.lock.break` files
  behind. Temp files are created on the main thread and tracked, so the hard-exit cleanup always sees them; an
  async create queued on the libuv thread pool could finish after the cleanup (most visible on macOS).
- Tests: A/A checks assert the exit-code contract both ways (no difference → exit 0; a difference → exit 1 with
  `WHATIF-AA-DIFFERENCE`); evolve and what-if improvement tests use 7 repetitions so Holm correction is reachable;
  the `safety.maxRps` stress test uses stages where the cap is the only limit.
- JSONL history: a reader no longer warns of an "interrupted write" when another process is appending right now
  (the trailing partial line is re-read once).
- Worker threads from TypeScript sources (tests, development) work on Node 22, which ignores `--import` loader
  hooks in workers. Built packages were not affected.
- GitHub Action: a non-zero `sw` exit ended the step before `exit-code`/`report-dir`/`sarif-file` were set and
  before the SARIF upload (GitHub runs `bash -e`).
- `sw … | head` no longer crashes with an unhandled `EPIPE` on Linux/macOS (bec7735).
- The config warning about a raw secret (`auth.x.token`) was itself mangled by log redaction; reworded (bec7735).
- docs/quickstart.md re-run end to end and rewritten from real output; its two "known issue" notes were stale
  (the stress rate-cap message and copy-paste-ready curl were already fixed) and are now regression-tested (bec7735).

## [0.1.0] - 2026-11-01

First release candidate. Not yet published to npm: publishing needs a GitHub repository and an npm token
(docs/17-versioning-and-releases.md).

### Added

- `sw bugs --path-param/--query/--header` for the main request of `--concurrency-test` (32bf0bd).
- `sw history verify` checks the audit-log hash chain (8290c39).
- `sw inspect` recognises hand-written `node:http` routing and `node:sqlite`/`better-sqlite3` database
  access; says when no routes or DB access were found (`ARCH_NO_ROUTES`, `ARCH_NO_DB_ACCESS`) (8290c39, ac40b15).
- `sw agent` uses `bugs.stateful.resources` (new `agent.resources`) for ownership and lifecycle probes (40206ba).
- `sw init` takes the target from the OpenAPI `servers` URL and writes a working perf scenario (b8e577c).
- Example apps `examples/conduit-api` (RealWorld API) and `examples/orders-jobs-api` (jobs, payments,
  webhooks, cache) with ground truth and system tests (c1c5b2e, ac40b15).
- Docs: system design (docs/16), versioning & releases (docs/17), troubleshooting, threat model (docs/11)
  (ddda0af, 9f56553, 2e82ba2). Release workflow with npm provenance (2e82ba2).

- Release engineering: CI workflow (`.github/workflows/ci.yml`: Ubuntu, macOS and Windows × Node 22.19 and 24;
  lint, typecheck, unit, integration, e2e, build, packed-tarball smoke; Linux jobs for the Docker-backed tests
  with Docker and with Podman), a composite GitHub Action (`action.yml`) that runs `sw` and can upload SARIF,
  a multi-stage non-root `Dockerfile`, `SECURITY.md` and `CONTRIBUTING.md`.
- `sw doctor` reports whether a config was found (or that `-c` points at a missing file) and whether the optional
  `typescript` peer that `sw inspect` needs is installed.
- `sw init` says what it did not detect (start script, OpenAPI file) and whether the target URL is a default.
- `npm pack` builds `dist/` first (`prepack` script) (8d8b386).
- `sw bugs --mix` CLI flag for mixed-operation concurrency tests; HAR export with full HAR 1.2 phase timings (eb97c97).
- MIT `LICENSE` file (a3ae4ea).

### Changed

- `sw inspect` on a folder with no source files is an error run (exit 5), not a pass (8d8b386).
- Code formatted with Biome and imports ordered; no behaviour change (3e106c1).

### Security

- `localhost` resolving to a LAN address was allowed; loopback names must resolve to loopback (2e82ba2).
- `sw replay` could import an invariant module from anywhere named in a shared artifact; only in-project
  modules load now (2e82ba2).
- Secrets leaked through curl reproductions (cookies, API keys, secret query params) and through free-text
  redaction gaps; curl and HAR share one redaction rule (2e82ba2).
- DNS lookups in the Safety Guard have a timeout (`dnsTimeoutMs`, 10 s) (2e82ba2).
- `safety.maxRps` is enforced per World, not per engine lease (8290c39).
- A tampered history index cannot point reads outside the history folder; `sw model` Prometheus scrapes
  no longer follow redirects (9643970).

### Fixed

- Concurrency: history lock races (stale-lock break, crash during lock creation, PID reuse), double Ctrl+C
  temp-file cleanup, report folders shared by parallel runs, model/arch-cache concurrent saves, audit-log
  chain under parallel processes (8bb320c, 43573b9, 370c83f, 8290c39).
- `--dry-run` runs the same validation as a real run for perf, stress, reliability, bugs, agent (b8e577c, 32bf0bd).
- Config/engine errors name the full key with a "did you mean" suggestion (ddda0af, b8e577c, f310da8).
- `sw inspect` no longer crashes (exit 70) on 2000+ file projects with deep import chains; hashing is
  ~4x faster (ac40b15).
- BOLA checks on owner-only writes when the read is public (cc78bb7); no ownership false positive on
  public reads in `sw agent` (40206ba); race findings name the mutating operation (40206ba).
- Reports no longer crash on >120k-point series; perf errors line shows HTTP codes (b8e577c).
- Malformed history files exit 2 with a message instead of 70 (370c83f).
- The package no longer ships source maps (946 kB instead of 2.5 MB) (5751897).
- `sw doctor` showed `✔ docker` when only the docker CLI was installed and the daemon was down; it now warns
  "daemon not reachable" and marks the docker capability unavailable.
- `sw doctor` inside a container on Docker Desktop no longer labels the OS as WSL.
- Error messages no longer contain ANSI colour codes when stderr is piped (8d8b386).
- Stress and evolve: target and environment failures exit with their documented code instead of 70 (89ad7d8).
- A run stopped by the Safety Guard exits 3, not 70 (65f618e).
- Evolution input always ignores SECOND WORLD's own state folders (58ab836); its working-tree checksum ignores
  `.second-world/`; `sw inspect` on a missing path exits 2; user-caused errors exit 2/5 instead of 70 (6f7978b).
- HTTP: custom credential headers are stripped on cross-origin redirects (4dcb570).
- Redaction: sensitive names in free text are redacted regardless of entropy (42f3aa3); camelCase sensitive keys
  such as `accessToken` are redacted (0e10afe).
- Safety: hex-form IPv4-mapped IPv6 addresses (`[::ffff:7f00:1]`) are classified like their IPv4 address (529d668).
- Agent export escapes U+2028/U+2029 in generated code; `sw analyze` handles an unknown severity (753c4bc).
- A target that is down: `sw bugs`/`sw agent` no longer report PASS; perf, stress, bugs and agent exit 5 (2f319b5).
- One history id per run; an unwritable report directory fails fast (f53b6be).
- Evolve/what-if: an app that never starts gets a hint, is skipped after two tries and exits 5 (c49d9f5).
- Reliability: paginated invariants, a safe fault ledger, reset after response, timeout-window rule (542f410).
- Artifact paths, gzipped OTLP input and exact multi-worker tick percentiles (00a349b).
- `typescript` is an optional peer dependency instead of being bundled; the tarball went from 10.2 MB to 2.4 MB (a01b3c8).
- Performance Lab: the iterations model ignores warm-up; a run with zero measurements is invalid (abe1419).
- `sw doctor --quick` reports unprobed tools as info instead of missing (35c53c5).
- Every planted defect in the example apps is found from the app's own `sw.config.ts` (e7f5357).
- Documentation and UX mismatches found by end-to-end QA (d707815, 2b721a8).

### Removed

- All AI/LLM features. SECOND WORLD is fully deterministic: `sw analyze` is a counted summary and the Agent
  planner is heuristic only (b96bf07).

## Baseline (b96bf07)

The first commit in this repository contains the engines that make up 0.1.0: Performance Lab, Stress & Capacity
Lab, Architecture Inspector, API Bug Hunter (with replay), Adversarial Test Agent, Reliability Lab, System Model,
What-If / Evolution, `sw analyze` and Experiment History, plus the Safety Guard, config loader, reporting
(tty, JSON, Markdown, JUnit, SARIF, HTML) and the example apps.
