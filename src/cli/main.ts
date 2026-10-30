#!/usr/bin/env node
/**
 * `sw` / `second-world` CLI entry. See docs/09-cli-and-api.md §1.
 * Kept light: only commander is imported eagerly; every command loads its code with a
 * dynamic import inside its action so `sw --help` stays fast.
 */
import module from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";

try {
  (module as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch {
  // best effort
}

export const VERSION = "0.1.0-dev";

export interface GlobalOptions {
  config?: string;
  profile?: string;
  set?: string[];
  format?: string;
  out?: string;
  failOn?: string;
  seed?: string;
  label?: string;
  yes?: boolean;
  approveDisruptive?: boolean;
  dryRun?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  jsonLogs?: boolean;
  configCode?: boolean;
}

function collect(v: string, prev: string[] = []): string[] {
  return [...prev, v];
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("sw")
    .description("SECOND WORLD: software experimentation, testing and optimization engine")
    .version(VERSION, "-V, --version")
    .option("-c, --config <file>", "config path (default: auto-discover sw.config.*)")
    .option("-p, --profile <name>", "apply a config profile")
    .option("--set <key=value>", "override any config key (repeatable)", collect)
    .option("-f, --format <list>", "report formats: tty,json,md,junit,sarif,html")
    .option("-o, --out <dir>", "report output dir")
    .addOption(new Option("--fail-on <sev>", "exit 1 threshold").choices(["critical", "high", "medium", "low", "never"]))
    .option("--seed <n>", "global seed")
    .option("--label <name>", "history label for this run (also filters `history diff last:N`)")
    .option("--yes", "non-interactive approval of confirmations (logged to audit)")
    .option("--approve-disruptive", "approve disruptive actions (logged to audit)")
    .option("--dry-run", "validate config, run safety check and probe, print the plan; send nothing")
    .option("--no-color", "disable colors")
    .option("--quiet", "only errors")
    .option("--verbose", "debug logging")
    .option("--json-logs", "JSON log lines on stderr")
    .option("--no-config-code", "only load JSON/YAML configs (never execute config code)")
    .showHelpAfterError("(run `sw --help` for usage)")
    .exitOverride();

  program
    .command("doctor")
    .description("environment & capability report with fixes")
    .option("--json", "print the EnvironmentReport as JSON")
    .option("--quick", "skip external tool checks")
    .action(async (o: { json?: boolean; quick?: boolean }, cmd: Command) => {
      const { doctorCommand } = await import("./commands/doctor.js");
      return doctorCommand(o, cmd.optsWithGlobals<GlobalOptions>());
    });

  const config = program.command("config").description("config tools");
  config
    .command("print")
    .description("print the merged config (secrets masked)")
    .option("--resolved", "validated, normalised config with the origin of each key")
    .option("--json", "JSON instead of YAML")
    .action(async (o: { resolved?: boolean; json?: boolean }, cmd: Command) => {
      const { configPrint } = await import("./commands/config.js");
      return configPrint(o, cmd.optsWithGlobals<GlobalOptions>());
    });
  config
    .command("validate")
    .description("validate the config (exit 2 on error)")
    .option("--json", "machine-readable result")
    .action(async (o: { json?: boolean }, cmd: Command) => {
      const { configValidate } = await import("./commands/config.js");
      return configValidate(o, cmd.optsWithGlobals<GlobalOptions>());
    });
  config
    .command("schema")
    .description("print the config JSON Schema")
    .action(async () => {
      const { configSchema } = await import("./commands/config.js");
      return configSchema();
    });

  program
    .command("perf")
    .description("Performance Lab: latency, throughput, errors under controlled load")
    .argument("[target]", "target URL or target name from config")
    .option("-t, --target <url>", "target URL or name")
    .addOption(new Option("--model <model>", "load model").choices(["open", "closed", "iterations"]))
    .option("-r, --rate <rate>", "arrival rate (open model), e.g. 200 or 200/s")
    .option("-u, --vus <n>", "virtual users (closed/iterations)")
    .option("-i, --iterations <n>", "total iterations (iterations model)")
    .option("-d, --duration <dur>", "test duration, e.g. 30s")
    .option("--ramp-up <dur>", "ramp-up duration")
    .option("--warmup <dur>", "warm-up duration (excluded from results)")
    .option("--timeout <dur>", "request timeout")
    .addOption(new Option("--arrival <kind>", "arrival process (open model)").choices(["constant", "poisson"]))
    .option("--max-in-flight <n>", "cap on concurrent requests (open model)")
    .option("--workers <n|auto>", 'generator threads (worker_threads shards); "auto" = min(CPUs - 1, 8)')
    .option("--threshold <expr>", 'threshold, e.g. "p95<300ms" (repeatable)', collect)
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (target: string | undefined, o: Record<string, unknown>, cmd: Command) => {
      const { perfCommand } = await import("./commands/perf.js");
      return perfCommand(target, o, cmd.optsWithGlobals<GlobalOptions>());
    });

  program
    .command("stress")
    .description("Stress & Capacity Lab: step/ramp/spike/soak/breakpoint load to find tested capacity")
    .argument("[target]", "target URL or target name from config")
    .option("-t, --target <url>", "target URL or name")
    .addOption(new Option("--mode <mode>", "stress mode").choices(["step", "ramp", "spike", "soak", "breakpoint"]))
    .option("--steps <list>", "stage levels, e.g. 10,25,50,100 (VUs, or rates with --rate)")
    .option("--hold <dur>", "hold time per stage, e.g. 30s")
    .option("--settle <dur>", "settle time before each stage (load runs, excluded)")
    .option("--rate-from <rate>", "breakpoint search: lowest rate")
    .option("--rate-to <rate>", "breakpoint search: highest rate")
    .option("--step <rate>", "breakpoint search: rate step")
    .option("--min-step <rate>", "breakpoint search: bisection resolution")
    .option("-r, --rate <rate>", "base rate (soak: the soak level)")
    .option("-u, --vus <n>", "base virtual users")
    .option("-d, --duration <dur>", "soak duration")
    .option("--warmup <dur>", "warm-up before the first stage")
    .option("--timeout <dur>", "request timeout")
    .option("--threshold <expr>", 'threshold that defines a breach, e.g. "p95<300ms" (repeatable)', collect)
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (target: string | undefined, o: Record<string, unknown>, cmd: Command) => {
      const { stressCommand } = await import("./commands/stress.js");
      return stressCommand(target, o, cmd.optsWithGlobals<GlobalOptions>());
    });

  program
    .command("inspect")
    .description("Architecture Inspector: static dependency graph and risk rules (never runs project code)")
    .argument("[path]", "project root (default: config project.root or .)")
    .option("--tsconfig <file>", "tsconfig path (relative to the project)")
    .option("--rule <id=level>", "override a rule level, e.g. ARCH004=off (repeatable)", collect)
    .addOption(new Option("--graph <format>", "print the dependency graph instead of the report").choices(["dot", "mermaid", "json"]))
    .addOption(new Option("--view <view>", "graph view").choices(["components", "modules", "all"]))
    .option("--no-cache", "ignore and do not write the analysis cache")
    .option("--cache-dir <dir>", "analysis cache directory")
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (path: string | undefined, o: Record<string, unknown>, cmd: Command) => {
      const { inspectCommand } = await import("./commands/inspect.js");
      return inspectCommand(path, o, cmd.optsWithGlobals<GlobalOptions>());
    });

  program
    .command("bugs")
    .description("API Bug Hunter: contract, boundary, property, stateful, concurrency and auth testing")
    .option("-t, --target <url>", "target URL or name")
    .option("--openapi <file>", "OpenAPI contract (default: bugs.contract from config; absent → discovery)")
    .option("--techniques <list>", "contract,boundary,equivalence,pairwise,property,negative,stateful,concurrency,auth")
    .option("--replays <n>", "replays per failing case (classification)")
    .option("--max-replays <n>", "upper bound on replays (flaky cases)")
    .option("--property-runs <n>", "property-based runs per operation")
    .option("--include <ops>", 'only operations, e.g. "GET /products/*" (repeatable)', collect)
    .option("--exclude <ops>", "skip operations (repeatable)", collect)
    .option("--allow-mutations", "send POST/PUT/PATCH/DELETE (also needs approval: --yes or safety.allowMutations)")
    .option("--concurrency-test <op>", 'concurrency burst on an operation, e.g. "POST /orders" (repeatable)', collect)
    .option("--burst <n>", "parallel requests per concurrency burst (default 10)")
    .option("--invariant <spec>", "linearizable:<stock|counter|register|set>[:initial] | max-success:<n> | same-response | ./module.ts")
    .option("--role <name>", "auth role for concurrency bursts")
    .option("--body <json>", "request body for concurrency bursts")
    .option(
      "--mix <spec>",
      'interleave another operation with each burst (repeatable): "METHOD /path[:count] [as=take|read|inc|dec|write|add|remove|has] [count=n] [phase=before|during|after] [pointer=/ptr] [value=v] [role=r] [<pathParam>=v] [query.k=v] [header.k=v] [body=<json>]"; as defaults to read for GET',
      collect,
    )
    .option("--timeout <dur>", "request timeout")
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (o: Record<string, unknown>, cmd: Command) => {
      const { bugsCommand } = await import("./commands/bugs.js");
      return bugsCommand(o, cmd.optsWithGlobals<GlobalOptions>());
    });

  program
    .command("agent")
    .description("Adversarial Test Agent: proposes, validates and runs extra API test cases (QA test-case generator)")
    .option("-t, --target <url>", "target URL or name (default: agent/bugs target)")
    .option("--openapi <file>", "OpenAPI contract (default: agent/bugs contract)")
    .addOption(new Option("--bandit <kind>", "arm selection").choices(["ucb1", "thompson"]))
    .option("--budget <spec>", "requests=N,iterations=N,time=30s,patience=N (also rps=, concurrency=)")
    .option("--techniques <list>", "status-gap,param-gap,boundary,idempotency,idempotency-concurrent,ownership,privilege,lifecycle,concurrency,history,arch-risk")
    .option("--include <ops>", 'only operations, e.g. "GET /orders/*" (repeatable)', collect)
    .option("--exclude <ops>", "skip operations (repeatable)", collect)
    .option("--allow-mutations", "send POST/PUT/PATCH (also needs --yes or safety.allowMutations)")
    .option("--allow-destructive", "allow destructive operations (DELETE, …); requires --yes")
    .option("--context <report>", "earlier report.json (bugs / inspect / agent) to seed hypotheses (repeatable)", collect)
    .option("--export-tests <dir>", "write a Vitest file per confirmed defect into <dir>")
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (o: Record<string, unknown>, cmd: Command) => {
      const { agentCommand } = await import("./commands/agent.js");
      return agentCommand(o, cmd.optsWithGlobals<GlobalOptions>());
    });

  program
    .command("replay")
    .description("re-run a recorded Bug Hunter reproduction (exit 1 if it still reproduces)")
    .argument("<fingerprint>", "finding fingerprint or unique prefix")
    .option("--runs <n>", "number of replays")
    .option("-t, --target <url>", "target URL or name (default: from config)")
    .option("--openapi <file>", "OpenAPI contract")
    .option("--json", "JSON output")
    .action(async (fp: string, o: Record<string, unknown>, cmd: Command) => {
      const { replayCommand } = await import("./commands/bugs.js");
      return replayCommand(fp, o, cmd.optsWithGlobals<GlobalOptions>());
    });

  const reliability = program.command("reliability").description("Reliability Lab: fault injection experiments");
  const rel = () => import("./commands/reliability.js");
  reliability
    .command("list")
    .description("built-in fault scenarios")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await rel()).reliabilityList(o, cmd.optsWithGlobals<GlobalOptions>()));
  reliability
    .command("run")
    .description("run a fault scenario (disruptive: needs --approve-disruptive / --yes)")
    .argument("<scenario>", "scenario id, e.g. dependency-latency (see `sw reliability list`)")
    .option("-t, --target <url>", "target URL or name")
    .option("--dependency <name>", "dependency to degrade (key of reliability.dependencies)")
    .option("-d, --duration <dur>", "fault duration, e.g. 10s")
    .option("--steady-phase <dur>", "steady-state phase before the fault")
    .option("--recovery <dur>", "recovery phase after the fault")
    .option("--steady <expr>", 'steady-state condition, e.g. "p95<300ms" (repeatable)', collect)
    .option("--hypothesis <expr>", 'hypothesis during the fault, e.g. "error_rate<5%" (repeatable)', collect)
    .option("--param <k=v>", "scenario parameter, e.g. latencyMs=500 (repeatable)", collect)
    .option("-r, --rate <n>", "workload rate (requests/s)")
    .option("--route <name=METHOD /path>", 'workload route, e.g. orders="POST /orders" (repeatable)', collect)
    .option("--repeat <n>", "repeat the experiment N times (reproduced-defect needs ≥ 2)")
    .option("--abort-error-rate <pct>", "abort when the error rate exceeds this, e.g. 50%")
    .option("--allow-production", "allow fault injection when environment is production (still needs approval)")
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (scenario: string, o: Record<string, unknown>, cmd: Command) =>
      (await rel()).reliabilityRun(scenario, o, cmd.optsWithGlobals<GlobalOptions>()),
    );
  reliability
    .command("cleanup")
    .description("revert leftover faults (in-process stack + persistent ledger)")
    .option("--ledger <file>", "fault ledger path (default $SW_FAULT_LEDGER or <tmp>/second-world/fault-ledger.json)")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await rel()).reliabilityCleanup(o, cmd.optsWithGlobals<GlobalOptions>()));

  program
    .command("whatif")
    .description("What-If: compare a baseline and variants with interleaved, repeated runs and statistics")
    .argument("<experiment>", "name in whatif.experiments, or a .ts/.js/.json/.yaml file exporting experiment({...})")
    .option("--repetitions <n>", "runs per arm (≥ 5 recommended)")
    .addOption(new Option("--order <order>", "run order").choices(["interleaved", "randomized-blocks", "sequential"]))
    .addOption(new Option("--lifecycle <l>", "app lifecycle").choices(["per-run", "per-arm"]))
    .option("--aa", "A/A run (baseline vs itself) to measure the noise floor")
    .option("--metric <name>", "metric to compare, e.g. p95 (repeatable)", collect)
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (exp: string, o: Record<string, unknown>, cmd: Command) => {
      const { whatifCommand } = await import("./commands/experiments.js");
      return whatifCommand(exp, o, cmd.optsWithGlobals<GlobalOptions>());
    });

  program
    .command("evolve")
    .description("Evolution: build, test and benchmark candidate changes in sandboxes; rank them (Pareto)")
    .option("--candidates <list>", "branch:a,commit:sha,patch:./c.diff (repeatable)", collect)
    .option("--test <cmd>", 'test gate, e.g. "npm test" (split without a shell)')
    .option("--start <cmd>", 'start command, e.g. "npm run start:test"')
    .option("--build <cmd>", "build gate")
    .option("--health <path>", "readiness path, e.g. /healthz")
    .option("--repetitions <n>", "benchmark repetitions per arm")
    .option("--repo <dir>", "git repository to evolve (default: the config directory)")
    .option("--baseline <ref>", "baseline git ref (default HEAD)")
    .option("--finding <id>", "finding this evolution targets")
    .addOption(new Option("--sandbox <kind>", "sandbox (process needs --yes)").choices(["auto", "docker", "process"]))
    .option("--replay <artifact>", "Bug Hunter reproduction artifact to replay as a gate (repeatable)", collect)
    .option("--metric <name>", "metric to rank by (repeatable)", collect)
    .option("--json", "print the combined report JSON on stdout")
    .option("--no-history", "do not save this run to history")
    .action(async (o: Record<string, unknown>, cmd: Command) => {
      const { evolveCommand } = await import("./commands/experiments.js");
      return evolveCommand(o, cmd.optsWithGlobals<GlobalOptions>());
    });

  const model = program.command("model").description("System Model: one graph from code, contracts, config and telemetry");
  const mod = () => import("./commands/model.js");
  model
    .command("build")
    .description("build the model and save a snapshot (.second-world/model/latest.json)")
    .argument("[path]", "project root (default: config project.root)")
    .option("--openapi <file>", "OpenAPI contract (default: bugs.contract from config)")
    .option("--config-file <file>", "infra/config file to include, e.g. docker-compose.yml (repeatable)", collect)
    .option("--no-discover", "do not auto-discover config files")
    .option("--traces <file>", "OTLP traces or metrics: JSON/JSONL or protobuf (.pb) files (repeatable)", collect)
    .option("--prometheus <file|url>", "Prometheus text exposition (repeatable)", collect)
    .option("--receive <seconds>", "run a local OTLP/HTTP JSON receiver for N seconds and include what it gets")
    .option("--service-name <name>", "primary service name")
    .addOption(new Option("--detail <level>", "node detail").choices(["components", "full"]))
    .option("--no-architecture", "skip the static architecture source")
    .option("--from-history", "reuse the latest architecture run from history instead of re-inspecting")
    .option("--no-cache", "ignore the architecture analysis cache")
    .option("--cache-dir <dir>", "architecture analysis cache directory")
    .addOption(new Option("--graph <fmt>", "print the graph instead of the summary").choices(["dot", "mermaid", "json"]))
    .option("--json", "canonical JSON")
    .option("--no-history", "do not save this build to history")
    .action(async (path: string | undefined, o: Record<string, unknown>, cmd: Command) =>
      (await mod()).modelBuild(path, o, cmd.optsWithGlobals<GlobalOptions>()),
    );
  model
    .command("show")
    .description("show a model snapshot")
    .argument("[snapshot]", "snapshot path or 'latest'", "latest")
    .addOption(new Option("--graph <fmt>", "print the graph").choices(["dot", "mermaid", "json"]))
    .option("--node <id>", "neighbourhood / impact / reaching routes of one node")
    .option("--k <n>", "neighbourhood hops (default 2)")
    .option("--json", "canonical JSON")
    .action(async (snap: string, o: Record<string, unknown>, cmd: Command) => (await mod()).modelShow(snap, o, cmd.optsWithGlobals<GlobalOptions>()));
  model
    .command("diff")
    .description("compare two model snapshots (informational, exit 0)")
    .argument("<before>", "snapshot path or 'latest'")
    .argument("<after>", "snapshot path or 'latest'")
    .option("--json", "JSON output")
    .action(async (a: string, b: string, o: Record<string, unknown>, cmd: Command) => (await mod()).modelDiff(a, b, o, cmd.optsWithGlobals<GlobalOptions>()));

  program
    .command("analyze")
    .description("deterministic summary over previous reports: counts, strongest evidence, top findings (no AI, no network)")
    .argument("[reports...]", "report.json files from previous runs")
    .option("--last", "include the latest run in history")
    .option("--top <n>", "number of top findings to list (default 5)")
    .option("--json", "JSON output")
    .action(async (reports: string[], o: Record<string, unknown>, cmd: Command) => {
      const { analyzeCommand } = await import("./commands/analyze.js");
      return analyzeCommand(reports, o, cmd.optsWithGlobals<GlobalOptions>());
    });

  const history = program.command("history").description("experiment history: list, compare, trend, verify");
  const hist = () => import("./commands/history.js");
  history
    .command("list")
    .description("recorded runs, newest first")
    .option("--limit <n>", "max runs", "20")
    .option("--engine <id>", "only runs of this engine")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await hist()).historyList(o, cmd.optsWithGlobals<GlobalOptions>()));
  history
    .command("show")
    .description("show one run")
    .argument("<id>", "run id, unique prefix, or baseline:<name>")
    .option("--json", "JSON output")
    .action(async (id: string, o, cmd: Command) => (await hist()).historyShow(id, o, cmd.optsWithGlobals<GlobalOptions>()));
  history
    .command("diff")
    .description("compare two runs (exit 1 on significant regressions)")
    .argument("<baseline>", "id[,id…] | last:N | label:<name>[:N] | baseline:<name>")
    .argument("<current>", "id[,id…] | last:N | label:<name>[:N] | baseline:<name>")
    .option("--engine <id>", "only runs of this engine (for last:N / label:)")
    .option("--json", "JSON output (same as -f json); use the global -f tty|json|md|html for other formats")
    .action(async (a: string, b: string, o, cmd: Command) => (await hist()).historyDiff(a, b, o, cmd.optsWithGlobals<GlobalOptions>()));
  const baseline = history.command("baseline").description("named baselines");
  baseline
    .command("set")
    .argument("<name>", "baseline name, e.g. main")
    .argument("<run>", "run id or prefix")
    .action(async (name: string, run: string, _o, cmd: Command) =>
      (await hist()).historyBaselineSet(name, run, cmd.optsWithGlobals<GlobalOptions>()),
    );
  baseline
    .command("list")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await hist()).historyBaselineList(o, cmd.optsWithGlobals<GlobalOptions>()));
  history
    .command("trend")
    .description("metric trend with anomaly / change-point detection")
    .option("--metric <name>", "metric, e.g. p95 or performance.http.p95", "p95")
    .option("--endpoint <ep>", "endpoint, e.g. 'GET /api/products'")
    .option("--limit <n>", "last N runs")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await hist()).historyTrend(o, cmd.optsWithGlobals<GlobalOptions>()));
  history
    .command("verify")
    .description("verify report hashes and index integrity (exit 1 if corrupted)")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await hist()).historyVerify(o, cmd.optsWithGlobals<GlobalOptions>()));
  history
    .command("prune")
    .description("retention: keep the newest N runs")
    .option("--keep <n>", "runs to keep (default 50)")
    .option("--no-compact", "remove pruned runs entirely instead of keeping their summary")
    .option("--json", "JSON output")
    .action(async (o, cmd: Command) => (await hist()).historyPrune(o, cmd.optsWithGlobals<GlobalOptions>()));

  program
    .command("init")
    .description("detect the project and write sw.config.ts with local-only safety defaults")
    .option("--force", "overwrite an existing config")
    .option("--target <url>", "service URL (default http://127.0.0.1:3000)")
    .option("--json", "print what was written / detected as JSON")
    .action(async (o: { force?: boolean; json?: boolean; target?: string }, cmd: Command) => {
      const { initCommand } = await import("./commands/init.js");
      return initCommand(o, cmd.optsWithGlobals<GlobalOptions>());
    });

  return program;
}

/** Runs the CLI and returns the exit code (never calls process.exit itself). */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return 0;
      // usage errors (unknown option, bad choice, missing argument) → config/usage error
      return 2;
    }
    const { reportError } = await import("./output.js");
    return reportError(e, { color: !argv.includes("--no-color") && !process.env.NO_COLOR });
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href || import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => {
      process.exitCode = code;
      // let stdout drain; force exit if handles keep the loop alive (sockets, timers)
      setTimeout(() => process.exit(code), 50).unref();
    },
    (e: unknown) => {
      process.stderr.write(`internal error: ${String(e)}\n`);
      process.exit(70);
    },
  );
}
