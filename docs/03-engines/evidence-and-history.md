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
| **SQLite** via `node:sqlite` | `history.backend: "sqlite"`; Node ≥ 22.13 (the supported 22.19+ and 24 have it) | `.second-world/history/history.db` (WAL). Same behaviour as JSONL (one contract test suite runs against both). Loaded lazily; falls back to JSONL with a warning when `node:sqlite` is unavailable. See §B.1.1 |
| Remote (later) | Teams | HTTP API / S3-compatible object store adapter |
| Plugin store | A plugin registers a backend name | `registerHistoryBackend(name, factory)` (docs/10); selected by that name. The plugin store implements the same `HistoryStore` interface |

### B.1.1 SQLite backend

Enable it in the config: `history: { backend: "sqlite" }`. Implementation: `src/engines/history/sqlite-store.ts`.

- **Same contract.** `append / get / list / query / baselines / diff / trend / verify / prune` behave exactly like
  the JSONL store: same ids (ULID, or the engine's run id), ordering (newest first by `createdAt`, then id), id
  prefixes (≥ 6 chars), `baseline:<name>`, filters, errors, retention rules, and the same gzip report bytes and
  `sha256`. `tests/unit/history/contract.ts` is one suite run against both backends, plus a parity test that
  runs the same script on both and compares every result. Plugin stores can run that suite too.
- **Layout.** One file `history.db` (plus `history.db-wal` / `-shm` while in use). Tables: `runs` (index
  entry as JSON + indexed columns for the filters), `reports` (the gzip report BLOB, kept apart so scans stay
  on small rows), `run_metrics` (one row per numeric metric, keyed by metric name and time, so `trend` is an
  index range scan), `metric_names`, `baselines`, `meta`, `jsonl_imported`, `schema_migrations`.
  `list`/`query` filters, `limit` and id prefixes run in SQL.
- **Loading.** `node:sqlite` is imported only when the sqlite backend is first used (never by
  `sw --version` / `--help`; startup-budget test). Node 22/24 print `ExperimentalWarning: SQLite is an
  experimental feature…` on first load; SECOND WORLD drops **only that warning** (matched on the warning type
  and message, only while the module loads). Every other warning is printed as usual.
- **Fallback.** If `node:sqlite` cannot be loaded (older runtime, Bun/Deno without it,
  `node --no-experimental-sqlite`), the store warns
  `history.backend "sqlite": node:sqlite is not available … using the JSONL history in <dir> instead` and
  uses JSONL in the same directory. Runs stored in `history.db` are not visible until `node:sqlite` is back.
- **Concurrency and crashes.** WAL journal, `busy_timeout` 10 s (`lock.timeoutMs` in the API), and every
  write is one `BEGIN IMMEDIATE` transaction (an append writes the run, its metrics and its report together).
  Tested with two processes appending at once (nothing lost) and a writer killed with SIGKILL /
  TerminateProcess mid-append (the database opens, `verify` is clean, every acknowledged run is there).
  `synchronous = NORMAL`: a process crash loses nothing that was committed; a power cut can lose the last
  transactions (not corrupt the file). A store keeps one connection while it is busy and closes it after
  50 ms idle, so no file handle stays open between commands.
- **Schema versioning.** `PRAGMA user_version` plus a `schema_migrations` table (version, name, applied_at).
  Migrations run once in a write transaction (safe when two processes open a new database together). A
  database from a newer SECOND WORLD is refused (`SW_HISTORY_BACKEND`: "upgrade the tool"), never modified.
  Stored reports keep their own `schemaVersion` and are migrated on read, as in JSONL (§B.3).
- **Switching from JSONL.** When `history.db` is opened in a directory that has a `runs.jsonl`, its runs (report
  bytes copied verbatim, so checksums stay valid), compacted summaries and baselines are imported in one
  transaction, and `sw history list/show/trend` keep showing the old runs. The import is idempotent: it is
  recorded per run id and runs again only when `runs.jsonl` changed (new JSONL runs are added; a run once
  imported and later pruned in SQLite is not brought back). Torn JSONL lines are skipped with a warning. The
  JSONL files are never modified, so switching back is always possible.
- **Going back to JSONL.** Set `history.backend: "jsonl"`. The JSONL history then shows the runs it had before
  the switch; runs recorded while on SQLite stay in `history.db` (and show again if you switch back). To copy
  them into the JSONL files, call `exportSqliteHistoryToJsonl({ cwd })` from
  `src/engines/history/sqlite-store.ts` (idempotent; report bytes verbatim). There is no CLI command for it in 0.x.
- **verify.** `sw history verify` on SQLite runs `PRAGMA quick_check` (problem `db-integrity`) and then the same
  per-run checks as JSONL: unreadable index record (`corrupt-index-line`), `missing-report`,
  `checksum-mismatch`, `unreadable-report`, `id-mismatch`, `baseline-missing-run`. The audit-log hash-chain check
  is backend-independent and unchanged. `--json` adds `"backend": "sqlite"`.
- **Limitations.** `node:sqlite` is still marked experimental in Node 22/24 (its API could change; the store uses
  only `DatabaseSync`, `prepare`, `exec`, `close`). The API is synchronous: a write waiting for another
  process's lock blocks the event loop for up to `busy_timeout`. Retention compaction frees pages with
  `PRAGMA incremental_vacuum`; the file does not shrink below its high-water mark otherwise.

**Measured at 10,000 runs** (2026-11-04, Windows 11 laptop, Node 24.14; each run is one Performance Lab
result with 3 endpoints, ≈ 30 metrics; best of 5 inside one process, so Node start-up (~75 ms) and module load
are not included; `tests/integration/history/sqlite-bench.test.ts`, `SW_BENCH=1`):

| Operation | JSONL (ms) | SQLite (ms) |
|---|---|---|
| `list` (CLI default, 20 newest) | 171 | 0.8 |
| `list` with a filter (`label`, limit 20) | 187 | 0.8 |
| `list` all 10,000 entries | 157 | 236 |
| `trend p95` (all runs) | 316 | 150 |
| `trend p95 --limit 50` | 183 | 1.3 |
| `trend --endpoint /users` | 298 | 148 |
| `show <id>` / `show <prefix>` | 149 / 145 | 1.2 / 1.2 |
| `verify` (every report checksummed) | 29,438 | 4,920 |
| cold: open store + `list` 20 | 157 | 10.6 |
| `append` (mean of 50) | 31.8 | 22.3 |

JSONL re-reads the whole `runs.jsonl` (12 MB at 10k runs) on every call, so each operation costs ~150 ms
there; SQLite answers from indexes. Listing *all* entries is slower in SQLite (row fetch plus a JSON parse per entry
). Storage: `history.db` 66.7 MB vs `runs.jsonl` 12 MB plus 10,000 `.json.gz` files. The one-time import of
the 10,000-run JSONL history took 35 s on Windows (mostly opening 10,000 report files); it runs once. At 1,000 runs (measured the same way) JSONL took ~20 ms per `list`/`show` and SQLite ~1 ms; at the
default retention (`history.retain.runs: 200`) either backend is fast enough.

### B.2 Capabilities

- `sw history list|show|diff <a> <b>|baseline set <run>|trend --metric p95 --endpoint /orders`
- **Baselines**: named (`main`, `release-1.4`), with optional auto-update on main branch in CI.
- **Regression detection** on each new run vs baseline: statistical comparison (same core as What-If) on metrics, plus finding diff by fingerprint (new / fixed / regressed / unchanged).
- **Trend anomaly detection**: rolling median + MAD robust z-score (|z| > 3.5) and CUSUM change-points over the metric series ([DSA §6.3](../04-data-structures-and-algorithms.md#63-change-point-detection-cusum)).
- **Architecture snapshots**: model graph diff between runs.
- **Retention**: keep last N runs + all baselines + all runs with findings. Compact older runs to summaries only.
- Git metadata captured: commit SHA, branch, dirty flag, so results are linked to code.

### B.3 Data integrity

Reports are immutable after write. Each has a `sha256` recorded in the index. `sw history verify` detects tampering or corruption. Schema migrations are versioned (`schemaVersion`). Old reports are upgraded on read through migration functions and never rewritten in place. The SQLite backend stores the same gzip bytes and `sha256` in its `runs` table and checks them the same way, plus `PRAGMA quick_check` (§B.1.1).
