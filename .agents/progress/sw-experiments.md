# Progress: sw-experiments

## Done
- What-If (Part A), src/engines/experiments/: schema.ts (ExperimentSchema + EvolutionSchema), command.ts (splitCommand without shell, runCommand with timeout + tree kill, killTree taskkill /T /F | -pgid), app.ts (getFreePort, startApp/waitHealthy/stop), schedule.ts, analysis.ts (metrics, compareArms + Holm, verdicts, MDE, recommended reps, success, hypothesis), projection.ts (M/M/1 + USL, kind estimate), pareto.ts, types.ts, whatif.ts (executeExperiment), index.ts (whatIfEngine, runExperiment).
- Evolution (Part B): git.ts (execa git, checksum, shortstat), worktree.ts (WorktreeManager: detached worktrees in <tmp>/sw-evo-*, links unlinked before removal, cleanupAll + prune), install.ts (lockfile-hash cache; link=junction/symlink, copy, install, none; docker → read-only mount), sandbox.ts (docker: --cpus/--memory/--network none/--user/--read-only/tmpfs, docker rm -f; process: host), evolution.ts (gates worktree→install→build→test→invariants→replays→benchmark via What-If; Pareto ranking; checksum before/after), index.ts (evolutionEngine, runEvolution).
- CONTRACTS.md section "sw-experiments" — all READY.
- Tests: unit 39 (tests/unit/experiments: schedule-analysis 18, process 7, whatif-orchestration 5, evolution 9); integration 3 + 1 docker skip (whatif-shop 2, evolution 1+skip). tsc clean, biome clean on my paths.
- Measured: shop-fastify r=5 interleaved, vus 4, 1.5 s: p95 636.9 → 16.3 ms (-97.4%, CI [-97.5, -97.3]%, Holm p 0.036) improved; p50 -98.6%; rps 8 → 479 improved; error_rate no-significant-change; hypothesis supported. A/A /fixed/20 r=6: no-significant-change, MDE p50 0.84%, p95 0.89%. Evolution temp repo: fix/fast p95 0.27 ms improved, rank 1, Pareto front = [fix/fast]; fix/slower regressed (not on front); fix/broken rejected (test exit 1); working tree unchanged; worktrees cleaned.

## In progress
- none

## Next
- (optional) Docker sandbox exercised live once a daemon is available (test is skipIf(!docker)).
- (optional) DB-per-candidate (template clone / testcontainers), interactive diff display before benchmarking (§B.5 "interactive").

## Decisions
- Docker daemon not running on this machine (docker CLI present) → docker tests skipIf.
- Interleaved order = rotated blocks (AB BA AB BA…; cyclic Latin square for k arms) — counterbalances position as well as drift.
- Variants inherit every baseline field they do not set (env merged). Arms with an identical start spec share a process key (same-process/different-endpoint arms; with lifecycle per-arm they share one process).
- Verdict from Holm-adjusted MWU p + bootstrap CI (compareSamples called with minRuns 1); no-significant-change requires n >= 5 and CI within ±equivalenceMargin (0.05).
- Recommended reps: n = 2(z_{1-a/2}+z_0.8)^2 s_rel^2 / d^2 / 0.955 (MWU ARE), d = success improvement or max(margin, |observed|).
- What-If status: failed if any variant hypothesis rejected or A/A shows a difference; error if all runs failed; cancelled on signal.
- Projections: M/M/1 (S = R/(1+lambda R)) and USL fit (stress/usl.ts fitUsl) — always kind estimate.
- Evolution: baseline also runs in its own worktree (never the user's tree). Branch candidates are checked out detached (never moves branches). Diff size = git diff --shortstat base...candidate (patch: --cached after git apply --index).
- Ranking: oriented improvements vs baseline, significance-filtered (non-significant = 0); baseline included as a reference point so candidates dominated by the baseline are not on the front; tie-break weighted score (default weight 1 per rank metric when none configured), then diff lines, then name.
- Replays: run on baseline and candidates; only reproductions new vs baseline reject ("reintroduces").
- Install: "link" uses a junction on Windows (no admin), unlinked before worktree removal; host node_modules never reused in docker (platform mismatch).
- Sandbox "auto" without Docker → status skipped + EVOLUTION-NO-SANDBOX (process sandbox only on explicit opt-in + requireApproval("evolution-execution")).
- Docker start: app container on default bridge (port publish 127.0.0.1:port:port, HOST=0.0.0.0 env) → limitation EVOLUTION-START-NETWORK.

## Blockers / requests
- none
