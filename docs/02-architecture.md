# 02 — Architecture

## 1. Architectural style

A **modular monolith** in one npm package (`second-world`), organised as **core + engines + adapters**:

- **Core**: small, dependency-light, always loaded. Contains config, safety, events, evidence, probes and the registry.
- **Engines**: independent feature modules, loaded on demand with dynamic `import()`.
- **Adapters**: swappable integrations such as HTTP clients, telemetry readers, storage, fault injectors and reporters.

The boundaries are set up so that splitting into separate packages later (`@second-world/core`, `@second-world/perf`, …) only means moving folders, not rewriting code.

```mermaid
flowchart TB
  CLI[CLI - commander] --> API[Programmatic API - createWorld]
  API --> ORCH[Orchestrator / Workflow runner]
  ORCH --> REG[Engine Registry - lazy]
  subgraph Core
    CFG[Config loader + Zod schemas]
    SAFE[Safety Guard]
    BUS[Event Bus]
    EVID[Evidence Store]
    PROBE[Environment Probe]
    CLOCK[Clock + Seeded RNG]
    LOG[Logger + Redactor]
  end
  REG --> PERF[Performance Lab]
  REG --> STRESS[Stress & Capacity]
  REG --> ARCH[Architecture Inspector]
  REG --> BUGS[API Bug Hunter]
  REG --> ADV[Adversarial Agent]
  REG --> REL[Reliability Lab]
  REG --> MODEL[System Model]
  REG --> EXP[What-If / Evolution]
  REG --> SUM[Summary - sw analyze]
  REG --> REP[Reporting]
  REG --> HIST[History]
  PERF & STRESS & BUGS & REL --> SAFE
  PERF & STRESS & ARCH & BUGS & ADV & REL & MODEL & EXP --> EVID
  EVID --> REP & HIST & SUM
```

## 2. Layering rules (enforced by tests)

| Layer | May import | Must not import |
|---|---|---|
| `core/*` | Node built-ins, `zod`, `shared/*`, tiny utils; engines only via `import()` (or type-only) from the composition root (`core/registry.ts`, `core/world.ts`) | `cli`, `adapters`; engines statically |
| `engines/<x>/*` | `core/*`, `shared/*`, `adapters/*` | `cli`, `src/index.ts`; other engines directly (known exceptions are frozen, see below) |
| `adapters/*` | `core/*`, `shared/*` | Engines, `cli` |
| `shared/*` | nothing else from `src/` (leaf) | everything else |
| `cli/*` | `core/*`, `shared/*`; engines only through `engines/<x>/index.ts`, lazily (`import()`) or type-only | Engine internals |

Enforced in CI by `tests/unit/design/imports.test.ts` (rules R1–R7 over a TypeScript-AST import
graph, plus "no runtime import cycles"); there is no dependency-cruiser config. Existing
engine → engine imports (e.g. `stress → performance`, `agent → bugs`) are frozen in that test's
`KNOWN_CROSS_ENGINE` list: a new pair fails CI (docs/16-system-design.md §1). Otherwise engines talk
to each other through:

1. **The Evidence Store** (read findings/measurements of other engines).
2. **The Event Bus** (subscribe to `stress.stage.end`, `finding.created`, etc.; list in §4.3).
3. **Typed engine outputs** passed by the orchestrator in a workflow.

## 3. Source layout (v2)

```text
second-world/
├── src/
│   ├── index.ts                 # public API: createWorld, defineConfig, types
│   ├── cli/
│   │   ├── main.ts              # commander program, global flags (commands loaded lazily)
│   │   ├── commands/            # perf, stress, inspect, bugs, agent, reliability, model,
│   │   │                        # experiments (whatif, evolve), analyze, history, config, doctor, init
│   │   ├── output.ts            # stdout/stderr, colour and symbols
│   │   └── run-common.ts        # World from flags, signals, progress, report writing
│   ├── core/
│   │   ├── world.ts             # World facade (lazy engine getters), root AbortController
│   │   ├── orchestrator.ts      # runs workflows (DAG of engine steps)
│   │   ├── registry.ts          # engine/plugin registry, capability requirements
│   │   ├── config/              # schemas, loader, profiles, env overlay, units parser
│   │   ├── safety/              # target guard, budgets, approvals, kill switch
│   │   ├── events.ts            # typed event bus
│   │   ├── evidence/            # Finding, Evidence, Measurement types + store
│   │   ├── probe/               # environment & capability detection
│   │   ├── clock.ts             # monotonic clock abstraction (testable)
│   │   ├── rng.ts               # seeded PRNG (xoshiro128**)
│   │   ├── context.ts           # EngineContext factory (test-friendly defaults)
│   │   ├── types.ts             # Engine, EngineContext, EventBus contracts
│   │   ├── errors.ts            # error hierarchy with codes
│   │   └── log/                 # logger + secret redaction
│   ├── shared/
│   │   ├── ds/                  # ring buffer, binary heap, semaphore, LRU, union-find, bitset
│   │   ├── stats/               # HDR wrapper, Welford, bootstrap/compare, MAD + CUSUM, knee, windows
│   │   ├── graph/               # directed graph, traversal, Tarjan SCC, cycles, toposort, impact
│   │   └── util/                # atomic write, backoff, hashing, fingerprints, ULID
│   ├── engines/
│   │   ├── performance/         # scheduler, executors, workers, metrics, thresholds
│   │   ├── stress/              # stage planner, capacity analysis, knee detection
│   │   ├── architecture/        # discovery, parser, extractors, rules, graph builder
│   │   ├── bugs/                # contracts, generators, boundary, property, stateful, authz
│   │   ├── agent/               # planner, bandit, scenario generator, safety validator
│   │   ├── reliability/         # fault injectors, scenarios, recovery measurement
│   │   ├── model/               # system model graph, entity resolution, enrichment
│   │   ├── experiments/         # what-if runner, evolution runner, comparisons
│   │   ├── summary/             # deterministic cross-report summary (sw analyze)
│   │   ├── reporting/           # aggregators, formatters (tty, json, md, html, junit, sarif)
│   │   └── history/             # stores (jsonl; sqlite planned), baselines, regression detection
│   └── adapters/
│       ├── http/                # undici executor, per-phase timing
│       ├── faults/              # built-in fault proxy, toxiproxy, docker, cleanup ledger
│       └── telemetry/           # OTLP receiver/reader, Prometheus
├── tests/                       # unit, integration, e2e, system, fixtures, helpers
├── examples/                    # sample apps (shop-express, shop-fastify, conduit-api, payments-fake)
├── docs/
├── package.json  tsconfig.json  vitest.config.ts  biome.json
└── README.md  LICENSE  CHANGELOG.md  SECURITY.md  CONTRIBUTING.md
```

## 4. Key core abstractions

```ts
// Every engine implements this contract.
export interface Engine<I, O extends EngineResult> {
  readonly id: EngineId;                       // "performance", "architecture", ...
  readonly version: string;
  readonly inputSchema: z.ZodType<I>;          // validated before run
  readonly requires: CapabilityRequirement[];  // e.g. { cap: "network.target" }, { cap: "docker", optional: true }
  run(input: I, ctx: EngineContext): Promise<O>;
}

export interface EngineContext {
  signal: AbortSignal;          // cancellation, propagated everywhere
  clock: Clock;                 // monotonic time, injectable for tests
  rng: Rng;                     // seeded
  log: Logger;                  // redacting logger
  events: EventBus;             // progress & cross-engine signals
  evidence: EvidenceStore;      // read + write findings/measurements
  safety: SafetyGuard;          // must be consulted before any outbound action
  env: EnvironmentReport;       // result of probe
  config: ResolvedConfig;
}

export interface EngineResult {
  engine: EngineId;
  runId: string;                // ULID
  status: "passed" | "failed" | "partial" | "skipped" | "error" | "cancelled";
  startedAt: string; endedAt: string;   // ISO-8601 UTC
  findings: Finding[];
  limitations: Limitation[];    // what could not be determined, and why
  artifacts: ArtifactRef[];     // raw data files, HAR, graphs
}
```

### 4.1 Lazy engine loading (the "dynamic" part)

```ts
const builtins: Record<EngineId, () => Promise<EngineModule>> = {
  performance:  () => import("./engines/performance/index.js"),
  architecture: () => import("./engines/architecture/index.js"), // pulls in `typescript` only here
  model:        () => import("./engines/model/index.js"),
  // ...
};
```

`world.performance.test()` never loads the TypeScript compiler (~10 MB), so startup stays fast.

### 4.2 Orchestrator and workflows

A **workflow** is a DAG of engine steps declared in config or code. The orchestrator topologically sorts the steps (Kahn's algorithm) and runs independent steps in parallel with a concurrency limit. It passes typed outputs downstream, and a failed step either stops its dependants or lets them continue (`continueOnError`).

```ts
workflow: {
  steps: {
    inspect: { engine: "architecture" },
    perf:    { engine: "performance", after: [] },
    bugs:    { engine: "bugs" },
    report:  { engine: "reporting", after: ["inspect", "perf", "bugs"] },
  }
}
```

### 4.3 Event bus

A typed, synchronous-dispatch, async-safe emitter (no external dep). Events are namespaced. Emitted today: `run.started`, `run.completed`, `run.failed`, `perf.tick` (1 Hz live stats), `stress.stage.start`, `stress.stage.end`, `bugs.technique`, `bugs.done`, `agent.iteration`, `agent.done`, `reliability.fault`, `evolution.gate`, `model.built`, `history.saved`, `finding.created`, `finding.updated`, `world.closed`; a `"*"` listener receives every event. There is no `run.cancelled` event (cancellation is reported in the result, §4.4); a safety refusal is a `SafetyError` plus a `safety.blocked` entry in the audit log, not an event. Renderers, history and plugins subscribe. **The hot path never awaits listeners**: `emit` calls listeners synchronously and ignores their return value; a listener that throws or returns a rejected promise is logged, never propagated to the emitter.

### 4.4 Cancellation

A single root `AbortController` per run, with child controllers per engine, stage and request (`AbortSignal.any`). `Ctrl+C` once means a graceful stop: stop scheduling, drain in-flight up to the grace period, write a partial report. `Ctrl+C` twice means a hard abort. A cancelled run is still a valid report with `status: "cancelled"`.

### 4.5 Error model

```text
SecondWorldError (code, hint, cause)
├── ConfigError          SW_CONFIG_*     → exit 2
├── SafetyError          SW_SAFETY_*     → exit 3
├── CapabilityError      SW_CAP_*        → exit 4 (or skipped if optional)
├── TargetError          SW_TARGET_*     (target unreachable before start) → exit 5
├── EngineError          SW_ENGINE_*     → exit 70
└── InternalError        SW_INTERNAL     → exit 70
```

Errors carry a human **hint** ("Target resolves to ::1 but server listens on 127.0.0.1 — set `target` to `http://127.0.0.1:3000`").

### 4.6 Concurrency model

Several `sw` processes may run at once on one project (two terminals, parallel CI jobs). What is
guaranteed, with the test that checks it (`tests/unit/concurrency/`, `tests/integration/concurrency/`):

| State | Mechanism | Guarantee | Test |
|---|---|---|---|
| History index `runs.jsonl` and run bodies `runs/<id>.json.gz` | Writer lock `.lock` (created with its owner record via temp file + hard link; O_EXCL fallback); body written to a temp file, fsynced and renamed, then one O_APPEND write of the index line, fsynced | No lost, torn or interleaved records; one record per run under its own run id; a body is in place before its index line | `cli-parallel` (4 parallel `sw perf`), `history-writers` (8 parallel `world.history.save`, 8 store instances × 4 appends + live reader) |
| Stale history lock | The holder refreshes the lock's mtime every 1 s (heartbeat). Stale = holder pid dead on this host, heartbeat older than 5 s on this host (catches a dead holder whose pid was reused — common on Windows), older than 60 s, or still empty after 2 s; waiters that find the same stale lock serialise through `.lock.break` (O_EXCL) and re-check before removing it | One holder at a time even when several waiters break the same stale lock; a writer killed while holding or creating the lock does not block later saves | `history-lock`, `pid-reuse` (robust), `cli-parallel` ("killed mid-write") |
| Crash mid-write | Readers skip an unreadable index line (e.g. a record cut short by a kill) and log a warning once; the next append starts on a fresh line; `sw history verify` lists it; `sw history prune` deletes leftover temp files | Later reads and writes keep working; records already acknowledged survive | `history-writers` ("cut off mid-append"), `cli-parallel` |
| `baselines.json` | Read-modify-write under the history lock, atomic replace | No lost update between concurrent `setBaseline` | `history-writers` |
| Report files (`report.json`, `.md`, `.junit.xml`, …) | Unique temp file + rename (retry on Windows EPERM/EBUSY); the whole set of one run is written under a directory lock `<outDir>/.sw-report.lock` (same lock mechanism as history) | Each file is always one complete report, and the files of one `-o` dir come from one run: with parallel runs sharing `-o`, the **last run to finish owns every file it writes** (names stay fixed so CI paths keep working). A file format that only an earlier run wrote is not removed. If the lock cannot be taken within 10 s, reports are written without it (warning). For separate reports per parallel run, use a separate `-o`. | `shared-outdir` (robust), `history-writers` ("8 writers to the same report file"), `cli-parallel` |
| Ctrl+C (SIGINT/SIGTERM) | First signal: `world.cancel()` → graceful stop; second: removes this process's own temp files (names carry its pid) and locks, then exit 130 at once | First: exit 130, a complete partial report, no temp/lock/`pending-*` files left; an engine interrupted before it started also exits 130 (not 3). `sw evolve`: no git worktree, temp checkout or candidate app process left. Second: no report/history temp file or lock of the process left (a bugs `.second-world` `pending-*` reproductions dir may remain: it only holds reproductions already written) | `lifecycle`, `evolve-interrupt`, `cancel-before-start`, `double-sigint` (robust) |
| Process exit | — | `perf`, `stress`, `bugs` exit on their own after finishing (no leaked handle keeps the process alive) | `lifecycle` ("commands exit on their own") |
| Safety rate cap | One world-wide GCRA (plus a per-lease one when a lease asks for less); decisions are synchronous, so concurrent VUs cannot overshoot | Concurrent callers on one lease, and two concurrent leases together, stay within `maxRps` + burst | `safety-rate` |

Not guaranteed (known, tracked): model snapshots
and the architecture facts cache use a per-process temp name, so two concurrent saves inside one
process can fail (`snapshot-writers`, expected-fail). The Ctrl+C tests emulate the signal inside the
process on every OS (Windows cannot deliver SIGINT to a child); the OS signal itself is tested on
macOS/Linux in `tests/e2e/cli.test.ts`.

## 5. Data flow of a single performance run

```text
config file/CLI flags ─► loader (c12) ─► Zod validate ─► unit normalise ─► profile/env overlay
   ─► Safety Guard (host allow-list, budgets) ─► Env Probe (cpu quota, fd limit, proxy)
   ─► Scheduler (open/closed model) ─► Executor (undici pool) ─► per-worker HDR histograms
   ─► 1 s window ring buffer ─► live renderer
   ─► end: merge histograms ─► thresholds ─► findings ─► Evidence Store ─► reporters ─► exit code
```

## 6. Architecture decision records (summary)

| ADR | Decision | Rationale | Revisit when |
|---|---|---|---|
| 001 | Modular monolith, one package | Fast iteration, one version | >3 engines need independent release cadence |
| 002 | ESM-first, Node ≥ 22.19 (tested on 22/24/26), dual ESM/CJS build of public API | Modern Node, still consumable by CJS users | — |
| 003 | `undici` as HTTP engine (not `axios`/`got`) | Connection pooling, timing hooks, highest throughput in Node, ships with Node | — |
| 004 | HDR histograms for latency | Fixed memory, O(1) record, mergeable, exact-within-precision percentiles | — |
| 005 | Open-loop scheduling as default for rate tests, closed-loop for VU tests, CO correction always on | Avoid *coordinated omission* | — |
| 006 | No native addons in core | Works on every OS/arch/libc without compilers | — |
| 007 | Zod v4 as single source of truth for config & report schemas, JSON Schema generated | Types + validation + editor autocomplete from one place | — |
| 008 | JSONL history is the default; `node:sqlite` is an opt-in backend (`history.backend: "sqlite"`, same contract, lazy-loaded, JSONL fallback when unavailable; docs/03-engines/evidence-and-history.md §B.1.1) | Zero-dependency storage; SQL (indexed filters, one file, WAL) when history grows | `node:sqlite` leaves experimental status → consider making it the default |
| 009 | No AI or LLM anywhere; every result is deterministic (measurement, analysis or code) | Reproducible, explainable results; no code or data sent to third parties | — |
| 010 | Static analysis never executes user code | Safety. Config loading of *our own* config file is the only execution | — |
| 011 | Embed k6/Artillery only as optional adapters | Native engine covers 90 %; bridges for users who already have scripts | — |
