# Changelog

All notable changes to SECOND WORLD are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries reference the commit that made the change.

## [Unreleased]

### Added

- Real SQLite history backend: `history.backend: "sqlite"` uses Node's built-in `node:sqlite`
  (`.second-world/history/history.db`, WAL, transactions, schema migrations). It behaves the same as the
  JSONL store (one contract suite runs against both). Existing JSONL history is imported once and left
  unchanged. At 10,000 runs `list`/`show` go from ~150 ms to ~1 ms and `verify` from 29 s to 5 s (d26f518).
- `sw history export --to jsonl`: copy SQLite history back into the JSONL files (a580b78).
- Plugin system (docs/10): `plugins: [...]` in the config (package names from the project's `node_modules`,
  or relative paths; `{ name, optional, options }`), `definePlugin` with an `apiVersion` check from the new
  `second-world/plugin` entry. Plugins can add report formats (`-f ns/name`), architecture rules, Bug Hunter
  assertions, history stores and lifecycle hooks; unsupported extension points fail with a clear error.
  `sw plugins list|check [--json]`, global `--no-plugins`; plugins never load under `--no-config-code` (372ebba).
- `sw report [reports...] [--last] [--run <id>]`: combine and re-render earlier reports and history runs in any
  format; no network (372ebba).
- `sw run <workflow>` and `sw run --list`: run a config workflow (a DAG of engine steps) as one run with one
  combined report and one history entry; `--dry-run` validates every step (372ebba).
- CI: a job that runs the repository's own GitHub Action; the release workflow has a manual rehearsal mode
  (every check, then `npm publish --dry-run`) (dfb3f52).

### Changed

- `history.backend: "sqlite"` no longer silently uses JSONL; it falls back to JSONL with a warning only when
  `node:sqlite` is unavailable. Only node:sqlite's own ExperimentalWarning is hidden (d26f518).
- `report.formats` and `history.backend` accept plugin ids (`namespace/name`) (372ebba).
- GitHub Actions in the workflows and `action.yml` are pinned to commit SHAs (dfb3f52).

### Fixed

- `sw … | head` no longer crashes with an unhandled `EPIPE` on Linux/macOS (372ebba).
- The config warning about a raw secret (`auth.x.token`) was itself mangled by log redaction; reworded (372ebba).
- docs/quickstart.md re-run end to end and rewritten from real output; its two "known issue" notes were stale
  (the stress rate-cap message and copy-paste-ready curl were already fixed) and are now regression-tested (372ebba).

## [0.1.0] - 2026-11-01

First release candidate. Not yet published to npm: publishing needs a GitHub repository and an npm token
(docs/17-versioning-and-releases.md).

### Added

- `sw bugs --path-param/--query/--header` for the main request of `--concurrency-test` (de5a7cd).
- `sw history verify` checks the audit-log hash chain (27084d5).
- `sw inspect` recognises hand-written `node:http` routing and `node:sqlite`/`better-sqlite3` database
  access; says when no routes or DB access were found (`ARCH_NO_ROUTES`, `ARCH_NO_DB_ACCESS`) (27084d5, 044601f).
- `sw agent` uses `bugs.stateful.resources` (new `agent.resources`) for ownership and lifecycle probes (d037c40).
- `sw init` takes the target from the OpenAPI `servers` URL and writes a working perf scenario (89ef4f0).
- Example apps `examples/conduit-api` (RealWorld API) and `examples/orders-jobs-api` (jobs, payments,
  webhooks, cache) with ground truth and system tests (26993ac, 044601f).
- Docs: system design (docs/16), versioning & releases (docs/17), troubleshooting, threat model (docs/11)
  (cf4a48d, 1d76ea4, 2656ed8). Release workflow with npm provenance (2656ed8).

- Release engineering: CI workflow (`.github/workflows/ci.yml`: Ubuntu, macOS and Windows × Node 22.19 and 24;
  lint, typecheck, unit, integration, e2e, build, packed-tarball smoke; Linux jobs for the Docker-backed tests
  with Docker and with Podman), a composite GitHub Action (`action.yml`) that runs `sw` and can upload SARIF,
  a multi-stage non-root `Dockerfile`, `SECURITY.md` and `CONTRIBUTING.md`.
- `sw doctor` reports whether a config was found (or that `-c` points at a missing file) and whether the optional
  `typescript` peer that `sw inspect` needs is installed.
- `sw init` says what it did not detect (start script, OpenAPI file) and whether the target URL is a default.
- `npm pack` builds `dist/` first (`prepack` script) (3070d0c).
- `sw bugs --mix` CLI flag for mixed-operation concurrency tests; HAR export with full HAR 1.2 phase timings (8d9bb95).
- MIT `LICENSE` file (2dfb365).

### Changed

- `sw inspect` on a folder with no source files is an error run (exit 5), not a pass (3070d0c).
- Code formatted with Biome and imports ordered; no behaviour change (cd7bb37).

### Security

- `localhost` resolving to a LAN address was allowed; loopback names must resolve to loopback (2656ed8).
- `sw replay` could import an invariant module from anywhere named in a shared artifact; only in-project
  modules load now (2656ed8).
- Secrets leaked through curl reproductions (cookies, API keys, secret query params) and through free-text
  redaction gaps; curl and HAR share one redaction rule (2656ed8).
- DNS lookups in the Safety Guard have a timeout (`dnsTimeoutMs`, 10 s) (2656ed8).
- `safety.maxRps` is enforced per World, not per engine lease (27084d5).
- A tampered history index cannot point reads outside the history folder; `sw model` Prometheus scrapes
  no longer follow redirects (f559ad6).

### Fixed

- Concurrency: history lock races (stale-lock break, crash during lock creation, PID reuse), double Ctrl+C
  temp-file cleanup, report folders shared by parallel runs, model/arch-cache concurrent saves, audit-log
  chain under parallel processes (7d11c85, cfb1f94, 4c636e0, 27084d5).
- `--dry-run` runs the same validation as a real run for perf, stress, reliability, bugs, agent (89ef4f0, de5a7cd).
- Config/engine errors name the full key with a "did you mean" suggestion (cf4a48d, 89ef4f0, 1faefaf).
- `sw inspect` no longer crashes (exit 70) on 2000+ file projects with deep import chains; hashing is
  ~4x faster (044601f).
- BOLA checks on owner-only writes when the read is public (4ca674c); no ownership false positive on
  public reads in `sw agent` (d037c40); race findings name the mutating operation (d037c40).
- Reports no longer crash on >120k-point series; perf errors line shows HTTP codes (89ef4f0).
- Malformed history files exit 2 with a message instead of 70 (4c636e0).
- The package no longer ships source maps (946 kB instead of 2.5 MB) (f6e246d).
- `sw doctor` showed `✔ docker` when only the docker CLI was installed and the daemon was down; it now warns
  "daemon not reachable" and marks the docker capability unavailable.
- `sw doctor` inside a container on Docker Desktop no longer labels the OS as WSL.
- Error messages no longer contain ANSI colour codes when stderr is piped (3070d0c).
- Stress and evolve: target and environment failures exit with their documented code instead of 70 (d2cc1d7).
- A run stopped by the Safety Guard exits 3, not 70 (a7fdf83).
- Evolution input always ignores SECOND WORLD's own state folders (db5ef7d); its working-tree checksum ignores
  `.second-world/`; `sw inspect` on a missing path exits 2; user-caused errors exit 2/5 instead of 70 (54069e9).
- HTTP: custom credential headers are stripped on cross-origin redirects (5ef45e6).
- Redaction: sensitive names in free text are redacted regardless of entropy (9d809d9); camelCase sensitive keys
  such as `accessToken` are redacted (de680b9).
- Safety: hex-form IPv4-mapped IPv6 addresses (`[::ffff:7f00:1]`) are classified like their IPv4 address (b8d8242).
- Agent export escapes U+2028/U+2029 in generated code; `sw analyze` handles an unknown severity (5649666).
- A target that is down: `sw bugs`/`sw agent` no longer report PASS; perf, stress, bugs and agent exit 5 (b038b02).
- One history id per run; an unwritable report directory fails fast (e31ec60).
- Evolve/what-if: an app that never starts gets a hint, is skipped after two tries and exits 5 (fed5901).
- Reliability: paginated invariants, a safe fault ledger, reset after response, timeout-window rule (49dc1ca).
- Artifact paths, gzipped OTLP input and exact multi-worker tick percentiles (1e7b8e8).
- `typescript` is an optional peer dependency instead of being bundled; the tarball went from 10.2 MB to 2.4 MB (50986b7).
- Performance Lab: the iterations model ignores warm-up; a run with zero measurements is invalid (a658f11).
- `sw doctor --quick` reports unprobed tools as info instead of missing (3614750).
- Every planted defect in the example apps is found from the app's own `sw.config.ts` (01c06c8).
- Documentation and UX mismatches found by end-to-end QA (c1a566a, 242c61e).

### Removed

- All AI/LLM features. SECOND WORLD is fully deterministic: `sw analyze` is a counted summary and the Agent
  planner is heuristic only (452ec5b).

## Baseline (452ec5b)

The first commit in this repository contains the engines that make up 0.1.0: Performance Lab, Stress & Capacity
Lab, Architecture Inspector, API Bug Hunter (with replay), Adversarial Test Agent, Reliability Lab, System Model,
What-If / Evolution, `sw analyze` and Experiment History, plus the Safety Guard, config loader, reporting
(tty, JSON, Markdown, JUnit, SARIF, HTML) and the example apps.
