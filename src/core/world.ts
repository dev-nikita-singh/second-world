/**
 * World facade — the programmatic API. See docs/09-cli-and-api.md §2 and docs/02-architecture.md §4.
 *
 *   const world = await createWorld({ config: "./sw.config.ts", profile: "ci" });
 *   const r = await world.performance.run({ rate: 100, duration: "30s" }, { signal });
 *   world.on("perf.tick", fn); await world.close();
 *
 * Engines are loaded lazily through the registry. The world owns the root AbortController,
 * the event bus, evidence store, safety guard (from config.safety) and logger.
 */
import { join, resolve as resolvePath } from "node:path";
import { ulid } from "ulid";
import { systemClock } from "./clock.js";
import { collectSecretValues, loadConfig, type ResolvedConfig, resolveSecret } from "./config/loader.js";
import type { SecretRef } from "./config/schema.js";
import { parseDuration, parseRate } from "./config/units.js";
import { createEngineContext, stubEnvironmentReport } from "./context.js";
import { ConfigError, EngineError, isSecondWorldError } from "./errors.js";
import { createEventBus, type TypedEventBus } from "./events.js";
import type { EngineId, EngineResult } from "./evidence/schemas.js";
import { createEvidenceStore, type EvidenceStoreEx } from "./evidence/store.js";
import { createLogger, silentLogger } from "./log/logger.js";
import { createRedactor, type Redactor } from "./log/redact.js";
import { runWorkflow, type WorkflowResult } from "./orchestrator.js";
import { probeEnvironment } from "./probe/probe.js";
import { createRegistry, type EngineLoader, type EngineRegistry } from "./registry.js";
import { createSafetyGuard, type SafetyGuardEx } from "./safety/guard.js";
import type { Clock, EngineContext, EnvironmentReport, Logger, LogLevel } from "./types.js";

export interface CreateWorldOptions {
  /** Config path, inline config object, or `false` for no config file (defaults only). Default: auto-discover. */
  config?: string | false | Record<string, unknown>;
  cwd?: string;
  profile?: string;
  set?: string[];
  overrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  noConfigCode?: boolean;
  /** Load the per-user config. Default true (false when config === false). */
  userConfig?: boolean;
  /** Allow interactive approval prompts (CLI on a TTY). Default false. */
  interactive?: boolean;
  /** --yes / --approve-disruptive */
  approve?: boolean;
  seed?: number;
  logger?: Logger;
  logLevel?: LogLevel;
  signal?: AbortSignal;
  /** Audit JSONL path; default `<cwd>/.second-world/audit.log` for file configs, none for `config: false`. `false` disables. */
  auditFile?: string | false;
  /** Probe the environment at creation (cheap mode). Default true. */
  probe?: boolean;
  clock?: Clock;
  /** Extra / replacement engine loaders (tests, plugins). */
  engines?: Record<string, EngineLoader>;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export interface EngineHandle<I = Record<string, unknown>, D = unknown> {
  run(input?: I, opts?: RunOptions): Promise<EngineResult<D>>;
}

export interface World {
  readonly config: ResolvedConfig;
  readonly events: TypedEventBus;
  readonly evidence: EvidenceStoreEx;
  readonly safety: SafetyGuardEx;
  readonly log: Logger;
  readonly env: EnvironmentReport;
  readonly registry: EngineRegistry;
  readonly redactor: Redactor;
  readonly signal: AbortSignal;
  readonly performance: EngineHandle;
  readonly stress: EngineHandle;
  readonly bugs: EngineHandle;
  readonly reliability: EngineHandle;
  readonly whatif: EngineHandle;
  /** Adversarial Test Agent (bugs-derived input + `agent` section). */
  readonly agent: EngineHandle;
  /** System Model: build from static + runtime sources; diff two ModelData snapshots. */
  readonly model: {
    build(input?: Record<string, unknown>, opts?: RunOptions): Promise<EngineResult>;
    diff(a: unknown, b: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  };
  readonly evolution: EngineHandle;
  readonly architecture: {
    inspect(input?: Record<string, unknown>, opts?: RunOptions): Promise<EngineResult>;
  };
  /** Experiment history (lazy; JSONL store under config.history.dir). */
  readonly history: WorldHistory;
  /** Reports: combine / write / render (docs/09 §2). */
  readonly report: WorldReport;
  /** Generic engine access (lazy). */
  engine(id: string): EngineHandle;
  /** Builds the engine input exactly as `engine(id).run(input)` would (config section + input), without running. */
  buildInput(id: string, input?: Record<string, unknown>): Record<string, unknown>;
  /** An EngineContext wired to this world (safety, events, evidence, logger) for helper APIs like replayFinding. */
  context(engineId: string, signal?: AbortSignal): EngineContext;
  /** Run a workflow from `config.workflows[name]`. */
  run(workflow: string, opts?: RunOptions): Promise<WorkflowResult>;
  on(event: string, fn: (payload: unknown) => void): () => void;
  /** Graceful cancel of everything in flight. */
  cancel(reason?: unknown): void;
  close(): Promise<void>;
}

type Obj = Record<string, unknown>;

/** A run reference for `history.compare`: id / prefix / "baseline:<name>" / bare baseline name, or results. */
export type RunRef = string | EngineResult | readonly EngineResult[] | { results: readonly EngineResult[] };

export interface WorldHistory {
  /** The underlying store (src/engines/history); loaded on first use. */
  store(): Promise<HistoryStoreLike>;
  /** Saves results (or a combined report) unless `history.enabled` is false; returns the index entry or null. */
  save(
    results: EngineResult[] | { results: readonly EngineResult[] },
    opts?: { label?: string; tags?: string[] },
  ): Promise<{ id: string } | null>;
  /**
   * docs/09 §2: compare a baseline with a current run. Each side may be one ref or a list (≥ 5 per side
   * enables statistical verdicts). Strings: run id / unique prefix / "baseline:<name>" / bare baseline
   * name (e.g. "main"); objects: EngineResult(s) or a combined report not (yet) in history.
   * Returns the history engine's RunComparison.
   */
  compare(args: {
    baseline: RunRef | readonly RunRef[];
    current: RunRef | readonly RunRef[];
    options?: Record<string, unknown>;
  }): Promise<unknown>;
}

export type ReportFormatName = "tty" | "json" | "md" | "junit" | "sarif" | "html";

/** docs/09 §2 `world.report` — thin wrappers over src/engines/reporting. Defaults come from config.report. */
export interface WorldReport {
  /** Combined report from results (verdict + exit code computed with config.report.failOn). */
  combine(results: readonly EngineResult[] | EngineResult, meta?: Record<string, unknown>): unknown;
  /** Writes report files (tty is never written). `outDir` resolves against the config dir. */
  write(
    report: unknown,
    opts?: { formats?: readonly ReportFormatName[]; outDir?: string; baseName?: string; failOn?: string },
  ): Promise<{ report: unknown; files: Array<{ format: string; path: string }> }>;
  /** Renders one format to a string (pure). */
  render(report: unknown, format: ReportFormatName, opts?: { color?: boolean; ascii?: boolean }): string;
  /** Renders a `history.compare` result. */
  renderComparison(
    cmp: unknown,
    format: "tty" | "json" | "md" | "html",
    opts?: { color?: boolean; ascii?: boolean },
  ): string;
  /** Process exit code for results per docs (130 cancelled > 70 error > 1 failing > 0). */
  exitCode(results: readonly EngineResult[] | unknown, failOn?: string): number;
}

/** Minimal structural view of sw-stress's HistoryStore (full type lives in src/engines/history). */
export interface HistoryStoreLike {
  readonly dir: string;
  append(input: { results: EngineResult[]; label?: string; tags?: string[] }): Promise<{ id: string }>;
}

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  }
  return out;
}

/**
 * Builds the performance engine input from config.performance + call input:
 * resolves `target` names via config.targets, normalises unit strings for rate, resolves
 * `auth` names via config.auth with secret refs, and defaults seed / allowHosts.
 */
export function buildPerformanceInput(
  cfg: ResolvedConfig,
  input: Obj = {},
  opts: { seed?: number; env?: NodeJS.ProcessEnv } = {},
): Obj {
  const base = isObj(cfg.config.performance) ? (cfg.config.performance as Obj) : {};
  const merged = deepMerge(base, input);
  const targets = cfg.config.targets;
  if (typeof merged.target === "string" && targets[merged.target]) {
    merged.target = targets[merged.target]?.url;
  } else if (merged.target === undefined) {
    const first = Object.values(targets).find((t) => t.role !== "dependency");
    if (first) merged.target = first.url;
  }
  if (typeof merged.rate === "string") merged.rate = parseRate(merged.rate, "performance.rate");
  for (const k of ["duration", "rampUp", "warmup", "timeout", "gracefulStop", "connectTimeout"]) {
    if (typeof merged[k] === "string" && /^\d+(\.\d+)?$/.test(merged[k] as string))
      merged[k] = Number(merged[k]);
    else if (typeof merged[k] === "string")
      merged[k] = parseDuration(merged[k] as string, `performance.${k}`);
  }
  resolvePerfAuthRoles(cfg, merged, "performance", opts.env);
  if (merged.seed === undefined && opts.seed !== undefined) merged.seed = opts.seed;
  if (merged.allowHosts === undefined) merged.allowHosts = cfg.config.safety.allowHosts;
  return merged;
}

/**
 * Resolves auth role names (section `auth: "<role>"` and scenario-level `scenarios[i].auth`,
 * docs/08-configuration.md §3) into credentials from config.auth, secrets resolved. In place.
 */
function resolvePerfAuthRoles(
  cfg: ResolvedConfig,
  merged: Obj,
  section: string,
  env?: NodeJS.ProcessEnv,
): void {
  const resolveRole = (role: string, where: string): Obj => {
    const ref = cfg.config.auth?.[role];
    if (!isObj(ref))
      throw new ConfigError("SW_CONFIG_AUTH", `${where} "${role}" is not defined in config.auth`);
    return resolveAuth(ref, { env, cwd: cfg.cwd });
  };
  if (typeof merged.auth === "string") merged.auth = resolveRole(merged.auth, `${section}.auth`);
  if (Array.isArray(merged.scenarios)) {
    merged.scenarios = merged.scenarios.map((sc, i) =>
      isObj(sc) && typeof sc.auth === "string"
        ? { ...sc, auth: resolveRole(sc.auth, `${section}.scenarios.${i}.auth`) }
        : sc,
    );
  }
}

const STRESS_FROM_PERF = [
  "target",
  "thresholds",
  "scenarios",
  "http",
  "timeout",
  "connectTimeout",
  "seed",
  "auth",
  "data",
  "thinkTime",
  "budget",
  "timing",
];

/**
 * Stress input = shared perf base keys from config.performance (target, thresholds, scenarios, …)
 * + config.stress + call input. Target names, auth refs and rate units are resolved like perf.
 */
export function buildStressInput(
  cfg: ResolvedConfig,
  input: Obj = {},
  opts: { seed?: number; env?: NodeJS.ProcessEnv } = {},
): Obj {
  const perf = isObj(cfg.config.performance) ? (cfg.config.performance as Obj) : {};
  const base: Obj = {};
  for (const k of STRESS_FROM_PERF) if (perf[k] !== undefined) base[k] = perf[k];
  const stress = isObj(cfg.config.stress) ? (cfg.config.stress as Obj) : {};
  const merged = deepMerge(deepMerge(base, stress), input);
  const targets = cfg.config.targets;
  if (typeof merged.target === "string" && targets[merged.target])
    merged.target = targets[merged.target]?.url;
  else if (merged.target === undefined) {
    const first = Object.values(targets).find((t) => t.role !== "dependency");
    if (first) merged.target = first.url;
  }
  if (typeof merged.rate === "string") merged.rate = parseRate(merged.rate, "stress.rate");
  resolvePerfAuthRoles(cfg, merged, "stress", opts.env);
  if (merged.seed === undefined && opts.seed !== undefined) merged.seed = opts.seed;
  if (merged.allowHosts === undefined) merged.allowHosts = cfg.config.safety.allowHosts;
  return merged;
}

const DEFAULT_ARCH_CACHE = ".second-world/cache/arch";

/** Architecture input = config.architecture + call input; `project`/`cacheDir`/`tsconfig` resolved against the config cwd. */
export function buildArchitectureInput(cfg: ResolvedConfig, input: Obj = {}): Obj {
  const sec = isObj(cfg.config.architecture) ? (cfg.config.architecture as Obj) : {};
  const merged = deepMerge(sec, input);
  const root = resolvePath(
    cfg.cwd,
    typeof merged.project === "string" ? merged.project : cfg.config.project.root,
  );
  merged.project = root;
  // Default under the config dir, never inside the inspected project (it may be read-only or untrusted).
  merged.cacheDir = resolvePath(
    cfg.cwd,
    typeof merged.cacheDir === "string" ? merged.cacheDir : DEFAULT_ARCH_CACHE,
  );
  if (typeof merged.tsconfig === "string") merged.tsconfig = resolvePath(root, merged.tsconfig);
  return merged;
}

/** Engines whose module exports a differently named input parser. */
const PARSE_ALIASES: Record<string, string> = {
  whatif: "parseExperimentInput",
  evolution: "parseEvolutionInput",
};

/** What-If input: the experiment definition as given; `cwd` defaults to the config dir. */
export function buildWhatIfInput(cfg: ResolvedConfig, input: Obj = {}): Obj {
  const out: Obj = { ...input };
  if (out.cwd === undefined) out.cwd = cfg.cwd;
  return out;
}

/**
 * Evolution input = config.evolution + call input. `repo` defaults to the config dir and
 * `workload` to the performance config section (without `target`: each arm gets its own port).
 */
export function buildEvolutionInput(cfg: ResolvedConfig, input: Obj = {}): Obj {
  const sec = isObj(cfg.config.evolution) ? (cfg.config.evolution as Obj) : {};
  const merged = deepMerge(sec, input);
  if (merged.repo === undefined) merged.repo = cfg.cwd;
  else if (typeof merged.repo === "string") merged.repo = resolvePath(cfg.cwd, merged.repo);
  // SECOND WORLD's own state is never a "working tree change" (the CLI adds the same; API callers too).
  const own = [".second-world", cfg.config.report.outDir, cfg.config.history.dir].map((p) =>
    resolvePath(cfg.cwd, p),
  );
  for (const sec of ["architecture", "model"] as const) {
    const c = (cfg.config[sec] as Obj | undefined)?.cacheDir;
    if (typeof c === "string") own.push(resolvePath(cfg.cwd, c));
  }
  const given = Array.isArray(merged.ignorePaths)
    ? (merged.ignorePaths as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  merged.ignorePaths = [...new Set([...own, ...given.map((p) => resolvePath(cfg.cwd, p))])];
  if (merged.workload === undefined && isObj(cfg.config.performance)) {
    const { target: _t, ...rest } = cfg.config.performance as Obj;
    resolvePerfAuthRoles(cfg, rest, "performance");
    merged.workload = rest;
  }
  return merged;
}

/**
 * System Model input = config.model + call input. `project` and `cacheDir` resolve against the config
 * dir; `openapi` defaults to the Bug Hunter contract (bugs.openapi / bugs.contract) when present.
 */
export function buildModelInput(cfg: ResolvedConfig, input: Obj = {}): Obj {
  const sec = isObj(cfg.config.model) ? (cfg.config.model as Obj) : {};
  const merged = deepMerge(sec, input);
  merged.project = resolvePath(
    cfg.cwd,
    typeof merged.project === "string" ? merged.project : cfg.config.project.root,
  );
  merged.cacheDir = resolvePath(
    cfg.cwd,
    typeof merged.cacheDir === "string" ? merged.cacheDir : DEFAULT_ARCH_CACHE,
  );
  if (merged.openapi === undefined) {
    const bugs = isObj(cfg.config.bugs) ? (cfg.config.bugs as Obj) : {};
    const spec = bugs.openapi ?? bugs.contract;
    if (typeof spec === "string") merged.openapi = resolvePath(cfg.cwd, spec);
  } else if (typeof merged.openapi === "string") merged.openapi = resolvePath(cfg.cwd, merged.openapi);
  if (merged.serviceName === undefined && cfg.config.project.name)
    merged.serviceName = cfg.config.project.name;
  return merged;
}

const RELIABILITY_KEYS = [
  "target",
  "scenario",
  "dependency",
  "dependencies",
  "params",
  "fault",
  "environment",
  "allowProduction",
  "workload",
  "steady",
  "duration",
  "recovery",
  "ramp",
  "steadyState",
  "hypothesis",
  "abort",
  "maxDuration",
  "repeat",
  "expectTimeout",
  "invariants",
  "maxOutboundBudget",
  "seed",
];

/**
 * Reliability input = config.reliability (known keys) + call input. Dependencies accept the docs/08
 * shorthand: `proxyListen` → `listen`, `upstream: "<target name>"` → that target's URL, section-level
 * `injector: "auto"` → per-dependency "builtin". `environment` defaults to config.environment.
 */
export function buildReliabilityInput(
  cfg: ResolvedConfig,
  input: Obj = {},
  opts: { seed?: number; env?: NodeJS.ProcessEnv } = {},
): Obj {
  const sec = isObj(cfg.config.reliability) ? (cfg.config.reliability as Obj) : {};
  const base: Obj = {};
  for (const k of RELIABILITY_KEYS) if (sec[k] !== undefined) base[k] = sec[k];
  const merged = deepMerge(base, input);
  const targets = cfg.config.targets;
  if (typeof merged.target === "string" && targets[merged.target])
    merged.target = targets[merged.target]?.url;
  else if (merged.target === undefined) {
    const first = Object.values(targets).find((t) => t.role !== "dependency");
    if (first) merged.target = first.url;
  }
  const defInjector = sec.injector === "toxiproxy" || sec.injector === "docker" ? sec.injector : "builtin";
  if (isObj(merged.dependencies)) {
    const deps: Obj = {};
    for (const [name, d] of Object.entries(merged.dependencies)) {
      if (!isObj(d)) continue;
      const dep: Obj = { ...d };
      if (dep.proxyListen !== undefined && dep.listen === undefined) dep.listen = dep.proxyListen;
      delete dep.proxyListen;
      if (dep.injector === undefined || dep.injector === "auto") dep.injector = defInjector;
      if (typeof dep.upstream === "string" && targets[dep.upstream])
        dep.upstream = targets[dep.upstream]?.url;
      deps[name] = dep;
    }
    merged.dependencies = deps;
  }
  if (merged.environment === undefined) merged.environment = cfg.config.environment;
  if (merged.seed === undefined && opts.seed !== undefined) merged.seed = opts.seed;
  if (isObj(merged.workload) && Array.isArray((merged.workload as Obj).routes)) {
    const wl = { ...(merged.workload as Obj) };
    wl.routes = (wl.routes as unknown[]).map((r) => resolveRouteAuth(cfg, r, opts.env));
    merged.workload = wl;
  }
  return merged;
}

/**
 * F10: `route.auth: "<role>"` → headers from config.auth (bearer / basic / header, `{env}`/`{file}`
 * secrets resolved like the Bug Hunter's roles). Explicit route headers win. Unresolvable roles are
 * left on the route; the engine sends without credentials and records RELIABILITY_AUTH_UNRESOLVED.
 */
export function authHeadersFor(
  cfg: ResolvedConfig,
  role: string,
  env?: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  const ref = cfg.config.auth?.[role];
  if (!isObj(ref) || typeof ref.type !== "string" || !BUGS_AUTH_TYPES.has(ref.type)) return undefined;
  let c: Obj;
  try {
    c = resolveAuth(ref, { env, cwd: cfg.cwd });
  } catch {
    return undefined; // secret missing
  }
  if (c.type === "bearer" && typeof c.token === "string") return { authorization: `Bearer ${c.token}` };
  if (c.type === "basic" && typeof c.username === "string" && typeof c.password === "string") {
    return { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` };
  }
  if (c.type === "header" && typeof c.name === "string" && typeof c.value === "string")
    return { [c.name.toLowerCase()]: c.value };
  return undefined;
}

function resolveRouteAuth(cfg: ResolvedConfig, route: unknown, env?: NodeJS.ProcessEnv): unknown {
  if (!isObj(route) || typeof route.auth !== "string") return route;
  const h = authHeadersFor(cfg, route.auth, env);
  if (!h) return route;
  const explicit = isObj(route.headers) ? (route.headers as Record<string, string>) : {};
  const lower = new Set(Object.keys(explicit).map((k) => k.toLowerCase()));
  const merged: Record<string, string> = { ...explicit };
  for (const [k, v] of Object.entries(h)) if (!lower.has(k)) merged[k] = v;
  const { auth: _role, ...rest } = route;
  return { ...rest, headers: merged };
}

const AGENT_FROM_BUGS = ["target", "openapi", "auth", "hooks", "values", "headers", "timeout"];

/**
 * Adversarial Agent input = bugs-derived base (target, openapi ← bugs.contract, auth roles from
 * config.auth with secrets resolved, hooks.setup/reset, values, headers; cwd = config dir) overlaid
 * with the `agent` config section and the call input. Roles given in agent.auth.roles are resolved too.
 */
export function buildAgentInput(
  cfg: ResolvedConfig,
  input: Obj = {},
  opts: { seed?: number; env?: NodeJS.ProcessEnv } = {},
): Obj {
  const bugsBase = buildBugsInput(cfg, {}, opts);
  const base: Obj = { cwd: bugsBase.cwd };
  for (const k of AGENT_FROM_BUGS) if (bugsBase[k] !== undefined) base[k] = bugsBase[k];
  // Resources (create/read/update/delete + idPointer) from bugs.stateful; agent.resources overrides.
  if (isObj(bugsBase.stateful) && (bugsBase.stateful as Obj).resources !== undefined)
    base.resources = (bugsBase.stateful as Obj).resources;
  const sec = isObj(cfg.config.agent) ? { ...(cfg.config.agent as Obj) } : {};
  if (sec.contract !== undefined && sec.openapi === undefined) sec.openapi = sec.contract;
  delete sec.contract;
  const merged = deepMerge(deepMerge(base, sec), input);
  const targets = cfg.config.targets;
  if (typeof merged.target === "string" && targets[merged.target])
    merged.target = targets[merged.target]?.url;
  if (isObj(merged.auth) && isObj((merged.auth as Obj).roles)) {
    const roles: Obj = {};
    for (const [name, ref] of Object.entries((merged.auth as Obj).roles as Obj)) {
      roles[name] = isObj(ref) ? resolveAuth(ref, { env: opts.env, cwd: cfg.cwd }) : ref;
    }
    merged.auth = { ...(merged.auth as Obj), roles };
  }
  if (merged.seed === undefined && opts.seed !== undefined) merged.seed = opts.seed;
  return merged;
}

/** Auth entry types the Bug Hunter understands (config.auth may also hold oauth2 etc., which are skipped). */
const BUGS_AUTH_TYPES = new Set(["bearer", "basic", "header"]);

/**
 * Bug Hunter input = config.bugs + call input. `bugs.contract` → `openapi`; `cwd` = config dir;
 * roles from config.auth (secrets resolved) unless `auth.roles` is given; `hooks.reset|setup` from
 * config.hooks; target names resolved like perf.
 */
export function buildBugsInput(
  cfg: ResolvedConfig,
  input: Obj = {},
  opts: { seed?: number; env?: NodeJS.ProcessEnv } = {},
): Obj {
  const sec = isObj(cfg.config.bugs) ? { ...(cfg.config.bugs as Obj) } : {};
  if (sec.contract !== undefined && sec.openapi === undefined) sec.openapi = sec.contract;
  delete sec.contract;
  const merged = deepMerge(sec, input);
  if (merged.contract !== undefined) {
    if (merged.openapi === undefined) merged.openapi = merged.contract;
    delete merged.contract;
  }
  const targets = cfg.config.targets;
  if (typeof merged.target === "string" && targets[merged.target])
    merged.target = targets[merged.target]?.url;
  else if (merged.target === undefined) {
    const first = Object.values(targets).find((t) => t.role !== "dependency");
    if (first) merged.target = first.url;
  }
  if (merged.cwd === undefined) merged.cwd = cfg.cwd;
  if (merged.seed === undefined && opts.seed !== undefined) merged.seed = opts.seed;
  const auth = isObj(merged.auth) ? { ...(merged.auth as Obj) } : {};
  if (!isObj(auth.roles) || Object.keys(auth.roles as Obj).length === 0) {
    const roles: Obj = {};
    for (const [name, ref] of Object.entries(cfg.config.auth ?? {})) {
      if (isObj(ref) && typeof ref.type === "string" && BUGS_AUTH_TYPES.has(ref.type)) {
        roles[name] = resolveAuth(ref, { env: opts.env, cwd: cfg.cwd });
      }
    }
    if (Object.keys(roles).length > 0) auth.roles = roles;
  } else {
    const roles: Obj = {};
    for (const [name, ref] of Object.entries(auth.roles as Obj))
      roles[name] = isObj(ref) ? resolveAuth(ref, { env: opts.env, cwd: cfg.cwd }) : ref;
    auth.roles = roles;
  }
  if (Object.keys(auth).length > 0) merged.auth = auth;
  const hooks = isObj(merged.hooks) ? { ...(merged.hooks as Obj) } : {};
  const cfgHooks = isObj(cfg.config.hooks) ? (cfg.config.hooks as Obj) : {};
  for (const k of ["setup", "reset"]) {
    const h = cfgHooks[k];
    if (hooks[k] === undefined && isObj(h) && (isObj(h.http) || h.command !== undefined)) {
      hooks[k] = isObj(h.http)
        ? { http: h.http }
        : {
            command: h.command,
            ...(h.cwd ? { cwd: h.cwd } : {}),
            ...(h.timeout ? { timeout: h.timeout } : {}),
          };
    }
  }
  if (Object.keys(hooks).length > 0) merged.hooks = hooks;
  return merged;
}

function isEngineResult(v: unknown): v is EngineResult {
  return (
    isObj(v) && typeof v.engine === "string" && typeof v.runId === "string" && typeof v.status === "string"
  );
}

function resolveAuth(ref: Obj, o: { env?: NodeJS.ProcessEnv; cwd?: string }): Obj {
  const val = (v: unknown): unknown =>
    isObj(v) && (typeof v.env === "string" || typeof v.file === "string")
      ? resolveSecret(v as SecretRef, o)
      : v;
  const out: Obj = {};
  for (const [k, v] of Object.entries(ref)) out[k] = val(v);
  return out;
}

export async function createWorld(opts: CreateWorldOptions = {}): Promise<World> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const cfg = await loadConfig({
    cwd,
    env,
    ...(typeof opts.config === "string" ? { configFile: opts.config } : {}),
    ...(opts.config === false ? { configFile: false as const } : {}),
    ...(isObj(opts.config) ? { inline: opts.config } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.set ? { set: opts.set } : {}),
    ...(opts.overrides ? { overrides: opts.overrides } : {}),
    noConfigCode: opts.noConfigCode ?? false,
    userConfig: opts.userConfig ?? opts.config !== false,
  });

  const redactor = createRedactor({
    headers: cfg.config.safety.redact.headers,
    secrets: collectSecretValues(cfg.config, { env, cwd: cfg.cwd }),
  });
  const log =
    opts.logger ?? (opts.logLevel ? createLogger({ level: opts.logLevel, redact: redactor }) : silentLogger);
  for (const w of cfg.warnings) log.warn(w);

  const root = new AbortController();
  const rootSignal = opts.signal ? AbortSignal.any([root.signal, opts.signal]) : root.signal;
  const clock = opts.clock ?? systemClock;
  const auditFile =
    opts.auditFile === false
      ? undefined
      : (opts.auditFile ?? (cfg.configFile ? join(cfg.cwd, ".second-world", "audit.log") : undefined));
  const safety = createSafetyGuard(
    {
      allowHosts: cfg.config.safety.allowHosts,
      allowPublic: cfg.config.safety.allowPublic,
      maxRps: cfg.config.safety.maxRps,
      maxConcurrency: cfg.config.safety.maxConcurrency,
      maxRequests: cfg.config.safety.maxRequests,
      maxDurationMs: cfg.config.safety.maxDuration,
      allowMutations: cfg.config.safety.allowMutations,
      approveDisruptive: cfg.config.safety.approveDisruptive,
      environment: cfg.config.environment,
    },
    {
      interactive: opts.interactive ?? false,
      approve: opts.approve ?? false,
      signal: rootSignal,
      ...(auditFile ? { auditFile } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    },
  );
  const events = createEventBus({ log });
  const evidence = createEvidenceStore({
    onFinding: (f, isNew) => events.emit(isNew ? "finding.created" : "finding.updated", f),
  });
  const envReport = opts.probe === false ? stubEnvironmentReport() : await probeEnvironment({ env });
  const registry = createRegistry();
  for (const [k, v] of Object.entries(opts.engines ?? {})) registry.register(k, v);
  const seed =
    opts.seed ??
    (typeof (cfg.config.performance as Obj | undefined)?.seed === "number"
      ? ((cfg.config.performance as Obj).seed as number)
      : undefined);
  let closed = false;

  function makeCtx(signal: AbortSignal, engineId: string): EngineContext {
    return createEngineContext({
      signal,
      clock,
      seed: seed ?? 1,
      log: log.child({ engine: engineId }),
      events,
      evidence,
      safety,
      env: envReport,
      config: cfg.config as unknown as Record<string, unknown>,
      newId: () => ulid(),
    });
  }

  async function runEngine(id: string, input: Obj, ro: RunOptions = {}): Promise<EngineResult> {
    if (closed) throw new EngineError("SW_ENGINE_CLOSED", "World is closed");
    const signal = ro.signal ? AbortSignal.any([rootSignal, ro.signal]) : rootSignal;
    const { engine, module } = await registry.load(id);
    const bo = { ...(seed !== undefined ? { seed } : {}), env };
    const raw =
      id === "performance"
        ? buildPerformanceInput(cfg, input, bo)
        : id === "stress"
          ? buildStressInput(cfg, input, bo)
          : id === "architecture"
            ? buildArchitectureInput(cfg, input)
            : id === "bugs"
              ? buildBugsInput(cfg, input, bo)
              : id === "reliability"
                ? buildReliabilityInput(cfg, input, bo)
                : id === "whatif"
                  ? buildWhatIfInput(cfg, input)
                  : id === "evolution"
                    ? buildEvolutionInput(cfg, input)
                    : id === "model"
                      ? buildModelInput(cfg, input)
                      : id === "agent"
                        ? buildAgentInput(cfg, input, bo)
                        : deepMerge(
                            isObj((cfg.config as Obj)[id]) ? ((cfg.config as Obj)[id] as Obj) : {},
                            input,
                          );
    let parsed: unknown;
    // Engines export parse<Id>Input (ConfigError with readable paths); fall back to the Zod schema.
    const parseName = PARSE_ALIASES[id] ?? `parse${id.charAt(0).toUpperCase()}${id.slice(1)}Input`;
    const parseFn = (module as Record<string, unknown>)[parseName];
    if (typeof parseFn === "function") parsed = (parseFn as (x: unknown) => unknown)(raw);
    else {
      const r = engine.inputSchema.safeParse(raw);
      if (!r.success) {
        const issues = r.error.issues.map((i) => `${[id, ...i.path].join(".")}: ${i.message}`);
        throw new ConfigError("SW_CONFIG_INVALID", `Invalid ${id} input: ${issues.join("; ")}`, {
          details: { issues },
        });
      }
      parsed = r.data;
    }
    const ctx = makeCtx(signal, id);
    events.emit("run.started", { engine: id });
    const t0 = clock.now();
    try {
      const result = await engine.run(parsed, ctx);
      // Some engines (architecture) already add their findings to ctx.evidence; don't double-count.
      for (const f of result.findings) if (!evidence.get(f.id)) evidence.addFinding(f);
      evidence.addResult(result);
      events.emit("run.completed", { engine: id, status: result.status, durationMs: clock.now() - t0 });
      return result;
    } catch (e) {
      events.emit("run.failed", { engine: id, error: isSecondWorldError(e) ? e.code : String(e) });
      // The safety kill switch also trips on world.cancel()/the caller's signal (Ctrl+C). An engine
      // that had not reserved its lease yet then throws SW_SAFETY_KILLED, which is a cancellation
      // (exit 130), not a safety block (exit 3). A real safety.kill() leaves `signal` un-aborted.
      if (signal.aborted && isSecondWorldError(e) && e.code === "SW_SAFETY_KILLED")
        throw new DOMException(`${id} cancelled before it started`, { name: "AbortError", cause: e });
      throw e;
    }
  }

  let storePromise: Promise<HistoryStoreLike> | undefined;
  const history: WorldHistory = {
    store() {
      storePromise ??= import("../engines/history/index.js").then((m) =>
        m.createHistoryStore({
          cwd: cfg.cwd,
          dir: resolvePath(cfg.cwd, cfg.config.history.dir),
          backend: cfg.config.history.backend,
          isoNow: () => clock.isoNow(),
          onWarning: (m) => log.warn(m),
        }),
      );
      return storePromise;
    },
    async save(input, so = {}) {
      const results = Array.isArray(input)
        ? input
        : [...(input as { results: readonly EngineResult[] }).results];
      if (!cfg.config.history.enabled || results.length === 0) return null;
      const store = await history.store();
      // One id per run: a single result is stored under its own runId (the id printed in the header and
      // written to report.json), unless that id is already taken.
      const only = results.length === 1 ? (results[0] as EngineResult).runId : undefined;
      const reuse =
        only !== undefined &&
        !(await (store as unknown as { get(id: string): Promise<unknown> }).get(only).catch(() => null));
      const e = await store.append({
        results,
        ...(reuse ? { id: only } : {}),
        ...(so.label ? { label: so.label } : {}),
        ...(so.tags ? { tags: so.tags } : {}),
      });
      events.emit("history.saved", { id: e.id });
      return { id: e.id };
    },
    async compare({ baseline, current, options }) {
      const h = await import("../engines/history/index.js");
      const store = (await history.store()) as unknown as {
        get(id: string): Promise<unknown>;
      };
      const toRuns = async (side: RunRef | readonly RunRef[]): Promise<unknown[]> => {
        const refs: RunRef[] =
          Array.isArray(side) && !(side.length > 0 && isEngineResult(side[0]))
            ? [...(side as RunRef[])]
            : [side as RunRef];
        const runs: unknown[] = [];
        for (const ref of refs) {
          if (typeof ref === "string") {
            const run =
              (ref.startsWith("baseline:") ? null : await store.get(`baseline:${ref}`).catch(() => null)) ??
              (await store.get(ref));
            if (!run) {
              throw new ConfigError("SW_CONFIG_HISTORY", `history.compare: no run or baseline "${ref}"`, {
                hint: "Use a run id (or unique prefix), baseline:<name>, or pass results directly",
              });
            }
            runs.push(run);
          } else {
            const results = isEngineResult(ref)
              ? [ref]
              : Array.isArray(ref)
                ? [...ref]
                : [...(ref as { results: readonly EngineResult[] }).results];
            runs.push({
              schemaVersion: h.HISTORY_SCHEMA_VERSION,
              id: results[0]?.runId ?? "current",
              createdAt: results[0]?.endedAt ?? clock.isoNow(),
              tags: [],
              engines: [...new Set(results.map((r) => r.engine))],
              status: h.overallStatus(results),
              metrics: h.extractMetrics(results),
              results,
            });
          }
        }
        return runs;
      };
      const base = await toRuns(baseline);
      const cur = await toRuns(current);
      return h.compareRuns(base as never, cur as never, (options ?? {}) as never);
    },
  };

  type Reporting = typeof import("../engines/reporting/index.js");
  const reporting: Reporting = await import("../engines/reporting/index.js");
  const failOnDefault = cfg.config.report.failOn;
  const asFailOn = (f?: string) => (f ?? failOnDefault) as Parameters<Reporting["computeExitCode"]>[1];
  const report: WorldReport = {
    combine: (results, meta = {}) =>
      reporting.combineResults(
        isEngineResult(results) ? [results] : [...(results as readonly EngineResult[])],
        meta as never,
        asFailOn(),
      ),
    async write(rep, o = {}) {
      const outDir = resolvePath(cfg.cwd, o.outDir ?? cfg.config.report.outDir);
      const formats = (o.formats ?? cfg.config.report.formats) as Parameters<
        Reporting["writeReports"]
      >[1]["formats"];
      const r = await reporting.writeReports(rep as never, {
        formats,
        outDir,
        failOn: asFailOn(o.failOn),
        ...(o.baseName ? { baseName: o.baseName } : {}),
      });
      return { report: r.report, files: r.files };
    },
    render: (rep, format, o = {}) =>
      reporting.renderReport(rep as never, format, { failOn: asFailOn(), ...o }),
    renderComparison: (cmp, format, o = {}) => reporting.renderComparison(cmp as never, format, o),
    exitCode(results, failOn) {
      const list = isEngineResult(results)
        ? [results]
        : Array.isArray(results)
          ? (results as EngineResult[])
          : ((results as { results?: EngineResult[] }).results ?? []);
      return reporting.computeExitCode(list, asFailOn(failOn));
    },
  };

  const handle = (id: string): EngineHandle => ({ run: (input = {}, ro) => runEngine(id, input as Obj, ro) });

  const world: World = {
    config: cfg,
    events,
    evidence,
    safety,
    log,
    env: envReport,
    registry,
    redactor,
    signal: rootSignal,
    performance: handle("performance"),
    stress: handle("stress"),
    bugs: handle("bugs"),
    reliability: handle("reliability"),
    whatif: handle("whatif"),
    agent: handle("agent"),
    model: {
      build: (input = {}, ro) => runEngine("model", input as Obj, ro),
      async diff(a, b, opts) {
        const { module } = await registry.load("model");
        const m = module as { diffModels?: (x: unknown, y: unknown, o?: unknown) => unknown };
        if (typeof m.diffModels !== "function")
          throw new EngineError("SW_ENGINE_LOAD", "model engine does not export diffModels()");
        return m.diffModels(a, b, opts);
      },
    },
    evolution: handle("evolution"),
    buildInput(id, input = {}) {
      const bo = { ...(seed !== undefined ? { seed } : {}), env };
      if (id === "performance") return buildPerformanceInput(cfg, input, bo);
      if (id === "stress") return buildStressInput(cfg, input, bo);
      if (id === "architecture") return buildArchitectureInput(cfg, input);
      if (id === "bugs") return buildBugsInput(cfg, input, bo);
      if (id === "reliability") return buildReliabilityInput(cfg, input, bo);
      if (id === "whatif") return buildWhatIfInput(cfg, input);
      if (id === "evolution") return buildEvolutionInput(cfg, input);
      if (id === "model") return buildModelInput(cfg, input);
      if (id === "agent") return buildAgentInput(cfg, input, bo);
      return deepMerge(isObj((cfg.config as Obj)[id]) ? ((cfg.config as Obj)[id] as Obj) : {}, input);
    },
    context(engineId, signal) {
      return makeCtx(signal ? AbortSignal.any([rootSignal, signal]) : rootSignal, engineId);
    },
    architecture: { inspect: (input = {}, ro) => runEngine("architecture", input, ro) },
    history,
    report,
    engine: handle,
    async run(name, ro = {}) {
      const wf = cfg.config.workflows[name];
      if (!wf) {
        throw new ConfigError("SW_CONFIG_WORKFLOW", `Unknown workflow "${name}"`, {
          hint: `Defined workflows: ${Object.keys(cfg.config.workflows).join(", ") || "(none)"}`,
        });
      }
      const signal = ro.signal ? AbortSignal.any([rootSignal, ro.signal]) : rootSignal;
      return runWorkflow(
        wf.steps,
        (_id, step, _up, sig) => runEngine(step.engine as EngineId, step.input ?? {}, { signal: sig }),
        {
          signal,
          ...(wf.concurrency ? { concurrency: wf.concurrency } : {}),
        },
      );
    },
    on: (event, fn) => events.on(event, fn),
    cancel(reason) {
      if (!root.signal.aborted) root.abort(reason ?? new Error("cancelled"));
    },
    async close() {
      if (closed) return;
      closed = true;
      events.emit("world.closed", {});
      events.clear();
    },
  };
  return world;
}
