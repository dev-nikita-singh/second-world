# Progress: sw-shared

## Done (all contract rows READY in CONTRACTS.md)
- Batch A: ds/ring-buffer, ds/semaphore, stats/hdr, stats/welford, stats/window (WindowedSeries + Ewma), stats/reservoir, util/{ulid,hash,fingerprint,backoff}.
- Batch B: ds/{heap (MinHeap, KeyedMinHeap, TopK), lru, bitset, union-find (+Keyed)}; stats/{quantile (+normalCdf/normalQuantile), compare, anomaly (CUSUM, MAD), proportion (wilson), regression (Theil–Sen), knee (Kneedle)}; graph/{digraph (+toCsr), traverse, scc (+condensation), toposort (+topoLevels, CycleError), cycles, impact, paths}; src/shared/index.ts barrel.
- Tests: tests/unit/shared/*.test.ts — 9 files, 103 tests, stable over repeated runs; tsc and biome clean for owned paths.
- Messages sent: sw-perf, sw-core, sw-examples (Batch A); sw-core (graph/topoSort); main (final).

## In progress
- none

## Next
- Answer peer requests. Optional later items (not in brief): bloom, centrality (Brandes), USL fit, Jaro–Winkler, circuit breaker, Pareto front.

## Decisions
- Test RNG: tests/unit/shared/_rng.ts (mulberry32 + Box–Muller), with no dependency on sw-core.
- HDR: pure-JS Int32 buckets, autoResize false, clamp instead of throw. Exact max is lost on decode/merge (bucket-equivalent, ≤0.1%).
- WindowedSeries memory: per-window histograms use digits 2 (~14 KB). Only the last 120 fine and 60 coarse windows keep histograms (pooled), and older ones keep summary + counters. The total histogram uses digits 3.
- Semaphore is strict FIFO: tryAcquire fails while waiters are queued.
- Graph: insertion order is preserved, so output is deterministic. Algorithms run on a CSR snapshot with typed arrays and are fully iterative (100k chain/ring tests). CycleError is a plain Error (shared has no dependency on core).
- compareSamples verdict: under minRuns → inconclusive; MWU p < α AND bootstrap CI excludes 0 → improved/regressed (by direction); CI within ±equivalenceMargin → no-significant-change; else inconclusive. Outliers (MAD z > 3.5) are reported, never dropped.
- hodgesLehmann(a, b) = median(b − a).

## Blockers / requests
- none
