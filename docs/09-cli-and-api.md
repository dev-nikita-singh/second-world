# 09 — CLI & Programmatic API

## 1. CLI

Binary names: `sw` and `second-world`.

### Global flags

| Flag | Meaning |
|---|---|
| `-c, --config <file>` | Config path (default: auto-discover) |
| `-p, --profile <name>` | Apply a profile |
| `--set key=value` | Override any config key (repeatable) |
| `-f, --format <list>` | `tty,json,md,junit,sarif,html` |
| `-o, --out <dir>` | Report output dir |
| `--fail-on <sev>` | Exit 1 threshold: `critical\|high\|medium\|low\|never` |
| `--seed <n>` | Global seed |
| `--yes` / `--approve-disruptive` | Non-interactive approvals (logged to audit) |
| `--dry-run` | Validate config, run the safety check and probe, print the plan. Sends nothing |
| `--no-color`, `--quiet`, `--verbose`, `--json-logs` | Output control |
| `--no-config-code` | Only load JSON/YAML configs |

### Commands

| Command | Description |
|---|---|
| `sw init` | Interactive wizard: detect framework, OpenAPI, start script. Writes `sw.config.ts` and `.second-world/` gitignore entries |
| `sw doctor` | Environment & capability report with fixes |
| `sw perf` | Performance Lab |
| `sw stress` | Stress & Capacity Lab (`--mode step\|ramp\|spike\|soak\|breakpoint`) |
| `sw inspect [path]` | Architecture Inspector (`--graph dot\|mermaid\|json`) |
| `sw bugs` | API Bug Hunter |
| `sw agent` | Adversarial Test Agent: heuristic planner + bandit (`--bandit ucb1\|thompson`, `--budget`) |
| `sw reliability list\|run <scenario>` | Reliability Lab |
| `sw model build\|show\|diff` | System Model |
| `sw whatif <experiment>` | What-If Engine |
| `sw evolve` | Evolution Engine |
| `sw analyze [reports...]` | Deterministic summary across earlier reports (`--last`, `--top N`, `--json`); see below |
| `sw report merge\|render <files>` | Combine/convert reports |
| `sw history list\|show\|diff\|baseline\|trend\|verify\|prune` | Experiment History |
| `sw replay <findingId>` | Re-run a recorded reproduction |
| `sw run [workflow]` | Run a configured multi-engine workflow |
| `sw config print\|schema\|validate` | Config tools |
| `sw plugins list` | Show loaded plugins & their contributions |

### `sw analyze`: summary across reports

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

### Interaction

- **Ctrl+C** once means a graceful stop and partial report. Twice means abort. The exit code is 130.
- Live TTY dashboard: current rps vs target, p50/p95/p99 sparkline, errors, in-flight, generator health, ETA.
- Non-TTY: one summary line every 5 s, then the final report.

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
