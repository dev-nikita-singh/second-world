# 09 — CLI & Programmatic API

## 1. CLI

Binary names: `sw` and `second-world`. `sw --help` and `sw <command> --help` print the same
options as below. A test (`tests/unit/cli/help-docs-parity.test.ts`) keeps this page and the help
in sync: every command and long option of `sw` appears here, and every `sw` command and long option
named here exists.

Repeatable options take one value per occurrence (`--include "GET /a" --include "GET /b"`).
List options (`--techniques`, `--include`, `--exclude`, `--concurrency-test`) also split on commas.

### Global flags

Global flags go before or after the command (`sw --dry-run bugs …` or `sw bugs --dry-run …`).

| Flag | Meaning |
|---|---|
| `-c, --config <file>` | Config path (default: auto-discover `sw.config.*`) |
| `-p, --profile <name>` | Apply a config profile |
| `--set <key=value>` | Override any config key (repeatable) |
| `-f, --format <list>` | Report formats: `tty,json,md,junit,sarif,html` (default from `report.formats`: `tty,json`) |
| `-o, --out <dir>` | Report output dir (default `report.outDir`: `.second-world/reports`) |
| `--fail-on <sev>` | Exit 1 threshold: `critical\|high\|medium\|low\|never` (default `report.failOn`: `high`) |
| `--seed <n>` | Global seed |
| `--label <name>` | History label for this run (also filters `history diff label:<name>`) |
| `--yes` | Non-interactive approval of confirmations (logged to the audit trail) |
| `--approve-disruptive` | Approve disruptive actions (logged to the audit trail) |
| `--dry-run` | Validate config and input as the real run does before its first request (thresholds, scenarios, contract, invariant modules, hook targets, context reports), run the safety check and probe, print the plan. Sends nothing |
| `--no-color` | Disable colours (also `NO_COLOR`) |
| `--quiet` | Only errors |
| `--verbose` | Debug logging |
| `--json-logs` | JSON log lines on stderr |
| `--no-config-code` | Only load JSON/YAML configs (never execute config code) |
| `-V, --version` | Print the version |
| `-h, --help` | Help for `sw` or for one command |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, no finding at or above `--fail-on` |
| 1 | Findings at or above `--fail-on`; `sw replay`: still reproduces; `sw history diff`: significant regression; `sw history verify`: corrupted |
| 2 | Invalid config, input or flag (usage errors too); `sw replay`: inconclusive |
| 3 | Blocked by the Safety Guard |
| 4 | A required capability is missing (see `sw doctor`) |
| 5 | Target unreachable |
| 70 | Internal error (a bug: please report it) |
| 130 | Cancelled (Ctrl+C) |

### Commands

| Command | Description |
|---|---|
| `sw init` | Detect the project and write `sw.config.ts` with local-only safety defaults; adds `.second-world/` to `.gitignore` |
| `sw doctor` | Environment & capability report with fixes |
| `sw config print\|validate\|schema` | Config tools |
| `sw perf [target]` | Performance Lab |
| `sw stress [target]` | Stress & Capacity Lab |
| `sw inspect [path]` | Architecture Inspector (static; never runs project code) |
| `sw bugs` | API Bug Hunter |
| `sw agent` | Adversarial Test Agent (QA test-case generator) |
| `sw replay <fingerprint>` | Re-run a recorded Bug Hunter reproduction |
| `sw reliability list\|run\|cleanup` | Reliability Lab (fault injection) |
| `sw whatif <experiment>` | What-If Engine |
| `sw evolve` | Evolution Engine |
| `sw model build\|show\|diff` | System Model |
| `sw analyze [reports...]` | Deterministic summary across earlier reports |
| `sw history list\|show\|diff\|baseline\|trend\|verify\|prune` | Experiment History |

Not CLI commands in 0.1.0: combining or re-rendering reports (`world.report` in the API),
workflows (`world.run(name)` in the API) and plugin listing.

Engine commands that produce a report (perf, stress, inspect, bugs, agent, reliability run,
whatif, evolve) share `--json` (print the combined report JSON on stdout) and `--no-history`
(do not save this run to history).

### `sw init`

Detection is read-only (package.json, lockfiles, files on disk). In a terminal it asks for the
target URL and health path, then for confirmation; with `--yes`, without a TTY, or with `CI` set
it writes the detected defaults. Ctrl+C at a prompt exits 130 and writes nothing; answering "No"
to the confirmation exits 0 and writes nothing.

| Option | Meaning |
|---|---|
| `--force` | Overwrite an existing config |
| `--target <url>` | Service URL (default: the contract's local `servers[0]`, else `http://127.0.0.1:3000`) |
| `--json` | Print what was written / detected as JSON |

### `sw doctor`

| Option | Meaning |
|---|---|
| `--json` | Print the EnvironmentReport as JSON |
| `--quick` | Skip external tool checks |

### `sw config`

| Command / option | Meaning |
|---|---|
| `sw config print` | Print the merged config (secrets masked); `--resolved`: validated, normalised config with the origin of each key; `--json`: JSON instead of YAML |
| `sw config validate` | Validate the config (exit 2 on error); `--json`: machine-readable result |
| `sw config schema` | Print the config JSON Schema |

### `sw perf`

`sw perf [target]`: the target is a URL or a target name from the config (or `-t`).

| Option | Meaning |
|---|---|
| `-t, --target <url>` | Target URL or name |
| `--model <model>` | Load model: `open\|closed\|iterations` |
| `-r, --rate <rate>` | Arrival rate (open model), e.g. `200` or `200/s` |
| `-u, --vus <n>` | Virtual users (closed/iterations) |
| `-i, --iterations <n>` | Total iterations (iterations model) |
| `-d, --duration <dur>` | Test duration, e.g. `30s` |
| `--ramp-up <dur>` | Ramp-up duration |
| `--warmup <dur>` | Warm-up duration (excluded from results) |
| `--timeout <dur>` | Request timeout |
| `--arrival <kind>` | Arrival process (open model): `constant\|poisson` |
| `--max-in-flight <n>` | Cap on concurrent requests (open model) |
| `--workers <n\|auto>` | Generator threads (worker_threads shards); `auto` = min(CPUs - 1, 8) |
| `--threshold <expr>` | Threshold, e.g. `"p95<300ms"` (repeatable) |
| `--json`, `--no-history` | See above |

### `sw stress`

`sw stress [target]`.

| Option | Meaning |
|---|---|
| `-t, --target <url>` | Target URL or name |
| `--mode <mode>` | `step\|ramp\|spike\|soak\|breakpoint` |
| `--steps <list>` | Stage levels, e.g. `10,25,50,100` (VUs, or rates with `--rate`) |
| `--hold <dur>` | Hold time per stage, e.g. `30s` |
| `--settle <dur>` | Settle time before each stage (load runs, excluded) |
| `--rate-from <rate>` | Breakpoint search: lowest rate |
| `--rate-to <rate>` | Breakpoint search: highest rate |
| `--step <rate>` | Breakpoint search: rate step |
| `--min-step <rate>` | Breakpoint search: bisection resolution |
| `-r, --rate <rate>` | Base rate (soak: the soak level) |
| `-u, --vus <n>` | Base virtual users |
| `-d, --duration <dur>` | Soak duration |
| `--warmup <dur>` | Warm-up before the first stage |
| `--timeout <dur>` | Request timeout |
| `--threshold <expr>` | Threshold that defines a breach, e.g. `"p95<300ms"` (repeatable) |
| `--json`, `--no-history` | See above |

### `sw inspect`

`sw inspect [path]`: project root (default: config `project.root` or `.`).

| Option | Meaning |
|---|---|
| `--tsconfig <file>` | tsconfig path (relative to the project) |
| `--rule <id=level>` | Override a rule level, e.g. `ARCH004=off` (repeatable) |
| `--graph <format>` | Print the dependency graph instead of the report: `dot\|mermaid\|json` |
| `--view <view>` | Graph view: `components\|modules\|all` |
| `--no-cache` | Ignore and do not write the analysis cache |
| `--cache-dir <dir>` | Analysis cache directory |
| `--json`, `--no-history` | See above |

### `sw bugs`

Mutating requests need `--allow-mutations` (or `safety.allowMutations`) and approval (`--yes`).
See docs/03-engines/api-bug-hunter.md.

| Option | Meaning |
|---|---|
| `-t, --target <url>` | Target URL or name |
| `--openapi <file>` | OpenAPI contract (default: `bugs.contract` from config; absent → discovery mode) |
| `--techniques <list>` | `contract,boundary,equivalence,pairwise,property,negative,stateful,concurrency,auth` |
| `--replays <n>` | Replays per failing case (classification) |
| `--max-replays <n>` | Upper bound on replays (flaky cases) |
| `--property-runs <n>` | Property-based runs per operation |
| `--include <ops>` | Only these operations, e.g. `"GET /products/*"` (repeatable) |
| `--exclude <ops>` | Skip operations (repeatable) |
| `--allow-mutations` | Send POST/PUT/PATCH/DELETE (also needs approval: `--yes` or `safety.allowMutations`) |
| `--timeout <dur>` | Request timeout |
| `--json`, `--no-history` | See above |

Concurrency tests: one burst per `--concurrency-test`; the options below apply to its main request.

| Option | Meaning |
|---|---|
| `--concurrency-test <op>` | Concurrency burst on an operation, e.g. `"POST /orders"` (repeatable) |
| `--burst <n>` | Parallel requests per burst (default 10) |
| `--invariant <spec>` | `linearizable:<stock\|counter\|register\|set>[:initial]`, `max-success:<n>`, `same-response`, or a module path `./module.ts[#export]` |
| `--role <name>` | Auth role |
| `--body <json>` | Request body (JSON) |
| `--path-param <name=value>` | Path parameter, e.g. `--path-param id=1` for `"PUT /products/{id}/stock"` (repeatable). The name must be a `{placeholder}` of a `--concurrency-test` path |
| `--query <k=v>` | Query parameter (repeatable) |
| `--header <k=v>` | Request header (repeatable) |
| `--mix <spec>` | Interleave another operation with each burst (repeatable), see below |

`--burst`, `--invariant`, `--mix`, `--path-param`, `--query` and `--header` need
`--concurrency-test`. Values follow the `--mix` rules: numbers stay numbers, query `true`/`false`
become booleans, and a value may contain `=`. A malformed `key=value` exits 2 with the expected form.

```text
sw --yes bugs --techniques concurrency --allow-mutations \
  --concurrency-test "PUT /products/{id}/stock" --path-param id=7 --query by=1 \
  --header X-Tenant=acme --body '{"delta":-1}' --burst 4 --invariant linearizable:stock \
  --mix "GET /products/{id}:2 id=7 pointer=/stock"
```

`--mix` form: `"<METHOD> <path>[:<count>] [as=<op>] [count=<n>] [phase=before|during|after]
[pointer=/json/ptr] [value=<v>] [role=<name>] [<pathParam>=<v>] [query.<k>=<v>] [header.<k>=<v>]
[body=<json>]"`. `as` is `take|read|inc|dec|write|add|remove|has` (default `read` for GET/HEAD,
required otherwise); `body=` must be last.

### `sw agent`

Proposes, validates and runs extra API test cases; needs an OpenAPI contract. See
docs/03-engines/adversarial-test-agent.md.

| Option | Meaning |
|---|---|
| `-t, --target <url>` | Target URL or name (default: agent/bugs target) |
| `--openapi <file>` | OpenAPI contract (default: agent/bugs contract) |
| `--bandit <kind>` | Arm selection: `ucb1\|thompson` |
| `--budget <spec>` | `requests=N,iterations=N,time=30s,patience=N` (also `rps=`, `concurrency=`) |
| `--techniques <list>` | `status-gap,param-gap,boundary,idempotency,idempotency-concurrent,ownership,privilege,lifecycle,concurrency,history,arch-risk` |
| `--include <ops>` | Only these operations, e.g. `"GET /orders/*"` (repeatable) |
| `--exclude <ops>` | Skip operations (repeatable) |
| `--allow-mutations` | Send POST/PUT/PATCH (also needs `--yes` or `safety.allowMutations`) |
| `--allow-destructive` | Allow destructive operations (DELETE, …); requires `--yes` |
| `--context <report>` | Earlier `report.json` (bugs / inspect / agent) to seed hypotheses (repeatable) |
| `--export-tests <dir>` | Write a Vitest file per confirmed defect into `<dir>` |
| `--json`, `--no-history` | See above |

### `sw replay`

`sw replay <fingerprint>`: the fingerprint (or a unique prefix of at least 4 hex characters) shown
in the report. Exit 1 if it still reproduces, 2 if inconclusive, 0 if it does not reproduce.

| Option | Meaning |
|---|---|
| `--runs <n>` | Number of replays |
| `-t, --target <url>` | Target URL or name (default: from config) |
| `--openapi <file>` | OpenAPI contract |
| `--json` | JSON output |

### `sw reliability`

| Command / option | Meaning |
|---|---|
| `sw reliability list` | Built-in fault scenarios; `--json` |
| `sw reliability run <scenario>` | Run a fault scenario (disruptive: needs `--approve-disruptive` or `--yes`); options below |
| `sw reliability cleanup` | Revert leftover faults (in-process stack + persistent ledger); `--ledger <file>` (default `$SW_FAULT_LEDGER` or `<tmp>/second-world/fault-ledger.json`), `--json` |

`sw reliability run` options:

| Option | Meaning |
|---|---|
| `-t, --target <url>` | Target URL or name |
| `--dependency <name>` | Dependency to degrade (key of `reliability.dependencies`) |
| `-d, --duration <dur>` | Fault duration, e.g. `10s` |
| `--steady-phase <dur>` | Steady-state phase before the fault |
| `--recovery <dur>` | Recovery phase after the fault |
| `--steady <expr>` | Steady-state condition, e.g. `"p95<300ms"` (repeatable) |
| `--hypothesis <expr>` | Hypothesis during the fault, e.g. `"error_rate<5%"` (repeatable) |
| `--param <k=v>` | Scenario parameter, e.g. `latencyMs=500` (repeatable) |
| `-r, --rate <n>` | Workload rate (requests/s) |
| `--route <name=METHOD /path>` | Workload route, e.g. `orders="POST /orders"` (repeatable) |
| `--repeat <n>` | Repeat the experiment N times (reproduced-defect needs ≥ 2) |
| `--abort-error-rate <pct>` | Abort when the error rate exceeds this, e.g. `50%` |
| `--allow-production` | Allow fault injection when environment is production (still needs approval) |
| `--json`, `--no-history` | See above |

### `sw whatif`

`sw whatif <experiment>`: a name in `whatif.experiments`, or a `.ts/.js/.json/.yaml` file
exporting `experiment({...})`.

| Option | Meaning |
|---|---|
| `--repetitions <n>` | Runs per arm (≥ 5 recommended) |
| `--order <order>` | `interleaved\|randomized-blocks\|sequential` |
| `--lifecycle <l>` | App lifecycle: `per-run\|per-arm` |
| `--aa` | A/A run (baseline vs itself) to measure the noise floor |
| `--metric <name>` | Metric to compare, e.g. `p95` (repeatable) |
| `--json`, `--no-history` | See above |

### `sw evolve`

Builds, tests and benchmarks candidate changes in sandboxes and ranks them (Pareto). Commands are
split into argv without a shell.

| Option | Meaning |
|---|---|
| `--candidates <list>` | `branch:a,commit:sha,patch:./c.diff` (repeatable) |
| `--test <cmd>` | Test gate, e.g. `"npm test"` |
| `--start <cmd>` | Start command, e.g. `"npm run start:test"` |
| `--build <cmd>` | Build gate |
| `--health <path>` | Readiness path, e.g. `/healthz` |
| `--repetitions <n>` | Benchmark repetitions per arm |
| `--repo <dir>` | Git repository to evolve (default: the config directory) |
| `--baseline <ref>` | Baseline git ref (default `HEAD`) |
| `--finding <id>` | Finding this evolution targets |
| `--sandbox <kind>` | `auto\|docker\|process` (process needs `--yes`) |
| `--replay <artifact>` | Bug Hunter reproduction artifact to replay as a gate (repeatable) |
| `--metric <name>` | Metric to rank by (repeatable) |
| `--json`, `--no-history` | See above |

### `sw model`

`sw model build [path]` builds the model and saves a snapshot (`.second-world/model/latest.json`).
Unreadable inputs become limitations, not errors; `--dry-run` lists them as `warnings` and never
starts the `--receive` listener.

| Option (`sw model build`) | Meaning |
|---|---|
| `--openapi <file>` | OpenAPI contract (default: `bugs.contract` from config) |
| `--config-file <file>` | Infra/config file to include, e.g. `docker-compose.yml` (repeatable) |
| `--no-discover` | Do not auto-discover config files |
| `--traces <file>` | OTLP traces or metrics: JSON/JSONL or protobuf (`.pb`) files (repeatable) |
| `--prometheus <file\|url>` | Prometheus text exposition (repeatable) |
| `--receive <seconds>` | Run a local OTLP/HTTP receiver for N seconds and include what it gets |
| `--service-name <name>` | Primary service name |
| `--detail <level>` | Node detail: `components\|full` |
| `--no-architecture` | Skip the static architecture source |
| `--from-history` | Reuse the latest architecture run from history instead of re-inspecting |
| `--no-cache` | Ignore the architecture analysis cache |
| `--cache-dir <dir>` | Architecture analysis cache directory |
| `--graph <fmt>` | Print the graph instead of the summary: `dot\|mermaid\|json` |
| `--json` | Canonical JSON |
| `--no-history` | Do not save this build to history |

| Command / option | Meaning |
|---|---|
| `sw model show [snapshot]` | Show a snapshot (path or `latest`, the default); `--graph <fmt>` (`dot\|mermaid\|json`), `--node <id>` (neighbourhood / impact / reaching routes of one node), `--k <n>` (neighbourhood hops, default 2), `--json` |
| `sw model diff <before> <after>` | Compare two snapshots (paths or `latest`; informational, exit 0); `--json` |

### `sw analyze`

```text
sw analyze [reports...] [--last] [--top N] [--json]
```

A deterministic summary over one or more earlier runs. Every number is counted or copied from the
reports: nothing is inferred, and it never touches the network. The same input always gives the same output.

- **Input**: `report.json` files (a single engine result, an array of results, or the combined report that every engine
  command writes to `.second-world/reports/report.json` by default), plus, with `--last`, the newest run in history. At least one is required.
- **Output** (text): a headline (runs, engines, findings, how many are high or critical), then bullets with counts
  by severity, counts by trust-ladder classification (strongest first), the top N findings (default 5, ranked
  by severity then classification), run statuses, and every limitation whose impact is `invalidates`.
- **`--json`**: the same data as an object: `headline`, `bullets`, `text`, `counts` (`runs`, `findings`,
  `bySeverity`, `byClassification`, `statuses`) and `topFindings`.
- **Exit code**: always 0 when the input could be read, because it reports on runs and does not judge them.
  Exit 2 when no report was given, a file cannot be read or is not a SECOND WORLD report, or `--top` is not a
  non-negative integer. Output is redacted like every report.

```text
$ sw analyze .second-world/reports/report.json --top 2
1 run(s) (architecture) produced 6 finding(s), 2 of severity high or critical.
- Severity: 2 high, 4 medium.
- Evidence strength: 6 suspected-risk.
- [high] Outbound HTTP call without timeout: charge (src/payments-client.ts) (architecture, suspected-risk).
- [high] Retry without max attempts or backoff: charge (src/payments-client.ts) (architecture, suspected-risk).
- Run status: 1 failed.
```

### `sw history`

| Command / option | Meaning |
|---|---|
| `sw history list` | Recorded runs, newest first; `--limit <n>` (default 20), `--engine <id>`, `--json` |
| `sw history show <id>` | One run (id, unique prefix, or `baseline:<name>`); `--json` |
| `sw history diff <baseline> <current>` | Compare two runs, exit 1 on significant regressions. Each side: `id[,id…]`, `last:N`, `label:<name>[:N]` or `baseline:<name>`; `--engine <id>` (for `last:N` / `label:`), `--json` (same as `-f json`; use the global `-f tty\|json\|md\|html` for other formats) |
| `sw history baseline set <name> <run>` | Name a run as a baseline |
| `sw history baseline list` | Named baselines; `--json` |
| `sw history trend` | Metric trend with anomaly / change-point detection; `--metric <name>` (default `p95`, or e.g. `performance.http.p95`), `--endpoint <ep>` (e.g. `'GET /api/products'`), `--limit <n>`, `--json` |
| `sw history verify` | Verify report hashes and index integrity (exit 1 if corrupted); `--json` |
| `sw history prune` | Retention: keep the newest N runs; `--keep <n>` (default 50), `--no-compact` (remove pruned runs entirely instead of keeping their summary), `--json` |

### Interaction

- **Ctrl+C** once means a graceful stop and partial report. Twice means abort. The exit code is 130.
- Progress goes to stderr (never with `--quiet` or `--json`): on a terminal one line per load tick
  (rps, p95, errors, in-flight) and per stress stage; without a terminal at most one line every 5 s.

## 2. Programmatic API

```ts
import { createWorld, defineConfig } from "second-world";

const world = await createWorld({ config: "./sw.config.ts", profile: "ci" }); // or inline config object

// Each engine is a lazy getter → dynamic import on first access
const perf  = await world.performance.run({ rate: 100, duration: "30s" });       // merges with config
const arch  = await world.architecture.inspect({ project: "./" });
const bugs  = await world.bugs.run({ techniques: ["contract"] });

// Events
world.on("perf.tick", (t) => console.log(t.rps, t.p95));
world.on("finding.created", (f) => { /* ... */ });

// Cancellation
const ac = new AbortController();
setTimeout(() => ac.abort(), 10_000);
await world.performance.run({ /* ... */ }, { signal: ac.signal });

// Workflows
const result = await world.run("full-investigation");

// Reports
const report = world.report.combine([perf, arch, bugs]);
await world.report.write(report, { formats: ["json", "html"], outDir: "reports" });

// History
await world.history.save(report);
const diff = await world.history.compare({ baseline: "main", current: report });

await world.close(); // releases pools, workers, temp dirs
```

### Embedding in test runners

```ts
// vitest example: performance assertion in a test suite
import { test, expect } from "vitest";
import { createWorld } from "second-world";

test("products endpoint meets SLO", async () => {
  const world = await createWorld({ config: false });
  const r = await world.performance.run({
    target: "http://127.0.0.1:3000", model: "iterations", iterations: 500, vus: 20,
    scenarios: [{ name: "list", steps: [{ method: "GET", path: "/api/products" }] }],
  });
  expect(r.data.latency.corrected.p95).toBeLessThan(200); // ms (coordinated-omission corrected)
  await world.close();
}, 60_000);
```

## 3. Stability policy

- Public API = exports of `second-world` and documented subpaths + CLI flags + report JSON schema.
- SemVer: breaking changes only in majors. Report JSON has its own `schemaVersion` with migrations.
- `@experimental` JSDoc tag for APIs that may change in minors (e.g. Agent, Evolution in early phases).
