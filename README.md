# SECOND WORLD

SECOND WORLD is a TypeScript/Node toolkit for testing and improving HTTP services before changes reach
production. It loads a service, inspects its code, hunts API bugs, injects faults and records every run.
Each capability is an independent **engine**. All engines share one config, one safety layer, one
evidence model (findings classified on a [trust ladder](docs/01-vision-and-principles.md#5-finding-classification-the-trust-ladder))
and one run history.

SECOND WORLD is fully deterministic: no AI or LLM is used anywhere. Every result comes from measurement,
analysis or code, and the same inputs and seed give the same results.

| Engine | Command | What it does |
|---|---|---|
| Performance Lab | `sw perf` | Latency/throughput/errors under controlled load (open, closed, iterations models; coordinated-omission correction) |
| Stress & Capacity Lab | `sw stress` | Step/ramp/spike/soak/breakpoint load; reports *tested* capacity and the first breach |
| Architecture Inspector | `sw inspect` | Static dependency graph + risk rules (never runs project code) |
| API Bug Hunter | `sw bugs`, `sw replay` | Contract, boundary, property, stateful, concurrency and auth testing with replayed reproductions |
| Reliability Lab | `sw reliability` | Fault injection (built-in proxy; Toxiproxy/Docker adapters) with steady-state hypotheses |
| System Model | `sw model` | One graph from code, contracts, config and telemetry (OTLP JSON, Prometheus) |
| What-If / Evolution | `sw whatif`, `sw evolve` | Statistical A/B of variants; sandboxed candidate changes ranked by Pareto |
| Summary | `sw analyze` | Deterministic summary across earlier reports: counts by severity and classification, top findings, invalidating limitations |
| Experiment History | `sw history` | JSONL run store, baselines, diffs with statistics, trends |

Status: `0.1.0-dev`, not yet published to npm (see [Install](#install)). The full specification is in [`docs/`](docs/README.md).

## Install

Requirements: **Node.js ≥ 22.19** (`engines` in package.json), git. Windows, macOS and Linux are supported.
`typescript` is an optional peer dependency: install `typescript@6` (5.x also works) next to SECOND WORLD to use
`sw inspect` and the static part of `sw model build`. Without it those commands exit 4 with an install hint and
everything else works; `sw doctor` tells you which case you are in.

SECOND WORLD is **not on the npm registry yet**. Build the package tarball once from a clone
(`npm pack` builds `dist/` first):

```bash
git clone <this repo> second-world && cd second-world
npm ci
npm pack                         # → second-world-0.1.0-dev.tgz
```

Then pick one way to install it (paths below are relative to wherever you put the tarball):

| How | Command | Run it as |
|---|---|---|
| Project devDependency (recommended) | `npm i -D ./second-world-0.1.0-dev.tgz` | `npx sw doctor` |
| Global | `npm i -g ./second-world-0.1.0-dev.tgz` | `sw doctor` |
| One-off, no install | `npx --yes --package ./second-world-0.1.0-dev.tgz sw doctor` | — |
| Docker | `docker build -t second-world .` (in the clone) | `docker run --rm second-world doctor` |
| GitHub Actions | `uses: <owner>/second-world@<ref>` ([below](#github-actions)) | — |

Once a release is published to npm, the same commands work with the package name: `npm i -D second-world`,
`npm i -g second-world`, `npx second-world doctor`.

A first run in a new project:

```bash
npx sw doctor          # Node, CPUs, git/docker, config found?, typescript installed?
npx sw init            # writes sw.config.ts (local-only safety defaults) and ignores .second-world/
npx sw perf            # load-tests targets.api from sw.config.ts (start your service first)
```

### Docker

The image (`Dockerfile`: multi-stage, `node:22-bookworm-slim`, runs as the non-root `node` user, contains only
`dist/`, production dependencies and `typescript`) has `sw` as its entrypoint and `/work` as its working directory.
Mount your project there to use its `sw.config.ts`:

```bash
docker build -t second-world .
docker run --rm second-world --version
docker run --rm -v "$PWD:/work" second-world inspect
```

Inside a container, `127.0.0.1` is the container itself. To test an app running on your machine:

- **Docker Desktop (Windows, macOS):** use `http://host.docker.internal:<port>`, and add that host to the
  Safety Guard allow-list — it is a private host, so without it the run is refused with exit 3:
  `docker run --rm second-world --set 'safety.allowHosts=["host.docker.internal"]' perf http://host.docker.internal:3000`
  (or put `"host.docker.internal"` in `safety.allowHosts` in your config).
- **Linux:** `docker run --rm --network host second-world perf http://127.0.0.1:3000` shares the host network,
  so loopback works with the default allow-list. Add `--user "$(id -u):$(id -g)"` when you mount a project, so
  reports in `.second-world/` are written as your user.

### GitHub Actions

`action.yml` is a composite action: it sets up Node, runs one `sw` command (the project's installed `sw`, or
`npx --package <package> sw`), always writes `report.json` and `report.sarif`, optionally uploads the SARIF to
code scanning, and then fails the step with sw's exit code. Start your service in an earlier step.

```yaml
permissions:
  contents: read
  security-events: write          # only needed for upload-sarif
steps:
  - uses: actions/checkout@v4
  - run: npm ci
  - run: npm start &                    # your service; make sure it is ready before the next step
  - uses: <owner>/second-world@<ref>
    with:
      command: bugs                       # perf, stress, inspect, "reliability run <scenario>", ...
      config: sw.config.ts                # optional; default: auto-discover
      target: http://127.0.0.1:3000       # optional; passed as --target
      args: --fail-on high --no-history   # optional extra arguments (split on spaces)
      upload-sarif: "true"
```

Other inputs: `sarif-category`, `out-dir` (default `.second-world/action-report`), `working-directory`,
`package` (npm spec or `.tgz` used when the project does not have second-world installed), `node-version`
(default `24.x`). Outputs: `exit-code`, `report-dir`, `sarif-file`.

### From source

```bash
# bash / zsh
sw() { npx tsx /path/to/second-world/src/cli/main.ts "$@"; }
sw --version          # 0.1.0-dev
```

```powershell
# PowerShell: npx.cmd, because npx.ps1 does not forward @args
function sw { npx.cmd tsx C:\path\to\second-world\src\cli\main.ts @args }
```

## 5-minute quickstart

The repo ships two example apps with documented, seeded defects: `examples/shop-express` and
`examples/shop-fastify`. Start shop-express and its payment dependency from the repo root,
in two terminals:

```bash
npx tsx examples/payments-fake/src/server.ts     # http://127.0.0.1:4010
npx tsx examples/shop-express/src/server.ts      # http://127.0.0.1:3000
```

Work in a copy of the example (it includes a ready-made `sw.config.ts`), so reports and history stay out of the repo:

```bash
cp -r examples/shop-express ~/sw-shop && cd ~/sw-shop
sw doctor --quick                 # environment check
sw perf --duration 10s            # load test: thresholds pass → exit 0
sw inspect                        # static analysis: 6 suspected risks → exit 1
sw --yes bugs --allow-mutations   # API bug hunt: BOLA, ignored idempotency key, schema drift, 500 on boundary → exit 1
sw analyze --last                 # deterministic summary of the newest run → exit 0
sw history list                   # every run above, with status, findings and p95
```

```text
$ sw perf --duration 10s
✔ PASS (exit 0, fail-on high) completed: no failing thresholds or findings at or above 'high'
[performance] passed 12.0s
target http://127.0.0.1:3000  model open/constant  measured 10.0s  stop completed
│ requests │  ok │ failed │  rps │ error rate │    p50 │   p95 │   p99 │   max │
│      903 │ 903 │      0 │ 90.3 │      0.00% │ 8.65ms │ 144ms │ 164ms │ 181ms │

$ sw history list
ID                          CREATED                   LABEL     STATUS    FINDINGS  P95(ms)
01M62NCKWYKW4JP6SD27VJXBFQ  2026-10-29T01:46:28.638Z  bugs      failed    6         -
01M62NC6DBQ8K5QV9REC1H63R3  2026-10-29T01:46:14.827Z  inspect   failed    6         -
01M62NC146GK6C32S1RCHNBZ9Q  2026-10-29T01:46:09.414Z  perf      passed    0         144
```

[`docs/quickstart.md`](docs/quickstart.md) is the full walkthrough, covering `sw init`, stress,
fault injection, cross-run summaries and statistical history diffs, with captured output.

## Commands

Global flags go **before** the command (`sw --yes bugs …`, `sw --dry-run perf`). Run `sw <command> --help` for every option.

| Command | Description |
|---|---|
| `sw doctor [--json] [--quick]` | Environment & capability report with fixes |
| `sw init [--force] [--target <url>]` | Detect the project; write `sw.config.ts` with local-only safety defaults; add `.second-world/` to `.gitignore` |
| `sw config print\|validate\|schema` | Print the merged config (secrets masked), validate it (exit 2 on error), print the JSON Schema |
| `sw perf [target]` | Performance Lab: latency, throughput, errors under controlled load (`--model open\|closed\|iterations`, `--rate`, `--vus`, `--duration`, `--threshold`) |
| `sw stress [target]` | Stress & Capacity Lab: `--mode step\|ramp\|spike\|soak\|breakpoint`; reports tested capacity |
| `sw inspect [path]` | Architecture Inspector: dependency graph + risk rules; `--graph dot\|mermaid\|json` |
| `sw bugs` | API Bug Hunter: contract, boundary, equivalence, pairwise, property, negative, stateful, concurrency, auth |
| `sw replay <fingerprint>` | Re-run a recorded Bug Hunter reproduction (exit 1 if it still reproduces) |
| `sw agent` | Adversarial Test Agent: heuristic planner + bandit (`--bandit ucb1\|thompson`) proposes, validates and runs extra API test cases (in development) |
| `sw reliability list\|run <scenario>\|cleanup` | Reliability Lab: list fault scenarios, run one (needs `--approve-disruptive`), revert leftover faults |
| `sw model build\|show\|diff` | System Model: build/save a graph snapshot, show it (`--graph`, `--node`), diff two snapshots |
| `sw whatif <experiment>` | What-If: baseline vs variants with interleaved, repeated runs and statistics (`--aa` for an A/A noise floor) |
| `sw evolve` | Evolution: build, test and benchmark candidate changes in sandboxes; rank them (Pareto) |
| `sw analyze [reports...] [--last] [--top N] [--json]` | Deterministic summary across `report.json` files and/or the latest history run: counts by severity and classification, top findings, run statuses, invalidating limitations. No network; exit 0 (2 if no readable report) |
| `sw history list\|show\|diff\|baseline\|trend\|verify\|prune` | Run history: list, show, compare (`id[,id…]`, `last:N`, `label:<name>[:N]`, `baseline:<name>`; statistics with ≥ 5 runs per side), named baselines, trends, integrity check, retention |

Global flags: `-c/--config`, `-p/--profile`, `--set key=value`, `-f/--format`, `-o/--out`, `--fail-on`,
`--seed`, `--label`, `--yes`, `--approve-disruptive`, `--dry-run`, `--no-color`, `--quiet`, `--verbose`,
`--json-logs`, `--no-config-code`. Most engine commands also take `--json` (the combined report on stdout)
and `--no-history`.

Not implemented yet (described in [docs/09](docs/09-cli-and-api.md)): `sw report`, `sw run <workflow>`, `sw plugins`.
Workflows are available via the API (`world.run(name)`).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Completed; no failing thresholds or findings at or above `--fail-on` (default `high`) |
| 1 | Completed with failures: thresholds breached or findings ≥ `--fail-on`; `history diff` with a significant regression; `replay` still reproduces |
| 2 | Invalid configuration or arguments |
| 3 | Blocked or stopped by the safety guard (e.g. host not allowed, requested rate above `safety.maxRps`, DNS rebinding detected mid-run) |
| 4 | Required capability missing |
| 5 | Target unreachable / pre-flight failed / nothing could be measured (e.g. the app under test never started) |
| 70 | Internal error (a bug in SECOND WORLD) |
| 130 | Cancelled (Ctrl+C: first press stops gracefully and writes a partial report, the second aborts) |

## Reports

`-f tty,json,md,junit,sarif,html` (config `report.formats`, default `tty,json`). Files go to `-o <dir>`
(default `.second-world/reports/`) as `report.json`, `report.md`, `report.junit.xml`, `report.sarif` and
`report.html`. `tty` is printed, never written. Each run overwrites the files in its output dir, so use
`-o` per run to keep them. Every report lists what could not be determined (limitations), and every
finding carries its trust-ladder classification: `hypothesis` < `suspected-risk` < `observation` <
`threshold-breach` < `reproduced-defect` < `verified-fix`.

## Safety defaults

- Targets: loopback only. Private hosts must be listed in `safety.allowHosts`. Public hosts additionally need
  `safety.allowPublic: true` and confirmation. DNS is pinned at pre-flight, and rebinding aborts the run.
- Budgets: `safety.maxRps`, `maxConcurrency`, `maxRequests`, `maxDuration`. A requested rate above `maxRps` is
  refused (exit 3), and closed/VU load is throttled to it.
- Mutating requests (Bug Hunter, Agent) are off unless you opt in once: `--allow-mutations` / `bugs.allowMutations` / `safety.allowMutations`, `environment: isolated|staging`, or an approval (`--yes`, or confirming interactively). Every opt-in is recorded in the audit log.
  Fault injection needs `--approve-disruptive`. Approvals are written to `.second-world/audit.log`.
- Faults are always reverted (cleanup stack, TTL, ledger). `sw reliability cleanup` reverts leftovers.
- Secrets: write `{ env: "NAME" }` / `{ file: "path" }` in configs. Resolved values are redacted from logs,
  reports and dry-run output. Bug reproductions use `$SW_AUTH_<ROLE>` placeholders.
- `sw inspect` never executes project code. `--no-config-code` loads only JSON/YAML configs.
- Nothing is sent to any external service: there is no AI and no phone-home.

## Programmatic API

```ts
import { createWorld } from "second-world"; // from source: import from "<repo>/src/index.ts"

const world = await createWorld({
  config: { targets: { api: { url: "http://127.0.0.1:3000" } }, safety: { allowHosts: ["127.0.0.1"] } },
});
world.on("finding.created", (f) => console.log("finding:", (f as { title: string }).title));
const r = await world.performance.run({
  model: "iterations", iterations: 200, vus: 10,
  scenarios: [{ name: "list", steps: [{ method: "GET", path: "/products" }] }],
  thresholds: { "http.p95": "< 500ms" },
});
console.log(r.status, (r.data as any).latency.corrected.p95.toFixed(1), "ms p95"); // passed 16.4 ms p95
await world.close();
```

Other handles: `world.stress`, `world.bugs`, `world.reliability`, `world.architecture.inspect()`,
`world.whatif`, `world.evolution`, `world.engine("model")`, `world.history`,
`world.run(workflowName)` (a DAG from `config.workflows`), `world.cancel()`. See [docs/09](docs/09-cli-and-api.md).

## Development

```bash
npx vitest run --project unit                         # unit tests (parallel)
npx vitest run --project integration                  # integration, e2e, examples and system tests (serial files)
npx vitest run --project integration tests/system     # cross-engine system tests (~2–3 min)
npx tsc --noEmit                                      # type check
```

## Documentation

| | |
|---|---|
| [Quickstart walkthrough](docs/quickstart.md) | Every engine on shop-express, with real output |
| [Vision & principles](docs/01-vision-and-principles.md) | Rules, trust ladder |
| [Architecture](docs/02-architecture.md) | Engines, orchestrator, evidence model |
| [Engines](docs/03-engines/README.md) | One page per engine |
| [Configuration](docs/08-configuration.md) | `sw.config.ts` reference |
| [CLI & API](docs/09-cli-and-api.md) | Flags, commands, programmatic API |
| [Safety, security & privacy](docs/11-safety-security-privacy.md) | Guard, budgets, redaction, audit |
| [Testing & quality](docs/12-testing-and-quality.md) | How SECOND WORLD itself is tested |
| [Roadmap](docs/13-roadmap.md) | Phases and acceptance criteria |
| [All docs](docs/README.md) | Index |

Use SECOND WORLD only against systems you own or are explicitly authorised to test.
