# Experiments: What-If Engine & Evolution Engine

Both engines compare a **baseline** against one or more **variants** under equivalent conditions, using the same statistical comparison core (`shared/stats/compare.ts`).

---

## Part A — What-If Engine

### A.1 Kinds of "what-if"

| Kind | Variable changed | Measured or estimated |
|---|---|---|
| Workload | traffic ×2, different scenario mix, payload size | **Measured** (runs the load) |
| Dependency condition | +200 ms DB latency, cache off | **Measured** (via Reliability Lab injectors) |
| Configuration | pool size, timeout, worker count, env var | **Measured** (restart target with variant config via user hook / docker-compose override) |
| Implementation | alternative query / handler | **Measured** (two endpoints, two builds, or two branches) |
| Projection | "what at 10× traffic?" beyond tested range | **Estimated** (USL / queueing model), always labelled `estimate` |

### A.2 Experiment definition

```ts
experiment({
  name: "pool-size-20-vs-50",
  hypothesis: "Pool 50 lowers p95 of /orders by ≥ 15 % at 300 rps",
  baseline: { setup: "docker compose up -d", env: { DB_POOL: "20" } },
  variants: [{ name: "pool50", env: { DB_POOL: "50" } }],
  workload: { rate: 300, duration: "2m", warmup: "20s", scenarios: [...] },
  metrics: ["p95", "p99", "rps", "error_rate", "server.cpu"],
  success: { "p95": { improvement: ">= 15%" }, "error_rate": { notWorse: true } },
  design: { repetitions: 5, order: "interleaved", seed: 7 },
});
```

### A.3 Experimental design (for valid comparisons)

- **Same environment fingerprint** for all arms (host, CPU, Node version, dataset hash). Differences produce a warning.
- **Interleaving** (ABAB… or randomised block order) instead of AAAA BBBB, to cancel drift (thermal throttling, cache warmth, noisy neighbours).
- **Repetitions** `r ≥ 5` per arm. Warm-up discarded. Environment reset between runs when `reset` hook provided.
- **Same data**: data feeders seeded identically. DB snapshot restore if available.

### A.4 Statistical comparison (deterministic)

Per metric and arm (details: [DSA §6.2](../04-data-structures-and-algorithms.md#62-statistical-comparison-of-baseline-vs-variant)):

1. Collect per-repetition summary values (e.g. p95 per run) **and** merged histograms.
2. Point estimate: relative change of medians (Hodges–Lehmann shift for robustness).
3. **Bootstrap 95 % CI** (BCa, 10,000 resamples, seeded) of the relative change.
4. **Mann–Whitney U** test (non-parametric, latency is not normal) → p-value. **Cliff's δ** effect size.
5. **Holm–Bonferroni** correction across multiple metrics/variants.
6. Verdict per metric: `improved` (CI fully beyond 0 in the good direction and meets the success threshold), `regressed`, `no-significant-change`, `inconclusive` (CI too wide, so it recommends more repetitions, estimated via the observed variance).
7. Noise floor: with an A/A test (baseline vs baseline), the engine reports the **minimum detectable effect** of this environment.

---

## Part B — Evolution Engine

### B.1 Purpose

Benchmark **candidate code changes** against a baseline commit, in isolation, and present ranked results for **human** review. It never pushes, merges, or edits the working tree.

### B.2 Workflow

```text
select problem (finding) ─► locate code path (arch graph + trace) ─► candidates
   (human-written patches or branches)
 ─► for each candidate: git worktree (isolated dir) ─► install (cached) ─► build
 ─► run test suite (user command) ─► run regression replays (from Bug Hunter history)
 ─► start app (user command, random free port) ─► wait-for-healthy
 ─► benchmark (What-If engine, interleaved with baseline) ─► stop & cleanup
 ─► rank ─► report (diff + metrics + tests + verdict) ─► human decides
```

### B.3 Isolation

- **`git worktree add`** per candidate in a temp directory, from a clean baseline commit. The user's working tree is never touched.
- Optional **container isolation**: run build/test/app inside Docker with a resource limit (`--cpus`, `--memory`) identical for all arms. This is needed for fair benchmarks and safe execution of untrusted candidate code.
- Dependency install caching: hash the lockfile, reuse `node_modules` via a hard-link copy (pnpm store, or `cp -al` on POSIX / `robocopy` fallback on Windows).
- Ports from `get-port` style allocation (bind :0). Database per candidate via a template DB clone or testcontainers.

**App start contract.** The start command gets `PORT` (or `portEnv`) and, in the docker sandbox, `HOST=0.0.0.0`. The app must listen on `process.env.HOST ?? "127.0.0.1"`: an app bound to 127.0.0.1 inside a container cannot be reached through the published port, and the health-timeout message says so. An arm whose app fails to start twice without one successful run is skipped for its remaining repetitions instead of waiting out the health timeout each time. A baseline that never starts ends the run with `SW_TARGET_APP_UNHEALTHY` (exit 5), since nothing can be compared.

### B.4 Ranking

Candidates that fail **any** correctness gate (build, tests, replays, invariants) are rejected with reasons. The remaining candidates are ranked by **Pareto dominance** on the success metrics: a candidate is kept if no other candidate is better on all metrics. Ties are broken by the weighted score the user configured, then by diff size (smaller is better), then by the observed change even when it is not significant (so statistically tied candidates are not ordered by name; their verdicts stay "inconclusive"). The output is a Pareto front, not a single "winner", when trade-offs exist.

### B.5 Safety

Candidate diffs are applied only inside worktrees and executed only in containers if `evolution.sandbox: "docker"` (default when Docker is available, otherwise the user must opt in to `"process"` sandbox). No network egress from candidate sandboxes except to declared test dependencies. All diffs are shown before benchmarking when `interactive`.

### B.6 Usage

```bash
sw evolve --finding F-01JB... --candidates branch:fix/query-a,branch:fix/index-b,patch:./c.diff \
  --test "npm test" --start "npm run start:test" --health /healthz --repetitions 5
```
