# 12 — Testing & Quality (of SECOND WORLD itself)

A measurement tool must be **more** correct than the systems it measures.

## 1. Test pyramid

| Level | Scope | Tooling | Examples |
|---|---|---|---|
| Unit | Pure DS&A, parsers, schemas | Vitest + fast-check | Semaphore never exceeds N. Histogram merge = recording all. Tarjan vs brute-force on random graphs. Units parser round-trips |
| Property | Algorithm invariants | fast-check | Percentile monotonic in q. Bootstrap CI contains the true median ~95 % on synthetic data. ddmin output still fails and is 1-minimal |
| Integration | Engine against real local servers | Vitest + Node `http` / fastify fixture servers on `:0` | Perf measures known injected latency within tolerance. Bug Hunter finds seeded bugs |
| Golden | Report output stability | Snapshot JSON (normalised timestamps/IDs) | Arch report of the fixture repo unchanged |
| E2E | CLI as a user runs it | `execa` the built CLI on each OS | Exit codes, Ctrl+C partial report, `doctor` output |
| Cross-platform | OS × Node matrix | GitHub Actions matrix | Windows paths, signals, ports |
| Performance | The tool's own overhead | `vitest bench`, custom harness | Budgets in [05 §9](05-optimization.md#9-performance-budgets-ci-enforced) |
| Determinism | Same input → same output | Run twice with the same seed and reports | Identical `sw analyze` summaries, identical Agent scenario sequences |

## 2. Measurement-accuracy test suite (the most important one)

A **calibrated fixture server** with controllable behaviour:

- Fixed latency (e.g. exactly 50 ms via timer), latency distributions (uniform, log-normal, bimodal), scheduled stalls (2 s pause at t = 10 s), error injection at x %, slow body streaming, connection resets.

Acceptance:

| Check | Tolerance |
|---|---|
| p50/p95/p99 of fixed 50 ms server | within ±2 ms (localhost) |
| Distribution percentiles vs analytic quantiles | within ±3 % |
| Achieved open-loop rate | within ±1 % of target up to 5k rps on CI runner |
| Error rate | exact (deterministic injection by request counter) |
| **Coordinated omission**: 2 s stall at 100 rps | corrected p99 reflects the stall (≥ 1 s); raw is shown separately |
| Little's Law self-check | flags an artificially throttled generator |

## 3. Fixture applications (`examples/`)

Small apps in **Express, Fastify, NestJS, Hono**, each with **seeded, documented defects**:

- N+1 query, missing timeout on outbound call, sync crypto in handler, module cycle (architecture)
- race condition on stock decrement, idempotency key ignored, BOLA on `/orders/:id`, schema drift on one field, 500 on boundary input (bugs)
- retry storm without jitter, no circuit breaker, cache-down cascade (reliability)
- a slow query with a known faster rewrite and an index (evolution)

Each defect has an **expected finding** file. CI measures recall (found / seeded) and precision (true / reported). Targets: recall ≥ 90 %, precision ≥ 85 % for deterministic engines.

## 4. Determinism tests

The same config + seed gives an identical scenario/request sequence, identical generated test cases, and identical bootstrap CIs (bit-for-bit for pure functions).

## 5. CI pipeline

```text
lint (biome) ─► typecheck ─► dependency-cruiser ─► unit+property (coverage ≥ 85 % on shared/ & core/)
 ─► build (tsdown) ─► publint + attw ─► integration (ubuntu) ─► e2e matrix:
      os: [ubuntu-latest, windows-latest, macos-latest] × node: [22, 24, 26]
      + alpine (musl) container job + arm64 job
 ─► accuracy suite ─► perf budgets ─► pack size check ─► (on tag) publish with provenance
nightly: long soak self-test, fixture recall/precision report
```

## 6. Code quality rules

- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Lint bans: `Math.random` in engines, `Date.now()` for durations, sync fs after startup, `console.*` outside CLI renderer, `shell: true`.
- Every public function has TSDoc. Every finding rule has a docs page.
- Conventional commits + changesets. Reviews require a test for every bug fix.

## 7. Definition of Done (per feature)

Unit + integration tests · works on the 3 OS in CI · documented in `docs/` · config schema updated & JSON Schema regenerated · report schema versioned if changed · performance budget unaffected · limitations listed in the engine's output.
