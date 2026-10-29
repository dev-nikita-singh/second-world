# System Model (Digital Twin)

> A progressively enriched, **evidence-annotated** graph of the system: structure + behaviour.

## 1. Evidence sources and trust

| Source | Example | Default confidence |
|---|---|---|
| Runtime trace (OTel span) | `orders-api → postgres SELECT` observed 12,034× | 0.95 |
| Controlled experiment | Latency injected into Redis raised `/cart` p95 | 0.9 |
| OpenAPI / config / deployment (docker-compose, k8s manifests, `.env.example`) | `PAYMENT_URL=http://payments:8080` | 0.8 |
| Static analysis (resolved symbol) | `OrderService.create → PaymentClient.charge` | 0.75 |
| Static heuristic (naming) | `*Repository` → datastore | 0.5 |

Every node and edge keeps the **list** of its evidence, not just a score. Confidence combines independent sources with noisy-OR, `1 − Π(1 − cᵢ)`. Evidence from the same source family (e.g. static resolved symbol and static naming heuristic) is not independent, so each family contributes only its best value. All sources are deterministic: the model has no AI source.

## 2. Model schema

```ts
interface ModelNode { id: string; kind: "service"|"route"|"handler"|"datastore"|"cache"|"queue"|"external"|"module";
  names: string[]; evidence: Evidence[]; confidence: number;
  observed?: { rps?: number; p95Ms?: number; errorRate?: number; window: TimeRange }; failureModes?: FailureMode[] }
interface ModelEdge { from: string; to: string; kind: "calls"|"reads"|"writes"|"publishes"|"consumes"|"depends";
  evidence: Evidence[]; confidence: number; observed?: { callsPerRequest?: number; p95Ms?: number } }
```

## 3. Algorithms

- **Entity resolution** (merging "payments", `PAYMENT_URL` host `payments:8080`, the `PaymentClient` class, and the OTel `service.name=payments-svc`): **union-find** with merge rules (same host:port, same service.name, normalised-name similarity via Jaro-Winkler ≥ 0.92 + same kind). [DSA §5.8](../04-data-structures-and-algorithms.md#58-union-find-disjoint-set-union).
- **Trace → graph**: build a span tree per trace (parent map), aggregate edges by `(service, peer)`, and compute **critical path** per trace (longest path in span DAG, accounting for parallel children) to see which dependency dominates latency.
- **Diffing snapshots**: models are versioned. A diff gives added/removed nodes/edges and changed observed metrics (used by History).
- **Impact queries**: reverse reachability, same as in the Architecture Inspector.

## 4. Honesty

Each view shows a coverage banner: *"Built from: static analysis ✓, OpenAPI ✓, runtime traces ✗. Production topology unknown."* A source-only model is never presented as runtime truth.

## 5. Export

JSON (canonical), Graphviz DOT, Mermaid, and an interactive HTML view (Cytoscape.js, loaded in the report only).
