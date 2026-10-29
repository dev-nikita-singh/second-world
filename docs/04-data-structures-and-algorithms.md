# 04 — Data Structures & Algorithms

This is the complete catalogue of the data structures and algorithms SECOND WORLD uses: where each one is used, why it was chosen, its complexity, and a reference implementation sketch. Nothing here is novel. The value is in applying established techniques **correctly**.

> Notation: `n` items, `k` buckets/capacity, `V`/`E` vertices/edges, `B` bootstrap resamples.
> Location column = module under `src/shared/` unless noted.

## 0. Master table

| # | Technique | Used by | Time | Space | Location |
|---|---|---|---|---|---|
| 2.1 | Counting semaphore | Perf, Bugs, Agent, Orchestrator | O(1) acquire/release | O(waiters) | `ds/semaphore.ts` |
| 2.2 | Ring buffer / deque | Semaphore queue, time windows, event bus | O(1) push/pop | O(k) fixed | `ds/ring-buffer.ts` |
| 2.3 | Binary min-heap | Scheduler, timers, top-N | O(log n) push/pop | O(n) | `ds/heap.ts` |
| 2.4 | LRU cache (Map-ordered) | AST cache, Ajv validators | O(1) | O(k) | `ds/lru.ts` |
| 2.5 | Bitset | Coverage tracking | O(1) set/test | O(n/32) | `ds/bitset.ts` |
| 2.6 | Bloom filter (optional) | Scenario dedup on long agent runs | O(h) | O(m bits) | `ds/bloom.ts` |
| 2.7 | String interning / CSR graph | Large repos | O(1) lookup | compact | `graph/csr.ts` |
| 3.1 | Closed-loop VU scheduler | Perf | O(1)/iteration | O(VUs) | `engines/performance` |
| 3.2 | Open-loop arrival scheduler (drift-free) | Perf, Stress | O(1)/arrival | O(1) | `engines/performance` |
| 3.3 | Poisson arrivals (inverse CDF) | Perf | O(1) | O(1) | `stats/random.ts` |
| 3.4 | Token bucket / GCRA | Safety budgets, rate cap | O(1) | O(1) | `core/safety` |
| 3.5 | Coordinated-omission correction | Perf | O(gap/interval) | O(1) | `stats/hdr.ts` |
| 3.6 | Exponential backoff + full jitter | HTTP retries, telemetry export | O(1) | O(1) | `util/backoff.ts` |
| 3.7 | Circuit breaker FSM | Adapters (telemetry) | O(1) | O(1) | `util/breaker.ts` |
| 4.1 | HDR histogram | All latency metrics | O(1) record, O(k) quantile | O(k) fixed | `stats/hdr.ts` |
| 4.2 | Welford mean/variance | Summaries | O(1) | O(1) | `stats/welford.ts` |
| 4.3 | Quantile definitions (nearest-rank) | Reports | O(k) | — | `stats/quantile.ts` |
| 4.4 | Sliding windows + EWMA | Live view, soak | O(1) | O(window) | `stats/window.ts` |
| 4.5 | Reservoir sampling (Algorithm R) | Error/response samples | O(1) | O(k) | `stats/reservoir.ts` |
| 4.6 | Little's Law | Generator self-check | O(1) | O(1) | `engines/performance` |
| 5.1 | Directed graph (adjacency + reverse) | Arch, Model | O(1) edge add | O(V+E) | `graph/digraph.ts` |
| 5.2 | BFS (iterative) | Reachability, shortest cycle | O(V+E) | O(V) | `graph/traverse.ts` |
| 5.3 | DFS (iterative) | Ordering, paths | O(V+E) | O(V) | `graph/traverse.ts` |
| 5.4 | Tarjan SCC (iterative) | Cycles | O(V+E) | O(V) | `graph/scc.ts` |
| 5.5 | Kahn topological sort | Workflow DAG, condensation | O(V+E) | O(V) | `graph/toposort.ts` |
| 5.6 | DAG longest path (DP) | Deep chains, critical path | O(V+E) | O(V) | `graph/paths.ts` |
| 5.7 | Brandes betweenness | Hub detection (opt-in) | O(VE) | O(V+E) | `graph/centrality.ts` |
| 5.8 | Union-find | Entity resolution | ~O(α(n)) | O(n) | `ds/union-find.ts` |
| 5.9 | Jaro-Winkler similarity | Name matching | O(len²) | O(len) | `util/strings.ts` |
| 5.10 | AST visitor (iterative) | Arch extraction | O(nodes) | O(depth) | `engines/architecture` |
| 6.1 | Kneedle knee detection | Stress | O(n) | O(n) | `stats/knee.ts` |
| 6.2 | Bootstrap CI, Mann–Whitney U, Cliff's δ, Hodges–Lehmann, Holm | What-If, Evolution, History | O(B·n), O(n log n) | O(n) | `stats/compare.ts` |
| 6.3 | CUSUM change-point, MAD z-score | History, soak | O(n) | O(1)/O(n) | `stats/anomaly.ts` |
| 6.4 | Theil–Sen regression | Soak drift | O(n²) (n small) | O(n²) | `stats/regression.ts` |
| 6.5 | USL non-linear least squares | Capacity estimate | O(iter·n) | O(n) | `stats/usl.ts` |
| 6.6 | Wilson score interval | Flaky failure rate | O(1) | O(1) | `stats/proportion.ts` |
| 7.1 | Boundary-value analysis / equivalence classes | Bugs | O(params) | — | `engines/bugs` |
| 7.2 | Property-based testing + shrinking | Bugs | O(runs) | — | fast-check |
| 7.3 | Pairwise (IPOG) | Bugs | ~O(v²·p·log) | O(cases) | `engines/bugs/pairwise.ts` |
| 7.4 | Delta debugging (ddmin) | Minimise sequences | O(n²) worst | O(n) | `engines/bugs/ddmin.ts` |
| 7.5 | Linearizability check (Wing–Gong, bounded) | Concurrency tests | exp. worst, pruned | O(n) | `engines/bugs/linearize.ts` |
| 7.6 | FSM model-based testing | Stateful tests | O(steps) | O(states) | fast-check `commands` |
| 8.1 | Multi-armed bandit UCB1 / Thompson | Agent | O(arms) | O(arms) | `engines/agent/bandit.ts` |
| 8.3 | Pareto front | Evolution ranking | O(c²·m) | O(c) | `stats/pareto.ts` |
| 9.1 | SHA-256 content hashing | Cache, fingerprints | O(bytes) | O(1) | `util/hash.ts` |
| 9.2 | ULID | IDs | O(1) | — | `util/ulid.ts` |
| 9.3 | Seeded PRNG (xoshiro128**) + splitmix | Determinism | O(1) | O(1) | `core/rng.ts` |
| 9.4 | Shannon entropy + pattern matching | Secret redaction | O(len) | O(1) | `core/log/redact.ts` |
| 9.5 | Append-only log + atomic rename | History | O(1) append | — | `engines/history` |

---

## 1. Design rules for all DS&A code

1. **Bounded memory**: every structure that grows with test duration has a fixed cap (histograms, reservoirs, ring buffers). A 24 h soak must use the same memory as a 1 min test.
2. **No recursion on user-sized input**: graphs and ASTs can be deep. Use explicit stacks (avoids `RangeError: Maximum call stack size exceeded`).
3. **Deterministic**: all randomness comes from the seeded `Rng` in context, never `Math.random()` (lint rule).
4. **Monotonic time**: `performance.now()` / `process.hrtime.bigint()` for durations. `Date` only for wall-clock timestamps in reports.
5. **Typed arrays in hot paths**: `Float64Array`, `Int32Array`, `BigUint64Array` avoid boxing and GC churn.
6. **Pure & testable**: algorithms are pure functions over plain data, unit-tested with property tests (e.g. "merging two histograms equals recording all values in one").

---

## 2. Core data structures

### 2.1 Counting semaphore (bounded concurrency)

Limits in-flight operations (requests, workflow steps, parsers). Waiters are queued FIFO in a ring buffer for fairness. Cancellation removes the waiter and rejects with `AbortError`.

```ts
export class Semaphore {
  private permits: number;
  private waiters = new RingBuffer<() => void>(1024, { grow: true });
  constructor(max: number) { this.permits = max; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.permits > 0) { this.permits--; return this.releaseOnce(); }
    await new Promise<void>((resolve, reject) => {
      const w = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => { this.waiters.remove(w); reject(signal!.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
    });
    return this.releaseOnce();
  }
  private releaseOnce() {
    let done = false;
    return () => { if (done) return; done = true;
      const next = this.waiters.shift(); next ? next() : this.permits++; };
  }
}
```

Complexity: O(1) acquire/release, O(n) only for abort-removal (rare). The permit is handed directly to the next waiter, so there is no thundering herd.

### 2.2 Ring buffer / deque

Fixed-capacity circular array with `head`/`tail` indices, wrap-around via `& (cap-1)` (cap is a power of two). Used for semaphore waiters (growable), the last N one-second windows (fixed), and the event bus queue. O(1) push/shift, no array shifting (`Array.prototype.shift` is O(n)).

### 2.3 Binary min-heap (priority queue)

Keyed by the scheduled time. Used by the open-loop scheduler when many scenarios have independent arrival processes, by timers for think-time wake-ups, and by top-N slowest requests (a min-heap of size N keeps the N largest in O(log N) per insert). Implemented over parallel typed arrays (keys `Float64Array`, values index) to avoid object allocation.

### 2.4 LRU cache

JS `Map` keeps insertion order. On `get`, delete and re-insert. On overflow, evict `map.keys().next()`. O(1). Caches: compiled Ajv validators per schema hash, parsed AST/extract results per file hash, DNS results (short TTL).

### 2.5 Bitset

A `Uint32Array` for coverage of (operation × status × schema-branch) combinations. Fast popcount gives coverage %.

### 2.6 Bloom filter (optional)

For agent runs with >10⁶ scenario fingerprints. With `m` bits and `h` hashes (double hashing from one SHA-256), the false-positive rate is ≈ `(1 − e^(−hn/m))^h`. A false positive only means a scenario is skipped, never a wrong result.

### 2.7 Interning & CSR graph

For repos with 10⁵+ nodes, string IDs map to dense integers (`Map<string, number>` + `string[]`). The graph is then frozen into **Compressed Sparse Row** form: `offsets: Int32Array(V+1)`, `targets: Int32Array(E)`. Traversals become cache-friendly array scans, 3–10× faster and much smaller than `Map<string, Set<string>>`.

---

## 3. Scheduling, coordinated omission

### 3.1 Closed-loop (virtual users)

Each VU is an async loop: `while (!signal.aborted && now < end) { await runIteration(); await sleep(thinkTime()); }`. Ramp-up starts VUs at times `t_i = rampUp · i / N` (or according to a stage curve). Concurrency is naturally bounded by the VU count.

### 3.2 Open-loop arrival scheduler (drift-free)

Requests are released according to a **precomputed schedule** relative to the start time, not a chain of `setTimeout(interval)` calls. Chained timeouts accumulate drift and timer coarseness (1 ms+, up to 15.6 ms on Windows).

```ts
// intended start of the i-th request (constant rate r)
const intended = (i: number) => t0 + (i * 1000) / r;
loop: wake at next intended time (setTimeout for coarse wait, then setImmediate spin for < 2 ms),
      release ALL arrivals whose intended time <= now  (catch-up burst, counted as lag),
      each request records latency from its *intended* time.
```

If the in-flight count would exceed `maxInFlight` (a safety cap), the arrival is counted as **dropped** and reported, instead of silently delayed. Silent delay would be coordinated omission again.

### 3.3 Poisson arrivals

Real traffic is often memoryless. Inter-arrival `Δ = −ln(1 − U) / λ`, with `U ~ Uniform[0,1)` from the seeded RNG. Produces bursts and gaps with average rate λ. O(1) per arrival.

### 3.4 Rate limiting: token bucket / GCRA

Safety budgets (`maxRps`) use the **Generic Cell Rate Algorithm**, an exact token bucket that stores only a theoretical arrival time (TAT):

```text
on request at t:  tat = max(TAT, t);  if tat − t > burstTolerance → reject/wait
                  else TAT = tat + 1/rate
```

O(1) time and memory, no timer needed to refill tokens.

### 3.5 Coordinated-omission correction

**Problem**: in a closed loop, if the server stalls for 2 s, the generator also stops sending. You record one 2 s sample instead of the ~200 samples that real users would have experienced. p99 then looks great when it isn't.

**Fixes** (both implemented):

1. Open loop with intended-start timestamps (3.2). This is the correct fix.
2. For closed loop: `recordValueWithExpectedInterval(v, expected)`. When `v > expected`, also record `v − expected`, `v − 2·expected`, … down to `expected`. These are the synthetic samples of users who would have been waiting.

Reports show **corrected** values by default and **raw** values side by side.

### 3.6 Exponential backoff with full jitter

`delay = random(0, min(cap, base · 2^attempt))`. Full jitter avoids synchronised retry storms (AWS architecture analysis). It is used by the telemetry exporter and the optional HTTP retry policy (**off by default** in load tests, because retries distort metrics).

### 3.7 Circuit breaker FSM

States `closed → open` (after F failures in a window) `→ half-open` (after a cooldown, allow 1 probe) `→ closed/open`. It protects SECOND WORLD's own calls to telemetry endpoints, and the Reliability Lab uses the same model to *detect* breaker behaviour in the target.

---

## 4. Statistics & streaming metrics

### 4.1 HDR histogram

**Why**: storing every latency sample for 1 M req/min is memory-heavy, and sorting it at the end is O(n log n). Approximate sketches (t-digest) have unbounded relative error at the tails. HDR gives **bounded relative error** (3 significant digits = 0.1 %) across 1 µs–1 h with **fixed memory** (~30–200 KB), **O(1) record**, and **lossless merge** (bucket-wise add). This is ideal for many workers and many endpoints.

**How**: values are bucketed log-linearly. There are `2^b` linear sub-buckets inside each power-of-two magnitude. Index = `f(magnitude via leading-zero count, sub-bucket)`. Quantile = cumulative walk over counts, O(k).

Library: `hdr-histogram-js` (pure JS + optional WASM). Encoded histograms (compressed base64) are stored in reports so later tools can re-merge and re-query any percentile.

Alternatives considered: t-digest (good for mergeable quantiles of unbounded range, but weaker tail guarantees), DDSketch (relative-error guarantee, good choice if HDR's range is ever limiting; adapter-ready).

### 4.2 Welford's online mean & variance

```text
n += 1; δ = x − mean; mean += δ / n; M2 += δ · (x − mean);   variance = M2 / (n − 1)
```

Numerically stable (the naive Σx² − (Σx)² loses precision). Parallel merge (Chan et al.): combine (n, mean, M2) pairs from workers in O(1).

### 4.3 Quantile definitions

Percentiles use **nearest-rank** on the histogram: the smallest value `v` such that `count(≤ v) ≥ ⌈q·n⌉`. For small raw-sample sets (bootstrap, n < 10⁴), **Hyndman–Fan type 7** (linear interpolation, the R/NumPy default) is used. The definition is written into the report's methods section, because different tools disagree at the tails.

### 4.4 Sliding windows & EWMA

- Fixed 1-second windows (each a small HDR + counters) in a ring buffer of the last 3,600 windows (1 h). Older windows are folded into minute windows (downsampling), keeping memory bounded for soaks.
- Rolling p95 over the last w windows = merge w histograms (O(w·k), w small).
- EWMA for live display: `s = α·x + (1−α)·s`, with α = 1 − e^(−Δt/τ). Time-aware, so irregular ticks are handled.

### 4.5 Reservoir sampling

Algorithm R: keep the first k items. For item i > k, replace a random slot with probability k/i. This gives a uniform sample of error responses/bodies with fixed memory, so a report can show representative examples from a 10 M request run. A separate "first N distinct errors" map (by fingerprint) ensures rare error types are not lost.

### 4.6 Little's Law sanity check

`L = λ · W` (mean concurrency = throughput × mean latency). With measured λ and W, the expected in-flight count is compared to the actual sampled in-flight count. A large mismatch indicates hidden queueing in the generator, a broken measurement, or connection-pool starvation. It is cheap and catches whole classes of measurement bugs.

---

## 5. Graph algorithms

### 5.1 Directed graph representation

`out: Map<Id, Set<Id>>`, `in: Map<Id, Set<Id>>` (reverse index), `edgeData: Map<"a→b", EdgeMeta[]>` (multi-evidence). O(1) add/has, O(deg) neighbours. Frozen to CSR (2.7) for heavy analyses.

### 5.2 BFS (iterative)

Queue = ring buffer. Uses: reachability (route → datastore), **impact set** (reverse BFS from a failing dependency), k-hop neighbourhood (model views), **shortest cycle** inside an SCC (BFS from each node back to itself, which finds the minimal example cycle to show the user).

### 5.3 DFS (iterative)

Explicit stack of `(node, iteratorIndex)`. Uses: enumerating paths for display (bounded by `maxPaths`), and pre/post ordering for topological operations.

### 5.4 Tarjan's SCC (iterative)

Finds all strongly connected components in one pass, O(V+E). Any SCC with >1 node (or a self-loop) is a dependency cycle. The iterative version keeps `index`, `lowlink`, `onStack` in `Int32Array`s and simulates the recursion with a call stack. This is required for 10⁵-node module graphs.

```text
for each unvisited v: push frame(v)
  frame: assign index/lowlink, push v on S
  iterate successors w:
    if w unvisited → push frame(w), resume later, then lowlink[v] = min(lowlink[v], lowlink[w])
    elif onStack[w] → lowlink[v] = min(lowlink[v], index[w])
  if lowlink[v] == index[v] → pop S until v → one SCC
```

### 5.5 Kahn's topological sort

In-degree counting + queue, O(V+E). Uses: (a) orchestrator workflow DAG ordering & parallel "levels", and (b) ordering the **condensation graph** (each SCC collapsed to one node, which is always a DAG). A leftover non-zero in-degree means a cycle in a workflow, which is reported as a config error with the cycle path.

### 5.6 DAG longest path / critical path

DP over topological order: `dist[v] = max(dist[u] + w(u,v))`. Uses: deepest call chains (architecture), **trace critical path** (span DAG where weight = self-time, and parallel children contribute max rather than sum).

### 5.7 Brandes betweenness centrality (opt-in)

Shows which components sit on the most shortest paths ("hubs", single points of failure). It is O(VE) for unweighted graphs, so it is used only when V < 20k or in sampled mode (k random sources, scaled).

### 5.8 Union-find (disjoint set union)

`parent: Int32Array`, union by rank + path compression → near-constant amortised α(n). It merges evidence about the same real-world entity from code, config, OpenAPI and traces into one model node.

### 5.9 Jaro-Winkler similarity

For fuzzy matching of names after normalisation (lower-case, strip `-svc`, `Service`, `Client`). The threshold is ≥ 0.92 *and* kinds must be compatible. It is only used to *propose* merges with lowered confidence. Exact host/service.name matches are preferred.

### 5.10 AST traversal

An iterative visitor over `ts.Node` (`node.forEachChild` pushed on a stack). Extractors register interest by `SyntaxKind`, and a dispatch table (array indexed by kind) calls only interested extractors. That gives O(nodes) total, independent of the extractor count. The TypeChecker resolves call targets (`checker.getResolvedSignature`, `getSymbolAtLocation`) and is invoked lazily only on candidate nodes, because it is the expensive part.

---

## 6. Analysis algorithms

### 6.1 Knee detection (Kneedle)

1. Normalise (load, p95) points to [0,1].
2. Difference curve `d_i = y_i − x_i` (for increasing convex curves, transform appropriately).
3. Local maxima of `d` are knee candidates. Confirm a knee when `d` drops below `max − S·mean(Δx)` (sensitivity S = 1).

O(n) with n = stages. Reported as "latency inflection around N VUs / R rps".

### 6.2 Statistical comparison of baseline vs variant

| Step | Method | Why |
|---|---|---|
| Unit of analysis | per-repetition summary (e.g. p95 per run), r ≥ 5 per arm | Requests within a run are not independent (shared state, warm caches) |
| Effect estimate | relative difference of medians. Hodges–Lehmann shift estimator | Robust to outliers |
| Uncertainty | **Bootstrap CI** (BCa, B = 10,000, seeded). Percentile bootstrap fallback | No normality assumption |
| Significance | **Mann–Whitney U** (exact for small n, normal approximation with tie correction otherwise) | Non-parametric. Latency is skewed |
| Effect size | **Cliff's δ** (negligible < 0.147 < small < 0.33 < medium < 0.474 < large) | Interpretable, robust |
| Multiple tests | **Holm–Bonferroni** | Many metrics × variants inflate false positives |
| Power | Minimum detectable effect from A/A variance. Suggested r for a desired effect | Avoid "no change" when really "under-powered" |
| Outliers | Flag runs with MAD z > 3.5 and report them, never silently drop | Transparency |

Verdict = `improved | regressed | no-significant-change | inconclusive`, plus the CI. Never just a p-value.

### 6.3 Change-point detection (CUSUM)

For history and soak series: a two-sided CUSUM on standardised residuals,
`S⁺ = max(0, S⁺ + z − k)`, `S⁻ = max(0, S⁻ − z − k)`, with a signal when either exceeds `h` (k = 0.5, h = 5 by default). It detects sustained shifts (regressions introduced by a commit) better than single-point thresholds. **Robust z-score** `z = 0.6745·(x − median)/MAD` flags single anomalous runs. For offline analysis of long series, PELT/E-Divisive can be added via a plugin.

### 6.4 Theil–Sen regression

The slope is the median of all pairwise slopes. It tolerates ~29 % outliers. Used for soak drift (p95 or memory over time, n ≤ a few thousand windows, downsampled first to keep n² cheap).

### 6.5 Universal Scalability Law fit

`X(N) = λN / (1 + σ(N−1) + κN(N−1))`. Fit λ, σ, κ ≥ 0 by Levenberg–Marquardt (or a grid + Nelder–Mead for simplicity). Report R², σ, κ and the projected peak `N* = √((1−σ)/κ)`, all labelled **estimate**. Requires ≥ 5 stages, and USL is refused if R² < 0.9.

### 6.6 Wilson score interval

For flaky reproduction rates (k failures of n replays): `(p̂ + z²/2n ± z√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)`. Correct for small n and p near 0/1, unlike the normal approximation.

---

## 7. Test-generation algorithms

### 7.1 Boundary-value analysis & equivalence partitioning

From JSON Schema keywords: `minimum/maximum/exclusive*` → {min−1, min, min+1, max−1, max, max+1}. `minLength/maxLength`, `minItems/maxItems` likewise. `enum` → each value + one invalid. `type` → one value of every wrong type. `required` → omit each one. `format` (email, uuid, date-time) → valid + near-miss. `nullable` → null. This produces classes, and one representative per class is chosen with the seeded RNG.

*(The v1 plan's boundary list was corrupted by text encoding. The correct example for an integer 1..100 is: **0, 1, 2, 99, 100, 101**.)*

### 7.2 Property-based testing & shrinking

`fast-check` arbitraries are generated from JSON Schema (`json-schema → arbitrary` mapper). Properties are invariants such as "valid input ⇒ 2xx and response matches schema", "invalid input ⇒ 4xx, never 5xx", and round-trip (`POST` then `GET` returns the same). On failure, integrated shrinking finds a minimal counter-example. Seed and path are recorded for exact replay.

### 7.3 Pairwise combinatorial testing (IPOG)

For p parameters with v values each, exhaustive testing is vᵖ cases. Pairwise covers every value pair with ~v²·log p cases (e.g. 10 params × 5 values: 9.7 M → ~40). IPOG: start with all pairs of the first 2 params, then for each new param do horizontal growth (assign the value that covers the most uncovered pairs to each existing row), followed by vertical growth (add rows for the remaining pairs). Supports constraints (invalid combinations excluded).

### 7.4 Delta debugging (ddmin)

Minimises a failing **sequence** of requests (from stateful/agent runs): split into n chunks, test each chunk and its complement, keep whatever still fails, and increase granularity. It yields a 1-minimal failing sequence. Each test is a full replay against a reset environment. It is capped by a replay budget.

### 7.5 Linearizability checking (concurrency bugs)

Record each concurrent operation's invoke/response times and results. The history is linearizable if some total order that respects real-time precedence produces the same results on a sequential model (e.g. `stock` counter). Wing–Gong search with memoisation (as in Porcupine/Knossos) is used, with histories kept small (≤ ~50 ops per burst) so the exponential worst case stays tractable. Violation ⇒ `reproduced-defect` with the impossible history shown.

For simpler invariants (final stock ≥ 0, single order per idempotency key) a **post-state check** is used, which is cheaper and preferred when sufficient.

### 7.6 Model-based (state machine) testing

The resource lifecycle is an FSM (`states`, `transitions` with pre/post-conditions). `fast-check` `commands()` generates random valid command sequences, runs them against the API and a model in parallel, and checks they agree after each step. Shrinking works on the sequence.

---

## 8. Decision & optimisation algorithms

### 8.1 Multi-armed bandit (UCB1 / Thompson sampling)

The agent chooses which (endpoint, technique) arm to explore next.
UCB1: pick `argmax(mean_reward_a + c·√(2 ln t / n_a))`. Untried arms first.
Thompson: Beta(α=1+successes, β=1+failures) per arm, sample, pick the max.
Reward = 1 if the scenario yields a new finding or new coverage bit, else 0. O(arms) per decision.

### 8.3 Pareto front

Candidate c dominates d if it is ≥ on all metrics and > on at least one (after orienting all metrics "higher is better"). O(c²·m) for c candidates, m metrics, which is fine for c < 100.

---

## 9. Utilities

### 9.1 Hashing

`node:crypto` SHA-256 for content addressing (AST cache keys, report integrity, fingerprints). For hot-path non-cryptographic hashing (scenario dedup), FNV-1a 32-bit or xxhash-wasm.

### 9.2 ULID

128-bit, lexicographically sortable by time (48-bit ms timestamp + 80-bit randomness). Run IDs and finding IDs sort chronologically in file names and DB indexes. Monotonic within the same ms.

### 9.3 Seeded PRNG

`xoshiro128**` (fast, 128-bit state, good statistical quality), seeded via `splitmix32` from the user seed. Each engine/worker/VU gets an **independent stream** derived as `seed ⊕ hash(streamName)`, so results don't depend on scheduling order. `Math.random` is banned by lint in engine code.

### 9.4 Secret detection

Pattern rules (AWS keys, JWTs, `Bearer`, private-key blocks, connection strings, cloud/SaaS API key prefixes) **plus** Shannon entropy `H = −Σ pᵢ log₂ pᵢ` > 4.0 bits/char for strings ≥ 20 chars near key-like names. Pattern sets are compiled into one combined regex (alternation), which gives a single pass per string. Applied to logs, reports, artifacts and dry-run output.

### 9.5 Append-only log + atomic writes

History index lines are appended with `fs.appendFile` (O_APPEND is atomic for small writes on POSIX). Full reports are written to `file.tmp`, then `fsync`, then `rename` (atomic on the same volume on all OSes; Windows rename-over-existing is handled with retry on `EPERM/EBUSY`, which antivirus scanners can cause).

---

## 10. References

- Gil Tene, *How NOT to Measure Latency* (coordinated omission), HdrHistogram documentation.
- Tarjan (1972) *Depth-first search and linear graph algorithms*. Kahn (1962).
- Brandes (2001) *A faster algorithm for betweenness centrality*.
- Satopää et al. (2011) *Finding a "Kneedle" in a Haystack*.
- Gunther, *Guerrilla Capacity Planning* (Universal Scalability Law).
- Efron & Tibshirani, *An Introduction to the Bootstrap*. Mann & Whitney (1947). Cliff (1993). Holm (1979).
- Page (1954) CUSUM. Wilson (1927) score interval.
- Lei et al. (2007) IPOG. Zeller (2002) delta debugging.
- Herlihy & Wing (1990) linearizability. Wing & Gong (1993).
- Auer et al. (2002) UCB1.
- Vitter (1985) reservoir sampling. Welford (1962).
- Blackman & Vigna, xoshiro/xoroshiro generators.
