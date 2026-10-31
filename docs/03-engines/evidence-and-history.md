# Evidence & Reporting · Experiment History

---

## Part A — Evidence & Reporting Engine

### A.1 Finding model (v2, replaces the minimal v1 interface)

```ts
export const FindingSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),                       // ULID: sortable, unique
  fingerprint: z.string(),              // stable hash for dedup across runs (see A.3)
  engine: EngineIdSchema,
  category: z.enum(["performance", "capacity", "architecture", "bug", "reliability", "security", "correctness"]),
  title: z.string().max(200),
  description: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  classification: z.enum(["hypothesis", "suspected-risk", "observation", "threshold-breach", "reproduced-defect", "verified-fix"]),
  status: z.enum(["open", "acknowledged", "fixed", "wont-fix", "false-positive"]).default("open"),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema).min(1),
  locations: z.array(SourceLocationSchema).default([]),     // file, line, col, endLine, snippetHash
  affected: z.array(z.string()).default([]),                // model node ids, endpoints
  reproduction: ReproductionSchema.optional(),              // steps, command, seed, artifact refs
  impact: z.string().optional(),
  recommendation: z.string().optional(),
  related: z.array(z.object({ id: z.string(), relation: z.enum(["causes", "caused-by", "duplicates", "verifies", "related"]) })).default([]),
  occurrences: z.number().int().default(1),
  firstSeen: z.string(), lastSeen: z.string(),
  tags: z.array(z.string()).default([]),
});

export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("measurement"), metric: z.string(), value: z.number(), unit: z.string(), window: TimeRangeSchema, runId: z.string() }),
  z.object({ kind: z.literal("threshold"), expression: z.string(), actual: z.number(), passed: z.boolean() }),
  z.object({ kind: z.literal("code"), location: SourceLocationSchema, ruleId: z.string() }),
  z.object({ kind: z.literal("http-exchange"), artifact: z.string(), requestHash: z.string(), status: z.number() }),
  z.object({ kind: z.literal("trace"), traceId: z.string(), spanIds: z.array(z.string()) }),
  z.object({ kind: z.literal("comparison"), metric: z.string(), change: z.number(), ci95: z.tuple([z.number(), z.number()]), pValue: z.number() }),
]);
```

### A.2 Severity scoring

Severity is derived deterministically, not chosen ad hoc: `severity = f(impact, likelihood)`. Impact comes from category and affected surface (auth/data loss → high). Likelihood comes from classification (reproduced > breach > suspected > hypothesis). Rules can override this with a justification.

### A.3 Fingerprinting & deduplication

`fingerprint = sha256(engine | ruleId/assertion | normalised location or endpoint | key params)`. Normalisation drops line numbers that shift (it uses the enclosing symbol name + snippet hash) and dynamic IDs in URLs (`/orders/123` → `/orders/{id}`, via the contract or a numeric/UUID regex). Same fingerprint across runs = same finding. History uses this to track open → fixed → regressed.

### A.4 Report structure

1. Header: run ID, config hash, tool version, environment fingerprint, duration, status.
2. **Verdict** & exit status explanation.
3. Executive summary (deterministic template; the same summary `sw analyze` prints across several reports).
4. Findings grouped by classification (strongest first), then severity.
5. Per-engine sections (metrics tables, charts data).
6. Comparisons vs baseline (if any).
7. **Limitations / what we could not determine.**
8. Reproduction appendix and artifacts index.
9. Methods appendix (percentile method, statistics used, CO correction).

### A.5 Output formats

| Format | Use | Phase |
|---|---|---|
| TTY (colour, tables, live progress) | Humans in terminal; auto plain when not a TTY or `NO_COLOR` | 1 |
| JSON (canonical, schema-versioned) | Machines, history, re-analysis | 1 |
| Markdown | PR comments, GitHub job summary (`$GITHUB_STEP_SUMMARY`) | 2 |
| **JUnit XML** | Any CI test-report UI (thresholds as test cases) | 2 |
| **SARIF 2.1.0** | GitHub code scanning / IDEs for architecture & security findings | 3 |
| HTML (single self-contained file, charts via uPlot, graph via Cytoscape.js) | Sharing | 3 |
| OpenTelemetry metrics export / Prometheus text | Dashboards | 6 |

### A.6 Exit codes

| Code | Meaning |
|---|---|
| 0 | Completed, no failing thresholds/defects at or above `failOn` severity |
| 1 | Completed, failures found (thresholds breached or defects ≥ `failOn`) |
| 2 | Configuration invalid |
| 3 | Blocked by safety guard |
| 4 | Required capability missing |
| 5 | Target unreachable / pre-flight failed |
| 130 | Cancelled by user (SIGINT) |
| 70 | Internal error (bug in SECOND WORLD, please report) |

`--fail-on critical|high|medium|low|never` controls code 1.

---

## Part B — Experiment History

### B.1 Storage backends

| Backend | When | Details |
|---|---|---|
| **JSONL files** (default) | Always available | `.second-world/history/runs.jsonl` (index, one line per run) + `runs/<ulid>.json.gz` (full report). Append-only, crash-safe (write temp, then `rename`), file lock via `O_EXCL` lock file with stale-lock detection |
| SQLite via `node:sqlite` (not implemented) | — | `history.backend: "sqlite"` is accepted but falls back to JSONL with a warning. Deferred: `node:sqlite` still prints an ExperimentalWarning on Node 22/24, and JSONL measured 81 ms `list` / 170 ms `trend` at 10,000 runs (default retention is 200). Revisit when `node:sqlite` is stable |
| Remote (later) | Teams | HTTP API / S3-compatible object store adapter |

### B.2 Capabilities

- `sw history list|show|diff <a> <b>|baseline set <run>|trend --metric p95 --endpoint /orders`
- **Baselines**: named (`main`, `release-1.4`), with optional auto-update on main branch in CI.
- **Regression detection** on each new run vs baseline: statistical comparison (same core as What-If) on metrics, plus finding diff by fingerprint (new / fixed / regressed / unchanged).
- **Trend anomaly detection**: rolling median + MAD robust z-score (|z| > 3.5) and CUSUM change-points over the metric series ([DSA §6.3](../04-data-structures-and-algorithms.md#63-change-point-detection-cusum)).
- **Architecture snapshots**: model graph diff between runs.
- **Retention**: keep last N runs + all baselines + all runs with findings. Compact older runs to summaries only.
- Git metadata captured: commit SHA, branch, dirty flag, so results are linked to code.

### B.3 Data integrity

Reports are immutable after write. Each has a `sha256` recorded in the index. `sw history verify` detects tampering or corruption. Schema migrations are versioned (`schemaVersion`). Old reports are upgraded on read through migration functions and never rewritten in place.
