# sw-ship7 progress (wave 7, Plan §D)

## Done
- Unit 5 (first-run UX), evidence: tests/unit/cli/first-run.test.ts (11 pass; daemon test FAILS on HEAD probe.ts, verified by swapping file).
  - src/core/probe/probe.ts: docker client present but daemon down was "✔ docker 29.3.0" → now warn
    "(client) — daemon not reachable" + capability docker unavailable. runTool(cmd, args?) back-compatible.
    Verified: `DOCKER_HOST=tcp://127.0.0.1:1 npx sw doctor` in packed install.
  - src/core/probe/project.ts (new): doctor reports config found / none (→ sw init) / -c path missing (warn),
    and optional typescript peer missing (→ npm i -D typescript@6). Wired in src/cli/commands/doctor.ts.
  - src/cli/commands/init.ts: initSummary() lists what was not detected, default target, next step; header comment.
  - Packed tarball journey (scratchpad fr2): --version, --help, doctor, doctor --quick, init, config validate, perf w/o config.
- Reported to main (not my lane): error output colored when piped (src/cli/main.ts:544); `sw inspect` with 0 files = PASS exit 0.

- probe.ts: WSL label suppressed inside containers (test in first-run.test.ts; seen in `docker run ... doctor`).
- Unit 1 .github/workflows/ci.yml: parsed with `yaml`; DOCKER_HOST=tcp://127.0.0.1:1 hides docker in matrix
  (verified: tests/integration/docker → 20 skipped). podman job continue-on-error (podman check denied locally).
  Lint step uses `npm run lint -- --error-on-warnings` (red until lint pass).
- Unit 2 action.yml: run script extracted + run locally (bash) both branches: installed sw (inspect → exit 1, sarif),
  npx --package <tgz> (perf unreachable → exit 5, sarif). Native out path via node (Windows).
- Unit 3 Dockerfile + .dockerignore: built second-world:wave7-test (415MB), --version 0.1.0-dev, doctor exit 0,
  uid 1000 node; host app via host.docker.internal: exit 3 without allowHosts, PASS with --set allowHosts.
  Mounted examples/shop-express inspect → exit 1 (2 high).

- Unit 4 docs: CHANGELOG.md (from git log, hashes cited), SECURITY.md, CONTRIBUTING.md (claims checked: tsconfig,
  prepack, `npm run sw`), README Install (npm -D / -g --prefix / npx --package tgz / Docker / Action / source) — each
  non-GitHub command run in scratchpad; docs/quickstart.md note. Not verified: `--network host`, `--user` on Linux.
- Cleanup: my docker/inspect runs had created examples/shop-express/.second-world (broke f1 test) → removed; f1 green.
- npx vitest run tests/unit: 1459 tests, only f1 failed (caused by that dir) → rerun green. tsc clean.

## Next
- e2e as CI (DOCKER_HOST hidden, CI=true): 4 files, 31 passed, 2 skipped (docker). Sent main "ready for lint pass" 04:58.
- WAITING for main go → repo-wide lint (24 errors, 69 warnings at 04:58; many in sw-race7 concurrency files).

## Notes
- Docker tests skip via `docker info` (tests/integration/docker/helpers.ts). Evolution sandbox hardcodes `docker`.
- GitHub windows-latest Docker = Windows containers → matrix must exclude docker tests (`--exclude`).
- No `prepack` script: `npm pack` needs `npm run build` first.
- Interactive `sw init` not verified (no TTY in this harness).
