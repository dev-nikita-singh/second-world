# Stress & Capacity Lab

> Runs a **sequence** of Performance Lab stages and analyses how behaviour changes as load grows.

## 1. Experiment types

| Type | Stage shape | What it reveals |
|---|---|---|
| Ramp | Linear increase of VUs or rate over time | Smooth degradation curve |
| Step | Plateaus at e.g. 10, 25, 50, 100, 200 (each held ≥ 30 s + settle) | Stable per-level stats, the best data for capacity |
| Spike | Baseline → ×N within seconds → baseline | Queue build-up, autoscaling lag, recovery time |
| Soak | Constant moderate load for hours | Leaks, latency drift, connection exhaustion |
| Breakpoint | Increase until a stop condition (error rate, p99, generator saturation) | Highest *tested* load that meets requirements |
| Fixed-arrival | Open model at set rates | True capacity without coordinated omission |

**Load dimension:** stage levels are VUs (closed model) or arrival rates in req/s (open model). Set it with `stress.loadType: "vus" | "rate"`. When omitted it is inferred like the performance model: an explicit `model` wins (`open` → rate; `closed`/`iterations` → VUs), else a `rate` means rate, else VUs. If the `stress` section and the command line set none of `loadType`, `model`, `rate`, `vus`, the `model`/`rate` of the `performance` section are used for this inference, so `performance: { model: "open", rate: 10 }` with `stress: { stages: [4, 12, 48] }` runs 4, 12 and 48 req/s. The stage level always replaces the inherited rate.

Stages run back to back and share connections unless `isolateStages: true`. An optional `settle` period between stages is excluded from metrics.

## 2. Stop conditions (safety + efficiency)

**Exit code of a breakpoint search:** finding the breakpoint means a threshold was breached on purpose, and a `threshold-breach` finding always fails the run (exit 1, whatever `--fail-on` says; see docs/09 §1). The engine status is still `passed` when the search completed. In CI, gate on the reported capacity (`stress.capacity` in history / `report.json`) rather than on the exit code, or use `--fail-on never`.

The breakpoint search stops early when any of these trip: a threshold has been breached for `k` consecutive windows, error rate > `maxErrorRate`, the generator is saturated, the budget is exhausted, or the user cancels. There is no point hammering a dead server.

## 3. Capacity analysis algorithms

1. **Per-stage summary**: achieved throughput X(N), latency percentiles, errors, at load N.
2. **Highest compliant stage**: the largest N where all thresholds pass. This is the reported *tested capacity*, never "max capacity".
3. **Knee detection (Kneedle)**: finds the point where the latency-vs-load curve bends sharply (see [DSA §6.1](../04-data-structures-and-algorithms.md#61-knee-detection-kneedle)).
4. **Universal Scalability Law fit (optional, labelled *estimate*)**: least-squares fit of `X(N) = λN / (1 + σ(N−1) + κN(N−1))`. It returns the contention σ and coherency κ coefficients and the projected peak `N* = sqrt((1−σ)/κ)`. Projections beyond the tested range are always marked `estimate`.
5. **Binary search refinement (breakpoint mode)**: once a failing stage is found, bisect between the last passing and the first failing load (min step configurable) to sharpen the boundary in O(log range) extra stages.
6. **Soak drift detection**: linear regression (Theil–Sen, robust to outliers) of p95 and memory over time. Positive slope with CI excluding 0 gives `observation: latency drift +x ms/h`. Also CUSUM change-point detection for sudden shifts ([DSA §6.3](../04-data-structures-and-algorithms.md#63-change-point-detection-cusum)).
7. **Spike recovery time**: time from spike end until rolling p95 returns within 10 % of the pre-spike baseline for 3 consecutive windows.

## 4. Output

Stage table, throughput/latency curves (data for charts), first-breach stage and the metric that breached, knee point, optional USL estimate with fit quality (R²), recovery time, drift slopes. Generator saturation in any stage invalidates conclusions from that stage onward. This is reported explicitly.

## 5. Usage

```bash
sw stress --target http://127.0.0.1:3000 --steps 10,25,50,100,200 --hold 45s --threshold "p99<800ms" --threshold "error_rate<2%"
sw stress --mode breakpoint --rate-from 50 --rate-to 2000 --step 50
sw stress --mode soak --rate 100 --duration 2h
```

## 6. Honesty rules

- "Capacity" is always **"highest tested load that met requirements in this environment"**, together with an environment fingerprint.
- USL/extrapolated numbers carry `kind: "estimate"` and are rendered in a separate section.
- **Safety rate cap.** Every request passes the world-wide GCRA of `min(safety.maxRps, budget.maxRps)`, which lets `ceil(cap/10)` requests through back to back. A stage is marked `capped` (limitation `STRESS-SAFETY-RATE-CAP`, excluded from knee/USL) only when the GCRA delayed requests **and** the stage's measured rate (mean or a 1 s peak) reached 80 % of the cap. A stage that only sent short bursts above the burst tolerance (closed-loop VUs whose responses arrive together, e.g. long-polls released at once) while running well below the cap is not capped: limitation `STRESS-SAFETY-BURST-SMOOTHED` (informational) names the stages, the delayed requests and their rate.

## 7. When every stage fails (exit codes)

- **Nothing answers** (every connection refused / DNS / connect timeout): limitation `target-unreachable`, exit **5**.
- **Nothing measured** (every request timed out or was still in flight when the stage ended, e.g. a server that never responds and `timeout` ≥ `hold`): limitation `no-measurements`, exit **5**. Lower `timeout` or lengthen `hold` to measure the timeouts as errors.
- **The Safety Guard stopped the only stage(s)** (e.g. DNS rebinding): the stage's `dns-rebind` limitation is carried over, exit **3**.
- **The target answers but every request fails** (5xx, connection reset after connect): this is a measured breach (error rate 100 %), exit **1**. A stage where every request failed is never marked "generator saturated": instant failures make closed-loop VUs spin, which is not a generator limit.
- A stage error with none of these causes stays an engine error (exit 70) and should be reported as a bug.
