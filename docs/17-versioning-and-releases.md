# 17 — Versioning, compatibility & releases

## Versioning

SECOND WORLD follows [Semantic Versioning](https://semver.org). While the version is `0.x`, a minor
release (`0.1` → `0.2`) may contain breaking changes; each one is listed under **Breaking** in
`CHANGELOG.md` with a migration note. Patch releases (`0.1.0` → `0.1.1`) never break anything below.

## What counts as the public contract

Each item is pinned by a test, so an accidental change fails CI instead of reaching users.

| Contract | Pinned by |
|---|---|
| Exit codes (0, 1, 2, 3, 4, 5, 70, 130) and their meaning | `tests/unit/reporting/exit-target.test.ts`, e2e exit-code tests, [troubleshooting](troubleshooting.md) |
| CLI commands and options | `sw --help` / docs/09 parity test (`tests/unit/cli/`) |
| Config schema (keys, types, defaults) | `tests/unit/cli/docs-config-examples.test.ts` (every docs example is parsed by the real loader), config schema tests |
| Report JSON (`schemaVersion: 1`) and evidence schemas | `tests/unit/design/schema-freeze.test.ts` + `__snapshots__/report-v1.json.snap`, `evidence-v1.schema.json.snap` |
| History store records | `__snapshots__/history-v1.json.snap`; older records are migrated on read (`src/engines/history/migrations.ts`, migration tests) |
| Programmatic API (`import … from "second-world"`) | `tests/unit/design/public-api.test.ts` (151 exports with their kinds) |
| Supported runtimes | `package.json` `engines.node` (≥ 22.19); CI matrix Node 22.19 and 24 on Windows, macOS, Linux |

Not part of the contract: TTY/Markdown/HTML wording and layout, log lines, internal module paths,
anything not exported from the package root.

## Deprecation

A deprecated config key or flag keeps working for at least one minor release, prints a warning naming
its replacement, and is listed under **Deprecated** in the changelog before it is removed.

## Data compatibility

- Report and history files carry a `schemaVersion`. A newer SECOND WORLD reads older files (migrated
  on read, never rewritten). An older SECOND WORLD refuses files with a newer version instead of
  misreading them.
- `history.backend: "sqlite"` is accepted but not implemented: it falls back to JSONL with a warning
  (docs/03-engines/evidence-and-history.md).

## Release checklist (maintainers)

1. On a clean checkout of the release branch:
   `npm ci && npm run lint -- --error-on-warnings && npm run typecheck && npm test`
   — the full suite twice in a row, to catch flaky tests.
2. Packed-tarball journeys: `SW_SYSTEM_PACK=1 npx vitest run tests/system/conduit.test.ts`.
3. `npm pack --dry-run`: only `dist/` (no `.map` files), `README.md`, `LICENSE`, `package.json`.
4. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and date; bump
   `package.json` `version`.
5. Tag `vX.Y.Z` and push the tag. The release workflow (`.github/workflows/release.yml`) re-runs the
   checks and publishes to npm with provenance.
6. After publishing: `npx second-world@X.Y.Z --version` and `sw doctor` in a clean folder.
