# Changelog

All notable changes to SECOND WORLD are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries reference the commit that made the change.

## [Unreleased]

Work toward the first release, `0.1.0` (package version is `0.1.0-dev`; nothing is published yet).

### Added

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

### Fixed

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
