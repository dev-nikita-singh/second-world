# Reliability Lab

> Controlled fault injection to measure how the app behaves when its dependencies degrade, and how it recovers.

## 1. Fault injectors (adapters)

| Injector | Faults | Requirements | Portability |
|---|---|---|---|
| **Built-in TCP/HTTP proxy** (default) | latency (fixed/jitter), bandwidth limit, connection reset, black-hole (timeout), HTTP status injection, slow body | App's dependency URL points to the proxy port | All OS, pure Node |
| **Toxiproxy** | latency, bandwidth, slow_close, timeout, slicer, limit_data, reset_peer | Toxiproxy server (binary or Docker) | All OS |
| **Docker** | pause/stop/restart container, network disconnect | Docker/Podman socket | Linux/macOS/Windows with Docker Desktop |
| **App hooks** | Feature flags or a test endpoint inside the app that simulates failure | User implements hook | All |
| Kubernetes (later) | pod kill, network policy | kubeconfig, namespace allow-list | — |

All injectors implement `FaultInjector { capabilities(); apply(fault, signal); revert(); }`. **`revert()` is guaranteed**: it is registered in a cleanup stack and runs on success, error, SIGINT, SIGTERM and uncaught exception. Each fault also has a **TTL** after which it auto-reverts, even if SECOND WORLD crashes (Toxiproxy toxics are removed by a watchdog, and the proxy stops with the process).

## 2. Experiment structure (hypothesis-driven, like chaos engineering)

1. **Steady state**: define it with metrics and thresholds (e.g. p95 < 300 ms, errors < 1 %). Measure it with Performance Lab at low load.
2. **Hypothesis**: "When the payment API adds 2 s latency, checkout errors stay < 5 % and other routes are unaffected."
3. **Inject**: apply the fault for a duration, optionally ramped.
4. **Observe**: keep the workload running and record time series.
5. **Revert & recover**: measure recovery time.
6. **Verdict**: hypothesis held / violated, with evidence.

**Blast radius controls**: target allow-list, fault scope limited to named dependencies, `maxDuration`, abort conditions (error rate > X → immediate revert), `environment` must be `isolated`/`staging`, and explicit `--approve-disruptive` (or a config approval token).

## 3. Measurements & algorithms

| Measurement | Method |
|---|---|
| Failure/timeout rate during fault | Windowed counters, 1 s resolution |
| Error propagation | Compare per-route error rates. Routes that are unrelated (per the System Model graph) but degraded are flagged as **isolation failure** |
| Recovery time (MTTR-like) | First timestamp after revert where rolling p95 and error rate stay within steady-state bounds for 3 windows |
| Retry behaviour | Count requests seen at the proxy per client request (amplification factor). Detect retry storms (amplification > 3) and missing jitter (synchronised spikes, using autocorrelation of arrival times) |
| Circuit breaker | Detect the open state: fast failures (latency ≪ timeout) after N failures. Half-open probes after a cooldown |
| Duplicate operations | Invariant checks after the fault (e.g. count orders by idempotency key) |
| Timeout correctness | Client latency ≈ configured timeout ± tolerance while the dependency is black-holed |

## 4. Scenario catalogue (built in)

`dependency-latency`, `dependency-timeout`, `dependency-5xx`, `dependency-reset`, `db-unavailable`, `cache-unavailable`, `slow-network`, `restart-dependency`, `flapping-dependency` (on/off cycles), `partial-failure` (x % of requests).

## 5. Usage

```bash
sw reliability run dependency-latency --dependency payments --latency 2s --duration 60s \
   --steady "p95<300ms" --approve-disruptive
```

### Duplicate-operation invariants (config)

Faults such as dropped responses and timeouts make clients retry, and a server that ignores idempotency then applies the same mutation twice. After the recovery phase the lab reads the app's own collections and checks invariants.

- A workload route with `idempotency: { header: "Idempotency-Key" (or false), retries: 2, backoff: "100ms" (doubling), retryOn: ["transport", "timeout", "5xx"] }` sends one unique key per logical operation. Every retry reuses that key, and `$SW_OP_KEY` in the path, body or headers is replaced with it.
- `invariants` (max 20), each reading a `collection` (e.g. `"GET /orders"`; `headersFrom: "<route>"` reuses that route's auth):
  - `no-duplicates`: at most one resource per key sent in this run (`key`: path of the key in each item; `id` defaults to `"id"`).
  - `count-matches`: resources created must match the operations that succeeded (`perOperation`, default 1). Too many gives `reliability/duplicate-operation`; too few gives `reliability/lost-write`.
  - `conserved`: a weighted sum of `terms` (collection + `field` + `weight`) stays constant, or changes by `perOperation` per operation, within `tolerance`. A violation gives `reliability/invariant-violated`.
- Operations that timed out, were reset or got a 5xx may or may not have happened, so they widen the allowed range instead of causing false positives. A violation is an `observation`; it becomes a `reproduced-defect` when hit in every one of 2 or more runs (`--repeat`). Collections are read with a single request (no pagination).

```ts
reliability: {
  workload: { routes: [{ name: "orders", method: "POST", path: "/orders", auth: "user", idempotency: {} }] },
  invariants: [
    { type: "no-duplicates", collection: "GET /orders", headersFrom: "orders", key: "idempotencyKey" },
    { type: "count-matches", collection: "GET /orders", headersFrom: "orders", routes: ["orders"] },
  ],
}
```

## 6. Default safety

No production fault injection by default. Requires `environment != "production"` or `allowProduction: true` **plus** a typed confirmation in interactive mode. In CI it requires an explicit flag.
