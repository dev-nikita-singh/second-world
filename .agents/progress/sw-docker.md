# Progress: sw-docker (Wave 4)

## Status: DONE. All live Docker tests pass against Docker Desktop 29.3.0 (Linux containers).
`npx vitest run tests/integration/docker tests/unit/experiments tests/unit/reliability` → 13 files, 135 tests pass.
tests/integration/{reliability,experiments} 14 pass (the docker-gated ones now run live). tsc clean, biome clean on my paths.
No leftover containers/networks (checked by label). Nothing pruned, nothing foreign touched.

## Done
- Images: node:22-alpine, ghcr.io/shopify/toxiproxy:2.12.0 (tests pull them in beforeAll if missing).
- tests/integration/docker/helpers.ts: dockerAvailable (`docker info`), TEST_LABEL io.second-world.test=docker-integration, removeLabelled, waitFor, publishedPort.
- evolution-docker.test.ts (2): temp repo (Node app + `npm test` + zero-dep lockfile + sh script; system core.autocrlf=true),
  2 branches x 2 reps in docker; tests and health pass only inside a container (/.dockerenv); 11 labelled containers
  seen, 0 left; runs ranked; working tree unchanged; cancel during a gate removes the container.
- faults-docker.test.ts (13): pause/stop/restart/network-disconnect apply + revert (docker state + HTTP), abort, TTL,
  --rm stop guard, SIGKILLed child + real CLI `sw reliability cleanup --ledger`, cleanupAll, already-reverted entry,
  detached watchdog, spawnWatchdog.
- toxiproxy.test.ts (4): latency through a real Toxiproxy (containered upstream: 4.7 → 308.8 → 3.2 ms with +300 ms;
  host upstream via host.docker.internal: 11.6 → 268 → 9.2 ms with +250 ms); reliability engine dependency-latency
  via the toxiproxy injector (steady p50 ~10 ms, fault ~308 ms, recovery ~6 ms); crash + CLI cleanup removes the toxic
  and the created proxy and leaves a user-owned proxy in place.
- Unit tests: tests/unit/experiments/docker-sandbox.test.ts (4), +3 in tests/unit/reliability/cleanup-injectors.test.ts
  (and 1 updated); tests/integration/reliability/crash-cleanup.test.ts updated (ledger now also holds the created-proxy entry).

## CLI end-to-end (exact commands; scratchpad e2e dir, MSYS_NO_PATHCONV=1 under Git Bash)
1. cwd = cfg dir with sw.config.json {evolution: sandbox image node:22-alpine/1 cpu/256m, readyWhen /healthz 60s, workload vus 2 1s, metrics p50,p95,rps}
   `sw evolve --sandbox docker --repo ../repo --candidates branch:fix/fast,branch:fix/slower --test "npm test" --start "node server.mjs" --health /healthz --repetitions 2 --metric p95 --no-history`
   → exit 0, PASS 27.8 s; sandbox docker node:22-alpine; all gates ok; 2/2 runs ok per arm; p95 baseline 35.7 ms, fix/fast 4.03 ms, fix/slower 96.1 ms
   (all inconclusive at r=2); rank 1 fix/fast, 2 fix/slower; working tree unchanged; worktrees cleaned; 0 containers left.
2. Dependency container sw-test-e2e-dep (node:22-alpine, -p 127.0.0.1::8080), host app on :47311 calling it with a 1 s timeout,
   sw.config.json reliability.dependencies.dep = {injector: docker, container: sw-test-e2e-dep}:
   `sw reliability run dependency-timeout --target http://127.0.0.1:47311 --dependency dep --steady-phase 2s --duration 4s --recovery 3s --yes --no-history`
   → exit 0; fault "container pause" applied then reverted; steady p50 5.4 ms / 0 % errors, fault p50 1007 ms / 78.6 % errors (504s),
   recovery p50 7.4 ms / 0 %; timeout detector ok (≈1010 ms); container running, not paused afterwards; ledger empty.
3. `sw reliability cleanup --ledger <tmp>/ledger.json --json` (in faults-docker / toxiproxy tests) → {"inProcess":0,"ledger":1|2,"errors":[]}, exit 0.

## Bugs found / fixed
- sandbox.ts: containers had no labels → io.second-world.{owner,sandbox,pid,instance} (+ io.second-world.run from evolution.ts).
- sandbox.ts + evolution.ts: new Sandbox.cleanup() removes containers by instance label at the end of a run (a `docker run` client killed on cancel/timeout before the container exists escapes `rm -f <name>`).
- sandbox.ts + evolution.ts: image was pulled implicitly inside the first gate / health wait (counted against their timeouts) → Sandbox.prepare() pulls up front; failure → SW_CAP_DOCKER with a hint.
- sandbox.ts: `-v C:\...:/work` → `--mount type=bind,source=...,target=...[,readonly]` (no drive-letter colon ambiguity; comma paths rejected).
- worktree.ts + evolution.ts: with core.autocrlf=true (Git for Windows default) worktrees had CRLF → `sh` scripts failed in Linux containers ("set: illegal option -", reproduced live) → docker worktrees are checked out with core.autocrlf=false/core.eol=lf.
- evolution.ts: the install cache stored a node_modules path that did not exist (npm ci with 0 deps creates none) → later arms mounted a missing directory; now cached only if it exists.
- cleanup.ts + docker.ts: ledger replay failed forever for faults already reverted (by the watchdog or an operator): "is not paused" → `sw reliability cleanup` exit 1, entry never cleared. Exec RevertAction gains `alreadyDone` (regex); docker reverts set it.
- docker.ts: "stop" on a --rm container deletes it (revert impossible; the error was swallowed as "no such container") → apply refuses.
- toxiproxy.ts: a proxy created with `create` was never removed → close() deletes it and a ledger entry (DELETE /proxies/<name>) covers crashes. Proxies that already existed are never deleted.

## Known gaps (not fixed)
- Evolution ranking with inconclusive verdicts (e.g. r=2) falls back to the name order, and every candidate is on the "front" (significance-filtered by design; pareto.ts is not in my paths). A tie-break by observed median would be better.
- restart-dependency/db-unavailable through `sw reliability run` not run end-to-end (the injector actions are covered live). With a random published port (`-p 127.0.0.1::8080`) a stop/start changes the host port; users need fixed ports.
- `docker` sandbox `network` other than none/bridge, podman, rootless Docker, Linux/macOS hosts: not tested live.
- The watchdog reverts but does not clear its ledger entry (the next cleanup now clears it without error).

## Decisions
- Live tests label everything io.second-world.test=docker-integration and only remove by that label / their own names.
