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

All injectors implement `FaultInjector { capabilities(); apply(fault, signal); revert(); }`. **`revert()` is guaranteed**: it is registered in a cleanup stack and runs on success, error, SIGINT, SIGTERM and uncaught exception. Each fault also has a **TTL** after which it auto-reverts, even if SECOND WORLD crashes (Toxiproxy toxics and Docker faults are reverted by a detached watchdog, and the proxy stops with the process).

Out-of-process faults (Docker, Toxiproxy) are recorded in a persistent **ledger** (`$SW_FAULT_LEDGER` or `<tmp>/second-world/fault-ledger.json`), which `sw reliability cleanup` replays. Once the watchdog's revert succeeds (or finds the fault already reverted), it removes its own entry. It matches the entry by id and creation time, so a fault re-applied under the same id is kept. A failed revert keeps the entry for `sw reliability cleanup`. Every ledger update holds `<ledger>.lock`, created exclusively (a lock older than 10 s is treated as stale and broken). It then writes a temporary file and renames it over the ledger. Readers never see a half-written file, and concurrent writers never lose each other's entries.

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
| Recovery time (MTTR-like) | First timestamp after revert where rolling p95 and error rate stay within steady-state bounds for 3 windows; slow recovery is reported only if the last 2 windows with traffic are still out of bounds, otherwise limitation `recovery-unconfirmed` (recovery phase too short to confirm; use ≥ 5 s) |
| Retry behaviour | Count requests seen at the proxy per client request (amplification factor). Detect retry storms (amplification > 3) and missing jitter (synchronised spikes, using autocorrelation of arrival times) |
| Circuit breaker | Detect the open state: fast failures (latency ≪ timeout) after N failures. Half-open probes after a cooldown; the client outcome (errors, p50) is judged only on requests answered before the revert (in-flight ones are answered by the restored dependency) |
| Duplicate operations | Invariant checks after the fault (e.g. count orders by idempotency key) |
| Timeout correctness | Client latency ≈ configured timeout ± tolerance while the dependency is black-holed. "No outbound timeout" needs nothing answered during the black-hole **and** at least 3 requests observed waiting longer than `maxOutboundBudget` (default 30 s: the longest plausible timeout × attempts + backoff). With a shorter observable window (client `workload.timeout` or fault duration below the budget) "no timeout" and "a longer timeout chain" look the same, so the result is inconclusive with the limitation `timeout-window-too-short` (numbers + hint: raise `workload.timeout` and the fault duration above the suspected budget, or set `maxOutboundBudget` to the app's real budget), never a defect |

## 4. Scenario catalogue (built in)

`dependency-latency`, `dependency-timeout`, `dependency-5xx`, `dependency-reset` (`when: before-request` default | `after-response`, see below), `db-unavailable`, `cache-unavailable`, `slow-network`, `restart-dependency`, `flapping-dependency` (on/off cycles), `partial-failure` (x % of requests).

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
- Operations that timed out, were reset or got a 5xx may or may not have happened, so they widen the allowed range instead of causing false positives. A violation is an `observation`; it becomes a `reproduced-defect` when hit in every one of 2 or more runs (`--repeat`).
- **Pagination** (opt-in, on every collection or conserved term): `page: { style, ... }`. Without `page` the collection is read with one request.
  - `offset`: `offsetParam` ("offset"), `limitParam` ("limit"), `limit` (100), `start` (0). The offset advances by the items actually returned, so a server that clamps the page size still works.
  - `page`: `pageParam` ("page"), `sizeParam` ("size"), `size` (100), `start` (1).
  - `cursor`: `cursor` = path of the next cursor in the response JSON (e.g. `"meta.next"`), sent back in `param` ("cursor"). Optional `limitParam` + `limit`.
  - `link`: follows the RFC 8288 `Link: <url>; rel="next"` response header. Optional `limitParam` + `limit`.
  - offset/page end on an **empty** page (a short page may just be a size clamp); cursor ends when the cursor is missing, null or ""; link ends when there is no `rel="next"`.
  - Bounds: `maxPages` (default 1000, max 10 000), 100 000 items over all pages, 4 x 32 MiB over all pages. Loop guards: a repeated page URL, a repeated cursor, or a page identical to an earlier one (the server ignores the parameter).
  - Safety: every page URL passes the safety guard (allowed hosts), and a `next` link to another origin (scheme, host or port) is refused, never requested.
  - When a bound, a loop guard or a refusal stops the read, the collection is **partial**. The invariant is then `error` ("not trusted: evaluated on a partial collection (...)"), and the run gets the limitation `invariant-partial-collection`. One exception: a `no-duplicates` violation found in the part that was read stays a violation (those duplicates are real; the counts are lower bounds). It is never reported as "held".
  - The same resource (same key and same `id`) listed twice, e.g. because a page boundary shifted, is not counted as a duplicate.
- **Which faults produce duplicates (built-in proxy)**: `slow-body` (with a client timeout) and `blackhole` (the app's held call is forwarded on revert) lose the response after the work was done. `latency` and the default `reset` act before the request is forwarded, so they never cause duplicates. `dependency-reset` with `when: "after-response"` forwards the request, lets the upstream answer (the work is done), then sends an RST to the caller instead of the response. That is a lost acknowledgement, so a retry duplicates the operation on a non-idempotent server. Use `percent` < 100 so that retries can also succeed. It is built-in proxy only: Toxiproxy's `reset_peer` cannot wait for the response, so other injectors get a limitation. In tcp mode the client is reset when the upstream's first bytes arrive.

```ts
reliability: {
  workload: { routes: [{ name: "orders", method: "POST", path: "/orders", auth: "user", idempotency: {} }] },
  invariants: [
    { type: "no-duplicates", collection: "GET /orders", headersFrom: "orders", key: "idempotencyKey" },
    { type: "count-matches", collection: "GET /orders", headersFrom: "orders", routes: ["orders"],
      page: { style: "cursor", cursor: "meta.next", param: "after", limitParam: "limit", limit: 200 } },
  ],
}
```

## 6. Default safety

No production fault injection by default. Requires `environment != "production"` or `allowProduction: true` **plus** a typed confirmation in interactive mode. In CI it requires an explicit flag.
