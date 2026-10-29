# Performance Lab

> Measures how a running application behaves under a **controlled, reproducible** workload. Foundation of the MVP.

## 1. Questions it answers

- What throughput does the app sustain during this test, and at what latency distribution?
- Which endpoints/scenarios are slow, and which fail?
- Are timeouts or connection errors growing over time?
- Are the configured thresholds (SLOs) met?
- **Is the load generator itself the bottleneck?** (always checked, see §6)

## 2. Workload models

The v1 plan used "virtual users" for everything. v2 makes the model explicit, because the choice changes what the numbers mean.

| Model | Config | Semantics | Use for |
|---|---|---|---|
| **Closed** (VU-based) | `vus`, `duration`, `thinkTime` | N users loop: request → wait response → think → repeat. Throughput depends on latency. | User-journey realism |
| **Open** (arrival-rate) | `rate` (req/s), `duration`, `arrival: "constant" \| "poisson"` | Requests start on a schedule *regardless* of responses. | SLO validation, capacity, real-world traffic |
| **Iterations** | `iterations`, `vus` | Fixed amount of work, then stop. | Smoke tests, CI |

**Coordinated omission (CO) correction** is always on. In the open model, latency is measured from the *intended* start time, not the actual send time. If the generator falls behind, the queueing delay is counted, so a stalled server cannot hide its stalls. In the closed model, the expected-interval correction is applied the way HdrHistogram's `recordValueWithExpectedInterval` does. Both raw and corrected values are reported. See [DSA §3](../04-data-structures-and-algorithms.md#3-scheduling-coordinated-omission).

## 3. Input configuration

| Field | Type | Notes |
|---|---|---|
| `target` | URL | Base URL. Must pass the Safety Guard. |
| `allowHosts` | string[] | Extra hosts (redirects, CDN). Default: target host only. |
| `scenarios[]` | Scenario | Named sequences of steps with weights. |
| `scenarios[].steps[]` | Request | `method`, `path`, `headers`, `query`, `body` / `bodyTemplate`, `expect`, `extract`. |
| `extract` | `{ var: jsonPath \| header \| regex }` | Captures values (e.g. token, id) for later steps → dependent request chains. |
| `data` | CSV/JSON/JSONL file | Feeder for parametrisation: `sequential`, `random`, `unique`. |
| `auth` | `bearer` / `basic` / `oauth2-client-credentials` / `cookie` / custom hook | Tokens refreshed out-of-band (not counted in metrics). |
| `vus` / `rate` / `iterations` | number | Workload model selector. |
| `duration`, `rampUp`, `rampDown`, `gracefulStop` | duration string | `"30s"`, `"5m"`, `"1h30m"` parsed by the units parser. |
| `timeout` | duration | Per-request total timeout. Separate `connectTimeout`. |
| `thinkTime` | duration or `{min,max}` or `{dist:"exp",mean}` | Seeded random. |
| `thresholds` | expressions | `"p(95) < 300ms"`, `"error_rate < 1%"`, `"rps > 200"`, per endpoint or global, `abortOnFail`. |
| `budget` | `{ maxRequests, maxRps, maxDuration, maxBytes }` | Hard safety ceilings (Safety Guard enforced). |
| `http` | `{ version: 1.1\|2, keepAlive, connections, pipelining, tls: {ca, insecure} }` | Transport tuning. |
| `warmup` | duration | Excluded from metrics, reported separately. |
| `seed` | number | Reproducible randomness (data selection, think time, Poisson). |

## 4. Metrics

All latency values are recorded in **microseconds** in HDR histograms (1 µs to 1 h, 3 significant digits), per endpoint and global.

| Group | Metrics |
|---|---|
| Latency | min, mean, stdev, p50, p75, p90, p95, p99, p99.9, max. Both CO-corrected and raw |
| Timing breakdown | DNS, TCP connect, TLS handshake, time-to-first-byte, content transfer (via undici diagnostics channel) |
| Throughput | completed rps, successful rps, failed rps, bytes in/out per s, achieved vs target rate |
| Errors | status-code histogram, timeouts, `ECONNREFUSED`/`ECONNRESET`/`EPIPE`/DNS, assertion failures, schema mismatches. Top-N error messages (reservoir sampled) |
| Time series | 1-second windows of all above, for charts and soak analysis |
| Generator health | event-loop delay p99, CPU % of generator, scheduling lag, dropped iterations, open sockets |
| Server resources (optional) | CPU, memory, event-loop delay, GC, DB pool, query timings: via OTLP telemetry, `/metrics` Prometheus scrape, or a local PID sampler |

### Formulas (documented in every report)

- Latency `= t_end − t_intended_start` (corrected) and `t_end − t_actual_start` (raw), using `performance.now()` (monotonic).
- Throughput `= completed / measured_window`. The window excludes warm-up and graceful-stop drain.
- Error rate `= failed / (completed + failed + timed_out)`. "Failed" follows the `expect` rules, so a 404 can be valid.
- Percentiles: **nearest-rank on HDR buckets**, value precision ±0.1 % (3 significant digits).

## 5. Algorithms used

| Need | Algorithm / structure | Ref |
|---|---|---|
| Bounded concurrency | Counting semaphore + ring-buffer wait queue | [DSA §2.1](../04-data-structures-and-algorithms.md#21-counting-semaphore-bounded-concurrency) |
| Arrival schedule | Deterministic or Poisson (inverse-CDF exponential) timestamps, drift-free timer | [DSA §3](../04-data-structures-and-algorithms.md#3-scheduling-coordinated-omission) |
| Rate ceiling | Token bucket / GCRA | [DSA §3.4](../04-data-structures-and-algorithms.md#34-rate-limiting-token-bucket--gcra) |
| Timeouts | `AbortSignal.timeout` + min-heap timer wheel for scheduled starts | [DSA §2.3](../04-data-structures-and-algorithms.md#23-binary-min-heap-priority-queue) |
| Percentiles | HDR histogram, mergeable across workers | [DSA §4.1](../04-data-structures-and-algorithms.md#41-hdr-histogram) |
| Mean/stdev | Welford online | [DSA §4.2](../04-data-structures-and-algorithms.md#42-welfords-online-mean--variance) |
| Live view | Ring buffer of 1 s windows + EWMA | [DSA §4.4](../04-data-structures-and-algorithms.md#44-sliding-windows--ewma) |
| Error samples | Reservoir sampling (k = 50) | [DSA §4.5](../04-data-structures-and-algorithms.md#45-reservoir-sampling) |
| Sanity check | Little's Law `L = λW` | [DSA §4.6](../04-data-structures-and-algorithms.md#46-littles-law-sanity-check) |

## 6. Generator self-check

The report says `generator-saturated` (and downgrades confidence) when any of these hold:

- Event-loop delay p99 of the generator > 50 ms, or generator CPU > 85 % of its quota.
- Scheduling lag p99 > 10 % of the inter-arrival interval (open model).
- Achieved rate < 95 % of target rate while server latency is flat.
- Little's Law mismatch > 20 % between measured concurrency and `rate × mean latency`.

Remedy suggestions are generated: enable `workers: "auto"`, raise `connections`, run the generator on a separate machine.

## 7. Scaling the generator

`workers: number | "auto"` shards the load across `worker_threads` (auto = `min(os.availableParallelism() − 1, 8)`, at least 1; `sw perf --workers <n|auto>`). Each worker runs the same scheduler and executor with its own undici pool, HDR histogram and seed (derived from the run seed and worker index). Open model: each worker takes every N-th arrival of the global schedule (rate/N, interleaved). Closed model and iterations: VUs and iterations are split as evenly as possible. Workers never resolve DNS: every lookup, re-check and redirect check goes through the main thread's Safety Guard. The safety rate cap becomes cap/N per worker (limitation `workers-rate-cap-split` when the split is uneven). Coordinated-omission correction and the self-check run per worker. The main thread merges the encoded histograms exactly (bucket-wise add, never averaged percentiles) at the end of the run. While running, the live `perf.tick` p95/p99 are exact too: each worker sends the encoded histogram of its newest closed 1 s window (windows are aligned on the shared start), and the main thread HDR-adds the newest window every running worker has closed into one reused accumulator, at most once per tick, so the tick reports the percentiles of the union, as a single-threaded run would. Full live snapshots are merged only when an aborting threshold needs them. The built package ships the worker as `dist/perf-worker.mjs`; when it is missing, the run falls back to one thread with limitation `workers-unavailable`.

## 8. Independent usage

```ts
import { createWorld } from "second-world";
const world = createWorld();
const result = await world.performance.run({
  target: "http://127.0.0.1:3000",
  rate: 200, duration: "60s", rampUp: "10s",
  scenarios: [{ name: "browse", steps: [{ method: "GET", path: "/api/products", expect: { status: 200 } }] }],
  thresholds: { "http.p95": "< 300ms", "http.error_rate": "< 1%" },
});
```

```bash
sw perf --target http://127.0.0.1:3000 --rate 200 --duration 60s --threshold "p95<300ms"
```

## 9. Output

`PerformanceData` = global and per-endpoint summaries, encoded HDR histograms (base64, mergeable later), 1 s time series, error breakdown, generator health, threshold results, environment fingerprint (OS, CPU, Node version, target resolved IP). Threshold failures become `threshold-breach` findings. Generator saturation becomes a `Limitation`.

## 10. Known limitations

- Measures client-observed latency including the network path. It does not isolate server time unless telemetry is attached.
- HTTP/1.1 and HTTP/2 only. HTTP/3, gRPC and WebSocket are later adapters (see roadmap).
- Browser-level metrics (LCP etc.) need the Playwright adapter (later phase).
