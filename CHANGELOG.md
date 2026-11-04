# Changelog

All notable changes to SECOND WORLD are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries reference the commit that made the change.

## [Unreleased]

### Added

- Real SQLite history backend: `history.backend: "sqlite"` uses Node's built-in `node:sqlite`
  (`.second-world/history/history.db`, WAL, transactions, schema migrations). It behaves the same as the
  JSONL store (one contract suite runs against both). Existing JSONL history is imported once and left
  unchanged. At 10,000 runs `list`/`show` go from ~150 ms to ~1 ms and `verify` from 29 s to 5 s (0bc0435).
- `sw history export --to jsonl`: copy SQLite history back into the JSONL files (f41c915).
- Plugin system (docs/10): `plugins: [...]` in the config (package names from the project's `node_modules`,
  or relative paths; `{ name, optional, options }`), `definePlugin` with an `apiVersion` check from the new
  `second-world/plugin` entry. Plugins can add report formats (`-f ns/name`), architecture rules, Bug Hunter
  assertions, history stores and lifecycle hooks; unsupported extension points fail with a clear error.
  `sw plugins list|check [--json]`, global `--no-plugins`; plugins never load under `--no-config-code` (28c6501).
- `sw report [reports...] [--last] [--run <id>]`: combine and re-render earlier reports and history runs in any
  format; no network (28c6501).
- `sw run <workflow>` and `sw run --list`: run a config workflow (a DAG of engine steps) as one run with one
  combined report and one history entry; `--dry-run` validates every step (28c6501).
- CI: a job that runs the repository's own GitHub Action; the release workflow has a manual rehearsal mode
  (every check, then `npm publish --dry-run`) (0d02d76).

### Changed

- `history.backend: "sqlite"` no longer silently uses JSONL; it falls back to JSONL with a warning only when
  `node:sqlite` is unavailable. Only node:sqlite's own ExperimentalWarning is hidden (0bc0435).
- `report.formats` and `history.backend` accept plugin ids (`namespace/name`) (28c6501).
- GitHub Actions in the workflows and `action.yml` are pinned to commit SHAs (0d02d76).

### Security

- `sw replay`: the "only load invariant modules inside the project" check compared paths without resolving
  symlinks, so a symlink inside the project pointing outside it passed and its code could be imported. Paths are
  now compared as real paths (this also fixes a false "outside the project" on macOS, where `/var` links to
  `/private/var`).

### Fixed

- Performance Lab with `workers > 1` could count a VU's first iteration as warmup (timers fire up to ~1.5 ms
  early on Linux), under-reporting requests (100 of 101). VUs now never start before their scheduled instant.
- Reliability: the jitter detector missed constant-delay retries with precise timers (Linux/macOS); it now also
  scores a 10 ms window, guarded against periodic lattices.
- Reliability: `no-circuit-breaker` could be missed on slow machines; the late-fault client outcome now counts
  only requests answered before the revert (in-flight ones were answered by the restored dependency).
- Reliability: a recovery phase too short to confirm recovery no longer reports a false "No recovery within N s";
  `slow-recovery` needs the app to still be out of bounds at the end, otherwise limitation `recovery-unconfirmed`.
- JSONL history: a reader no longer warns of an "interrupted write" when another process is appending right now
  (the trailing partial line is re-read once).
- Worker threads from TypeScript sources (tests, development) work on Node 22, which ignores `--import` loader
  hooks in workers. Built packages were not affected.
- GitHub Action: a non-zero `sw` exit ended the step before `exit-code`/`report-dir`/`sarif-file` were set and
  before the SARIF upload (GitHub runs `bash -e`).
- `sw … | head` no longer crashes with an unhandled `EPIPE` on Linux/macOS (28c6501).
- The config warning about a raw secret (`auth.x.token`) was itself mangled by log redaction; reworded (28c6501).
- docs/quickstart.md re-run end to end and rewritten from real output; its two "known issue" notes were stale
  (the stress rate-cap message and copy-paste-ready curl were already fixed) and are now regression-tested (28c6501).

## [0.1.0] - 2026-11-01

First release candidate. Not yet published to npm: publishing needs a GitHub repository and an npm token
(docs/17-versioning-and-releases.md).

### Added

- `sw bugs --path-param/--query/--header` for the main request of `--concurrency-test` (ac93109).
- `sw history verify` checks the audit-log hash chain (0029b25).
- `sw inspect` recognises hand-written `node:http` routing and `node:sqlite`/`better-sqlite3` database
  access; says when no routes or DB access were found (`ARCH_NO_ROUTES`, `ARCH_NO_DB_ACCESS`) (0029b25, fce2e0a).
- `sw agent` uses `bugs.stateful.resources` (new `agent.resources`) for ownership and lifecycle probes (c00db55).
- `sw init` takes the target from the OpenAPI `servers` URL and writes a working perf scenario (48e4757).
- Example apps `examples/conduit-api` (RealWorld API) and `examples/orders-jobs-api` (jobs, payments,
  webhooks, cache) with ground truth and system tests (415599d, fce2e0a).
- Docs: system design (docs/16), versioning & releases (docs/17), troubleshooting, threat model (docs/11)
  (5606156, 376f3ba, 9af9d93). Release workflow with npm provenance (9af9d93).

- Release engineering: CI workflow (`.github/workflows/ci.yml`: Ubuntu, macOS and Windows × Node 22.19 and 24;
  lint, typecheck, unit, integration, e2e, build, packed-tarball smoke; Linux jobs for the Docker-backed tests
  with Docker and with Podman), a composite GitHub Action (`action.yml`) that runs `sw` and can upload SARIF,
  a multi-stage non-root `Dockerfile`, `SECURITY.md` and `CONTRIBUTING.md`.
- `sw doctor` reports whether a config was found (or that `-c` points at a missing file) and whether the optional
  `typescript` peer that `sw inspect` needs is installed.
- `sw init` says what it did not detect (start script, OpenAPI file) and whether the target URL is a default.
- `npm pack` builds `dist/` first (`prepack` script) (ec5d5b1).
- `sw bugs --mix` CLI flag for mixed-operation concurrency tests; HAR export with full HAR 1.2 phase timings (fedb0a1).
- MIT `LICENSE` file (fec02cc).

### Changed

- `sw inspect` on a folder with no source files is an error run (exit 5), not a pass (ec5d5b1).
- Code formatted with Biome and imports ordered; no behaviour change (ef70d91).

### Security

- `localhost` resolving to a LAN address was allowed; loopback names must resolve to loopback (9af9d93).
- `sw replay` could import an invariant module from anywhere named in a shared artifact; only in-project
  modules load now (9af9d93).
- Secrets leaked through curl reproductions (cookies, API keys, secret query params) and through free-text
  redaction gaps; curl and HAR share one redaction rule (9af9d93).
- DNS lookups in the Safety Guard have a timeout (`dnsTimeoutMs`, 10 s) (9af9d93).
- `safety.maxRps` is enforced per World, not per engine lease (0029b25).
- A tampered history index cannot point reads outside the history folder; `sw model` Prometheus scrapes
  no longer follow redirects (dfc23b2).

### Fixed

- Concurrency: history lock races (stale-lock break, crash during lock creation, PID reuse), double Ctrl+C
  temp-file cleanup, report folders shared by parallel runs, model/arch-cache concurrent saves, audit-log
  chain under parallel processes (df5a034, c919db3, be2e261, 0029b25).
- `--dry-run` runs the same validation as a real run for perf, stress, reliability, bugs, agent (48e4757, ac93109).
- Config/engine errors name the full key with a "did you mean" suggestion (5606156, 48e4757, de5bbfb).
- `sw inspect` no longer crashes (exit 70) on 2000+ file projects with deep import chains; hashing is
  ~4x faster (fce2e0a).
- BOLA checks on owner-only writes when the read is public (780a9ed); no ownership false positive on
  public reads in `sw agent` (c00db55); race findings name the mutating operation (c00db55).
- Reports no longer crash on >120k-point series; perf errors line shows HTTP codes (48e4757).
- Malformed history files exit 2 with a message instead of 70 (be2e261).
- The package no longer ships source maps (946 kB instead of 2.5 MB) (c373f67).
- `sw doctor` showed `✔ docker` when only the docker CLI was installed and the daemon was down; it now warns
  "daemon not reachable" and marks the docker capability unavailable.
- `sw doctor` inside a container on Docker Desktop no longer labels the OS as WSL.
- Error messages no longer contain ANSI colour codes when stderr is piped (ec5d5b1).
- Stress and evolve: target and environment failures exit with their documented code instead of 70 (2ba7457).
- A run stopped by the Safety Guard exits 3, not 70 (5369223).
- Evolution input always ignores SECOND WORLD's own state folders (92e0d54); its working-tree checksum ignores
  `.second-world/`; `sw inspect` on a missing path exits 2; user-caused errors exit 2/5 instead of 70 (3d5b748).
- HTTP: custom credential headers are stripped on cross-origin redirects (63d56d7).
- Redaction: sensitive names in free text are redacted regardless of entropy (2c21870); camelCase sensitive keys
  such as `accessToken` are redacted (1544fd3).
- Safety: hex-form IPv4-mapped IPv6 addresses (`[::ffff:7f00:1]`) are classified like their IPv4 address (021d7c7).
- Agent export escapes U+2028/U+2029 in generated code; `sw analyze` handles an unknown severity (4d6c64e).
- A target that is down: `sw bugs`/`sw agent` no longer report PASS; perf, stress, bugs and agent exit 5 (77582e4).
- One history id per run; an unwritable report directory fails fast (c7b391e).
- Evolve/what-if: an app that never starts gets a hint, is skipped after two tries and exits 5 (1faacab).
- Reliability: paginated invariants, a safe fault ledger, reset after response, timeout-window rule (a79f58c).
- Artifact paths, gzipped OTLP input and exact multi-worker tick percentiles (dc0e69e).
- `typescript` is an optional peer dependency instead of being bundled; the tarball went from 10.2 MB to 2.4 MB (7e10dc0).
- Performance Lab: the iterations model ignores warm-up; a run with zero measurements is invalid (a159296).
- `sw doctor --quick` reports unprobed tools as info instead of missing (f0ca054).
- Every planted defect in the example apps is found from the app's own `sw.config.ts` (4ec683c).
- Documentation and UX mismatches found by end-to-end QA (86c665c, 2c299dd).

### Removed

- All AI/LLM features. SECOND WORLD is fully deterministic: `sw analyze` is a counted summary and the Agent
  planner is heuristic only (729fec9).

## Baseline (729fec9)

The first commit in this repository contains the engines that make up 0.1.0: Performance Lab, Stress & Capacity
Lab, Architecture Inspector, API Bug Hunter (with replay), Adversarial Test Agent, Reliability Lab, System Model,
What-If / Evolution, `sw analyze` and Experiment History, plus the Safety Guard, config loader, reporting
(tty, JSON, Markdown, JUnit, SARIF, HTML) and the example apps.
