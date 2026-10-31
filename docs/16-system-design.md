# 16 — System design (as built)

This page describes how SECOND WORLD is **actually built**, as of wave 7 (2026-11-01), not how it
was planned. Every section points to the source files. Where the code does not follow a principle,
the section says so under **Known gaps**. The enforcement tests in `tests/unit/design/` (§14) keep
the important parts of this page true.

Related: [02 – Architecture](02-architecture.md) (intended design), [05 – Optimization](05-optimization.md),
[08 – Configuration](08-configuration.md), [09 – CLI & API](09-cli-and-api.md),
[11 – Safety, security & privacy](11-safety-security-privacy.md).

---

## 1. Layers and the dependency rule

```text
src/cli/        commander program + commands          → may import core, shared; engines only lazily
src/index.ts    public API (createWorld, schemas, …)  → re-exports core + engines/reporting
src/core/       config, safety, events, evidence, log, clock, rng, registry, world (composition root)
src/engines/<x> one folder per engine                  → core, shared, adapters
src/adapters/   http (undici), faults, telemetry       → core, shared (never engines, never cli)
src/shared/     ds, stats, graph, util                 → nothing else in src/ (leaf)
```

Rules, as enforced by `tests/unit/design/imports.test.ts` (TypeScript-AST import graph in
`tests/unit/design/import-graph.ts`):

| Rule | Status |
|---|---|
| R1 `core` never imports `cli` or `adapters`; it reaches `engines` only through `import()` (or type-only imports) in the **composition root**: `src/core/registry.ts` (engine loaders) and `src/core/world.ts` (history, reporting) | holds |
| R2 `shared` is a leaf | holds |
| R3 `adapters` never import `engines` or `cli` | holds |
| R4 `engines` never import `cli` or `src/index.ts` | holds |
| R5 `cli` reaches an engine only through `engines/<x>/index.ts`, and only by `import()` or `import type` | holds |
| R6 an engine does not import another engine (docs/02 §2) | **18 known exceptions, frozen** (see Known gaps) |
| R7 no runtime (value-import) cycles | holds; one type-only cycle (`engines/performance/engine.ts` ↔ `shard.ts`) is frozen |

Lazy loading is what keeps start-up cheap: `src/cli/main.ts` statically imports **no** module from
`src/` (every command is an `import()` in its action), so `sw --version` / `sw --help` never load an
engine, `typescript`, `undici` or `zod`. `tests/unit/design/startup-budget.test.ts` checks this
statically and measures it (§14).

**Known gaps**

- Cross-engine imports (R6). The frozen list is `KNOWN_CROSS_ENGINE` in
  `tests/unit/design/imports.test.ts`: `agent → bugs` (reuses generators, classifier, session),
  `experiments → bugs | performance | stress`, `history → performance | stress` (types only),
  `model → architecture | bugs`, `reliability → performance`, `reporting → every engine` (mostly
  result types; `model/export.ts` as a value), `stress → performance`. These are deliberate reuse,
  not accidents, but they mean engines cannot be split into packages by "moving folders" (docs/02 §1)
  without first extracting shared modules. A new pair fails CI; removing one fails the stale check,
  so the list only shrinks.
- `createWorld()` loads the reporting engine eagerly (`src/core/world.ts`, `await import("../engines/reporting/index.js")`),
  so every World pays for reporting even if it never writes a report.
- docs/02 §3 lists `src/core/cancel.ts`, `src/adapters/loadgen/` and `.dependency-cruiser.cjs`; none
  exist. Cancellation lives in `world.ts` (§9); layering is enforced by the tests above instead of
  dependency-cruiser.

## 2. Data flow of one `sw perf` run

```text
sw perf URL [flags]
 └ src/cli/main.ts                     parse argv (commander), import("./commands/perf.js")
   └ src/cli/commands/perf.ts          perfCommand()
     ├ src/cli/run-common.ts           worldFromGlobals() → createWorld()
     │  └ src/core/world.ts            loadConfig() (§11) → Safety Guard → events, evidence, logger, rng, clock
     ├ run-common.installSignals()     report dir writable? (exit 2 before any load) + Ctrl+C handler (§9)
     ├ world.safety.preflight(target)  classify host, pin DNS, approvals         → SafetyError exit 3
     ├ --dry-run: parse input, print, exit 0 (nothing sent)
     ├ world.performance.run(flags)    registry import("engines/performance") → input Zod parse → exit 2 on error
     │  └ src/engines/performance/engine.ts
     │     scheduler (open: Poisson/constant arrivals; closed: VUs; iterations)
     │     → safety lease (GCRA rate cap, concurrency, request and duration budgets)
     │     → src/adapters/http/undici-executor.ts (undici Pool per origin, timeouts §4, body cap §6)
     │     → HDR histograms per window, 1 Hz perf.tick event → stderr progress
     │     → end: merge histograms, thresholds (src/core/config/thresholds.ts), findings
     └ run-common.finishRun()          reporting.combineResults → tty/json/md/junit/sarif/html,
                                        atomic file writes, history append (§8), process.exitCode
```

## 3. Error taxonomy and exit codes

All errors the user can cause are `SecondWorldError` subclasses with a stable `code`, a `hint` and
an `exitCode` (`src/core/errors.ts`). The CLI prints `✖ message [CODE, exit N]` plus the hint
(`src/cli/output.ts` `reportError`), and `src/cli/main.ts` turns anything else into exit 70.

| Exit | Meaning | Class / source |
|---|---|---|
| 0 | passed | — |
| 1 | findings at or above `report.failOn`, or a regression (`sw history diff`) | `src/engines/reporting/exit-code.ts` |
| 2 | config or usage error | `ConfigError` `SW_CONFIG_*`; commander usage errors |
| 3 | blocked by safety (target class, budget, DNS rebinding, approval refused) | `SafetyError` `SW_SAFETY_*` |
| 4 | capability missing (Docker, git, …) | `CapabilityError` `SW_CAP_*`; `sw doctor` failures |
| 5 | target unreachable / unhealthy | `TargetError` `SW_TARGET_*` |
| 70 | bug in SECOND WORLD | `EngineError`, `InternalError`, any non-`SecondWorldError` |
| 130 | cancelled (second Ctrl+C, or `AbortError`) | `src/cli/run-common.ts`, `src/cli/output.ts` |

Config errors carry the **full key path and its source** (`src/core/config/loader.ts`
`zodToConfigError`):

```text
✖ Config error
  safety.maxRPS: Unknown key (did you mean "maxRps"?)   ← from sw.config.yaml
  safety.maxDuration: Invalid duration (e.g. "250ms", "30s", "1h30m") "10 parsecs"   ← from sw.config.yaml
  safety.maxRps: Invalid rate (e.g. 200, "200/s", "12000/m") "abc"   ← from env SW_SAFETY__MAX_RPS
```

Engine sections (`performance`, `stress`, …) are validated by each engine's own input schema at run
time, still as `ConfigError` → exit 2 (`src/engines/*/index.ts`). Threshold expressions are parsed
by `src/core/config/thresholds.ts` (`thresholds.http.p95: Invalid threshold …`).
Tests: `tests/unit/design/config-errors.test.ts`, `tests/unit/core/errors.test.ts`.

**Known gaps**

- Engine input errors print paths relative to the engine input (`vus: …`, `(root): Unrecognized key: "duraton"`),
  not `performance.vus`, because the input is merged from config **and** CLI flags.
- `sw perf --dry-run` validates the input schema but not the threshold expressions, so it can say
  "config valid" for a threshold the real run rejects with exit 2 (`src/cli/commands/perf.ts`).

## 4. Timeouts

Every outbound call has a deadline:

| Call | Timeout | File |
|---|---|---|
| Load / probe HTTP request (headers + body) | `timeout` (default 10 s) via a per-request `AbortController`; undici `headersTimeout`/`bodyTimeout` = timeout + 1 s as backstops | `src/adapters/http/undici-executor.ts` |
| TCP connect | `connectTimeoutMs` (default 5 s) | same |
| Keep-alive idle socket | 4 s | same |
| Toxiproxy API | 5 s (`AbortSignal.timeout`), probe 1.5 s | `src/adapters/faults/toxiproxy.ts` |
| Fault revert actions (HTTP / exec) | 10 s | `src/adapters/faults/cleanup.ts` |
| `docker version` / `docker inspect` | 3 s / 15 s | `src/adapters/faults/docker.ts` |
| Environment probe subprocesses | per-call `timeout` | `src/core/probe/probe.ts` |
| Whole run | `safety.maxDuration` (default 30 min) aborts the run | `src/core/safety/guard.ts` |

**Known gaps**: DNS resolution for pinning/rebinding checks (`dns.promises.lookup` in
`src/core/safety/guard.ts`) has no explicit timeout; it relies on the OS resolver. The built-in
fault proxy deliberately has no upstream timeout (it must be able to emulate a black hole); the
client's timeout bounds every exchange (`src/adapters/faults/builtin-proxy.ts`).

## 5. Retries, backoff and idempotency of outbound calls

- **Requests to the target are never retried.** A load or bug-hunting tool must measure failures,
  not hide them; a failed request is a data point (`error.kind` = timeout / connect / reset / …,
  `src/adapters/http/errors.ts`). Redirects are followed only when asked, at most `MAX_REDIRECTS = 5`
  hops, each hop vetted by the Safety Guard, credentials stripped across origins.
- **Retries exist only for local, idempotent operations**, all bounded:
  - Windows `rename` over an existing file (antivirus/indexer locks): 10 attempts, exponential backoff
    capped at 200–500 ms (`src/engines/reporting/json.ts` `writeFileAtomic`, `src/engines/history/fsutil.ts` `renameWithRetry`);
  - fault-ledger file access: 5 s retry budget (`src/adapters/faults/cleanup.ts`);
  - a fault revert that fails keeps its ledger entry so `cleanupAll()` / the watchdog can retry it later
    (`src/adapters/faults/external.ts`).
- Disruptive actions (mutating requests, fault injection) need `safety.allowMutations` /
  approval (`src/core/safety/guard.ts`); the Reliability Lab sends an idempotency key per logical
  operation when configured (`src/engines/reliability/runner.ts`).

**Known gaps**: the local retries use exponential backoff **without jitter**; harmless for a single
process, but two `sw` processes contending for the same file retry in lock-step.
`src/shared/util/backoff.ts` (full jitter, injectable randomness) exists but nothing in `src/` uses it.

## 6. Backpressure and bounded memory

| Resource | Bound | File |
|---|---|---|
| In-flight requests | `maxInFlight` (open model; default ≤ `safety.maxConcurrency`), VUs (closed model); late arrivals counted as dropped, never queued without limit | `src/engines/performance/engine.ts` |
| Request rate | GCRA, O(1) memory, no refill timer | `src/core/safety/gcra.ts` |
| Sockets | `connections` per origin (default 64; open model ≤ 1024) | `src/adapters/http/undici-executor.ts` |
| Latency samples | HDR histograms (fixed memory), per window | `src/engines/performance/**`, `src/shared/stats/**` |
| Response body kept in memory | `maxBodyBytes` (default 1 MiB) — exact; the rest is counted and discarded | `src/adapters/http/undici-executor.ts` |
| OTLP receiver | body ≤ 16 MiB, decompressed ≤ 16 MiB, spans ≤ 200k, metrics ≤ 50k (oldest dropped and counted), warnings ≤ 100 | `src/adapters/telemetry/receiver.ts` |
| Gzip telemetry files | zip-bomb guard: ≤ min(256 MiB, max(16 MiB, 200 × compressed)) | `src/adapters/telemetry/gzip.ts` |
| Events | synchronous dispatch; listener errors isolated; the hot path never awaits a listener | `src/core/events.ts` |
| Config walks / redaction | iterative (explicit stack), no recursion on user-sized input | `src/core/config/loader.ts`, `src/core/log/redact.ts` |

Fixed in wave 7 (tests in `tests/unit/design/resilience.test.ts`): the body cap could be exceeded by
a whole chunk (5000 bytes kept with a 1000-byte cap); the OTLP receiver answered 500 and lost a
batch of more than ~120k spans because of `push(...spans)` (V8's argument limit); the OTLP JSONL
reader reported such a line as "not valid JSON".

**Known gaps**

- The evidence store (`src/core/evidence/store.ts`) and the per-run findings list are in memory and
  bounded only by fingerprint de-duplication.
- The built-in fault proxy buffers client bytes in memory while a TCP connection is held by a
  black-hole fault (`src/adapters/faults/builtin-proxy.ts`, `pending`); bounded by the fault TTL and by
  the client, not by a byte limit.
- `Math.min(...xs)` / `Math.max(...xs)` over per-tick series in reporting sparklines
  (`src/engines/reporting/{tty,markdown,html}.ts`) would hit the same V8 argument limit for a series
  of more than ~120k points (a 33-hour run at 1 Hz). Not verified with a real run.

## 7. Determinism

- Randomness: `ctx.rng` — xoshiro128** seeded via splitmix32, `fork(name)` gives independent named
  streams so results do not depend on scheduling order (`src/core/rng.ts`). `--seed` on the CLI.
  `Math.random` is not used in engine code; the fault proxy takes an injected `random()`
  (`src/adapters/faults/builtin-proxy.ts`).
- Time: `ctx.clock` — durations from `performance.now()`, wall time only for timestamps;
  `createFakeClock()` for tests (`src/core/clock.ts`).
- Output: canonical JSON report (2-space, fixed key order, findings sorted by classification →
  severity → title → id; `src/engines/reporting/model.ts`, `json.ts`). The report snapshot in
  `tests/unit/design/__snapshots__/report-v1.json.snap` is byte-for-byte reproducible.
- No AI/LLM anywhere (ADR-009).

## 8. Idempotency and crash safety of local state

- Report files: temp file + rename (`src/engines/reporting/json.ts` `writeFileAtomic`).
- History: report `runs/<id>.json.gz` written atomically, then one fsync'd line appended to
  `runs.jsonl`, both under a lock file with stale-lock detection (`src/engines/history/fsutil.ts`,
  `jsonl-store.ts`). Reads skip torn/corrupt index lines; `sw history verify` reports orphans and
  checksum mismatches. Stored reports are never rewritten; migrations run on read (§12).
- Fault injection: every revert action is written to a ledger **before** the fault is applied; a
  watchdog child process reverts it at TTL even if `sw` is killed (`src/adapters/faults/cleanup.ts`,
  `external.ts`).
- Concurrency of two `sw` processes on one project is owned by Plan §A (sw-race7) and documented in
  [02 – Architecture](02-architecture.md) ("Concurrency model").

## 9. Graceful shutdown and cancellation

- One root `AbortController` per World; an external `signal` is combined with `AbortSignal.any`
  (`src/core/world.ts`). The Safety Guard's kill switch aborts the same tree.
- Ctrl+C / SIGTERM (and SIGBREAK on Windows): first signal → `world.cancel()` — stop scheduling,
  drain in-flight requests, write a partial report with `status: "cancelled"`; second signal → exit
  130 (`src/cli/run-common.ts` `installSignals`).
- Every request listens to the run signal and has its own timer; `close()` destroys all undici
  pools (`src/adapters/http/undici-executor.ts`). The fault proxy and OTLP receiver close every
  socket on `close()` (`builtin-proxy.ts`, `receiver.ts`).
- After the command returns, `src/cli/main.ts` sets `process.exitCode` and forces `process.exit`
  50 ms later, so a leaked handle can never hang the CLI.

## 10. Observability

- Logs: tiny structured logger to **stderr** (stdout is reserved for reports / `--json`), text or
  JSON lines, redaction mandatory (`src/core/log/logger.ts`).
- Events: typed bus (`src/core/events.ts`). Emitted today: `run.started|completed|failed`,
  `perf.tick` (1 Hz), `stress.stage.start|end`, `bugs.technique|done`, `agent.iteration|done`,
  `reliability.fault`, `evolution.gate`, `model.built`, `history.saved`, `finding.created|updated`
  (from the evidence store, `src/core/world.ts`), `world.closed`. The CLI renders progress from
  them (`src/cli/run-common.ts` `attachProgress`). Known gap: docs/02 §4.3 also names
  `perf.stage.completed`, `safety.blocked` and `run.cancelled` as events; they are not emitted
  (`safety.blocked` is an audit-log action, a cancelled run ends with `run.completed` and status
  `cancelled` — not verified for every engine).
- Audit log: append-only JSONL with a SHA-256 hash chain of every safety decision, at
  `<config dir>/.second-world/audit.log` when a config file is used; `verifyAuditLog()` finds the
  first broken line (`src/core/safety/guard.ts`).
- Generator self-check: every perf result says whether the load generator itself was saturated
  (CPU, event-loop lag, scheduling lag) so a slow tool is not reported as a slow target
  (`src/engines/performance/**`).

## 11. Configuration precedence

Highest wins (`src/core/config/loader.ts` header; docs/08 §1):
CLI flags → `--set a.b=v` → env `SW_*` (`__` for nesting) → `--profile` → project file (+ its
`extends` chain) → user config → defaults. One Zod schema validates the merged result
(`src/core/config/schema.ts`, `.strict()` everywhere, so unknown keys are errors). Every leaf
records its origin (`sw config print --resolved`). TS/JS config files are the only user code
SECOND WORLD executes, and `--no-config-code` disables them. Relative paths in a config file
resolve against the config file's folder (`ResolvedConfig.cwd`), paths typed on the CLI against
the invocation folder (`invocationCwd`).

## 12. Versioned schemas and the public API

| Artifact | Version field | Source of truth | Frozen by |
|---|---|---|---|
| Finding / EngineResult / Evidence | `schemaVersion: 1` (`SCHEMA_VERSION`) | Zod, `src/core/evidence/schemas.ts` | `__snapshots__/evidence-v1.schema.json.snap` |
| Combined report (JSON) | `schemaVersion: 1`, `kind: "second-world-report"` | `src/engines/reporting/model.ts` | `__snapshots__/report-v1.json.snap` |
| History run + index line | `schemaVersion: 1` / `v: 1` (`HISTORY_SCHEMA_VERSION`) | `src/engines/history/types.ts` | `__snapshots__/history-v1.json.snap` |
| Config | `$schemaVersion: 1` (optional) | `src/core/config/schema.ts`; JSON Schema via `sw config schema` | — |
| Public API (`src/index.ts`) | package semver | `src/index.ts` | `__snapshots__/public-api.txt` (151 names + kinds) |

History migrations run on read and never rewrite stored files: v0 (bare `EngineResult[]` or
`{ results }`) → v1; a newer version than the tool supports is refused with
`UnsupportedSchemaError` (`src/engines/history/migrations.ts`). Tests:
`tests/unit/design/schema-freeze.test.ts` (v0 wrapper, a frozen v1 record, newer version).
Rule: a breaking change bumps the version and adds a migration; only additive-optional changes may
update a snapshot (with `-u`) and must be mentioned in CHANGELOG.md.

## 13. Security boundaries

- **Safety Guard** (`src/core/safety/guard.ts`) — the only door to the network. Loopback allowed;
  private hosts need `allowHosts`; public hosts need `allowHosts` + `allowPublic` + approval. DNS is
  pinned on first lookup and re-checked (rebinding → `SW_SAFETY_DNS_REBIND`, kill switch); every
  redirect hop is re-checked. Budgets: `maxRps`, `maxConcurrency`, `maxRequests`, `maxDuration`.
- **Redaction** (`src/core/log/redact.ts`) — header/key names, exact config secret values, token
  patterns (Bearer, JWT, cloud keys, PEM, URL credentials) and high-entropy values next to key-like
  names become `«redacted:<sha256-8>»` in logs, reports, `--dry-run` output and artifacts.
  Credential headers are never forwarded to another origin on a redirect
  (`src/adapters/http/undici-executor.ts`).
- **Secrets** are `{ env }` / `{ file }` references resolved at run time and never persisted
  (`src/core/config/loader.ts` `resolveSecret`).
- **Config** cannot pollute prototypes: `__proto__`, `constructor`, `prototype` are dropped in every
  layer (`mergeLayer`, `setPath`; test in `tests/unit/design/config-errors.test.ts`).
- **Static analysis never executes user code** (ADR-010); generated reproduction scripts escape
  U+2028/U+2029 and quotes.

## 14. Enforcement tests

| Test file | What it guards |
|---|---|
| `tests/unit/design/imports.test.ts` | layering R1–R7, cross-engine ratchet, no runtime import cycles |
| `tests/unit/design/public-api.test.ts` | exported names + kinds of `src/index.ts`; runtime exports match |
| `tests/unit/design/schema-freeze.test.ts` | v1 evidence / report / history shapes; migrations of old history records |
| `tests/unit/design/startup-budget.test.ts` | CLI entry loads no engine/adapter; `sw --version`/`--help` time and peak RSS |
| `tests/unit/design/resilience.test.ts` | body cap, large OTLP batches |
| `tests/unit/design/config-errors.test.ts` | config errors → exit 2 with key paths, typo suggestions, prototype-pollution safety |

Start-up budget (measured on Windows 11 / Node 24, from source via tsx): `--version` ≈ 285–325 ms,
≈ 55 MB peak RSS; `--help` ≈ 280–300 ms, ≈ 57 MB (built `dist/cli.mjs`: ≈ 155–205 ms, ≈ 51 MB).
The test allows best-of-3 ≤ 1000 ms and ≤ 170 MB (about 3×). Slow CI: set
`SW_STARTUP_BUDGET_MS` / `SW_STARTUP_BUDGET_RSS_MB`, or `SW_SKIP_STARTUP_BUDGET=1` to skip the
measured part (the static part always runs).

To change something on purpose: public API or schema snapshots →
`npx vitest run tests/unit/design -u` and review the diff; a new cross-engine import → add it to
`KNOWN_CROSS_ENGINE` **and** to §1 Known gaps, or (better) route it through the Evidence Store,
the event bus or the registry.
