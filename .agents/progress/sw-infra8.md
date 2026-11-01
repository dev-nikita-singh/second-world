# sw-infra8 progress (wave 7b)

## Done
1. World-wide safety.maxRps: src/core/safety/guard.ts — one guard-level GCRA (`globalGcra`, from cfg.maxRps) shared by all leases; per-lease GCRA only when the lease asks for a lower rate (`rpsGcra` helper). Test tests/unit/safety/world-rate-cap.test.ts: 3/4 fail on HEAD guard.ts, 4/4 pass with fix. sw-race7's safety-rate.test.ts it.fails now "Expect test to fail" (passes) → main must flip it. tests/unit/core + unit/safety + integration/performance + integration/stress: 28 files, 380 tests pass.

## Next
2 podman probe + Linux docker portability, 3 inspect limitation / node:sqlite, 4 history verify audit chain.
2. Container portability:
   - src/adapters/faults/docker.ts (sw-design7's finished lane, edited per task): new probeContainerEngine(bin,timeout,exec?) = `version {{.Server.Version}}` then `info {{.Version.Version}}` (local podman); dockerServerVersion delegates. sandbox.ts dockerReachable + tests/integration/docker/helpers.ts dockerInfoOk use it. Docker verified locally (29.3.0 via first probe). Podman: simulated CLI replies only (tests/unit/experiments/container-probe.test.ts), NOT run against podman.
   - Rootless Linux engines: sandbox.ts engineRootless() + sandboxUser(): prepare() on linux sets --user 0:0 when rootless (docker SecurityOptions name=rootless / podman Host.Security.Rootless). Unit-tested with fakes; NOT verified on Linux.
   - toxiproxy.test.ts: HOST_GATEWAY_ARGS (--add-host host.docker.internal:host-gateway on linux) on the toxiproxy container; host upstream binds HOST_UPSTREAM_BIND (0.0.0.0 on linux). Verified locally: all 4 combos of bind/add-host reach the host on Docker Desktop (scratchpad hg.cjs). Linux: NOT verified.
   - tests/integration/docker: 3 files, 20 passed (Docker Desktop, Windows). unit faults+experiments+first-run, integration experiments+crash-cleanup: 17 files 130 pass.
   - TODO tell main: .github/workflows/ci.yml:87,96,126 still probe `docker info --format '{{.ServerVersion}}'` (fails under podman) → use `docker version --format '{{.Server.Version}}' || docker info --format '{{.Version.Version}}'`.
   - tsc: only error is tests/unit/reporting/perf-errors.test.ts:30 (sw-ux8 lane, not mine).
3. inspect coverage: src/engines/architecture/engine.ts coverageLimitations(): ARCH_NO_ROUTES (mentions node:http when imported) and ARCH_NO_DB_ACCESS, both reduces-confidence, listing supported frameworks/drivers. clients.ts: node:sqlite DatabaseSync / better-sqlite3 `.prepare/.exec` → datastore:sqlite (const origin conf 0.9; DatabaseSync-typed field/param in a file importing node:sqlite conf 0.8). Test tests/unit/architecture/coverage-gaps.test.ts: 3/5 fail with HEAD engine.ts+clients.ts, 5/5 with fix. `sw inspect examples/conduit-api --no-cache --json` (scratchpad conduit.json): 95 components / 212 edges, datastore:sqlite present, ARCH_NO_ROUTES shown with node:http note. unit/architecture+integration/architecture+e2e 12 files 88 pass; system+integration/examples+model+unit/cli+reporting 58 files 453 pass.
4. history verify + audit chain:
   - Found while wiring: parallel `sw` processes with a config file each kept their own in-memory chain head → interleaved appends broke the chain (would read as tampering). Fixed in guard.ts: audit() re-reads the chain head from the file tail (chainHeadOf, growing windows) under `audit.log.lock` (O_EXCL, 10 s stale, 2 s wait then append anyway); torn trailing line → next entry on a fresh line. verifyAuditLog: streaming 64 KiB + StringDecoder, missing file = empty chain, reason hash-mismatch / prev-hash-mismatch, torn lines = warning.
   - tests/unit/safety/audit-chain.test.ts 9 tests: 7 fail on HEAD guard.ts (incl. 4 processes × 50 entries), 9 pass now.
   - src/cli/commands/history.ts historyVerify: checks `<config cwd>/.second-world/audit.log`; exit 1 on broken chain (same as corrupted history); JSON adds history.ok + audit{}. tests/unit/safety/history-verify-audit.test.ts: 4 fail on HEAD history.ts, 4 pass.
   - docs/11 §1 table (maxRps per world) + §3 rewritten (was claiming report inclusion: not true, removed).
   - main approved guard.coverage.test.ts:194 change (applied by main). Per main's condition: CLI test "torn last line" (warning printed, JSON audit.torn) added; docs/11 §3 states last-entry-garbage = warning only.
## Final (05:50)
- npx vitest run tests/unit: 152 files, 1559 tests pass. tsc clean. biome clean on all changed files.
- integration perf+stress+concurrency+history + unit/concurrency: 17 files 63 pass. tests/integration/docker: 20 pass (Docker Desktop, Windows).
- Not verified: podman (simulated CLI replies only), Linux Docker (add-host/0.0.0.0 bind, rootless --user 0:0).
- For main: .github/workflows/ci.yml:87,96,126 still probe `docker info --format '{{.ServerVersion}}'` (fails on podman).
