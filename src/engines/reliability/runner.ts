/**
 * Reliability Lab experiment runner. See docs/03-engines/reliability-lab.md §2 (steady state →
 * hypothesis → inject → observe → revert & recover → verdict; blast-radius controls), §3 (measurements),
 * §6 (default safety) and docs/11-safety-security-privacy.md §2 (disruptive actions need approval).
 *
 * Per repetition: ONE continuous Performance Lab run (open model) drives the workload; a recording
 * HttpExecutor captures every client request (route tagged with the `x-sw-route` header). The fault is
 * applied after the steady phase (if the steady state holds), optionally ramped, reverted after
 * `duration` (or early on the abort condition) and the run continues through the recovery phase.
 * Every applied fault is reverted in `finally`, on abort, on signals/crash (global cleanup stack) and by
 * its TTL.
 */
import { BuiltinFaultProxy } from "../../adapters/faults/builtin-proxy.js";
import { CleanupStack, registerGlobalCleanup } from "../../adapters/faults/cleanup.js";
import { DockerInjector } from "../../adapters/faults/docker.js";
import { ToxiproxyInjector } from "../../adapters/faults/toxiproxy.js";
import {
  describeFault,
  type Fault,
  type FaultInjector,
  type FaultInput,
  parseFault,
} from "../../adapters/faults/types.js";
import {
  createUndiciExecutor,
  type ExecutorSafety,
  type HttpExecutor,
  type HttpRequestSpec,
} from "../../adapters/http/undici-executor.js";
import { evaluateThreshold, parseThreshold, type Threshold } from "../../core/config/thresholds.js";
import { ConfigError, SafetyError } from "../../core/errors.js";
import type { EngineResult, Limitation } from "../../core/evidence/schemas.js";
import { createRedactor } from "../../core/log/redact.js";
import type { EngineContext } from "../../core/types.js";
import { type PerformanceDeps, runPerformance } from "../performance/index.js";
import {
  amplification,
  assessIsolation,
  assessTimeout,
  deriveBounds,
  detectCircuitBreaker,
  detectSynchronizedRetries,
  type PhaseStats,
  phaseStats,
  type ReqRecord,
  recoveryTime,
  statValue,
  windowize,
} from "./detectors.js";
import { buildFindings, ENGINE_VERSION } from "./findings.js";
import {
  createCollectionFetcher,
  defaultCountedRoutes,
  evaluateInvariants,
  type IdempotencySpec,
  type InvariantBaseline,
  type InvariantResult,
  invariantDetections,
  OpLedger,
  opExecutor,
  parseCollectionRef,
  type RouteOpCounts,
  takeBaselines,
} from "./invariants.js";
import { extraFaults, getScenario, type InjectorKind } from "./scenarios.js";
import type { ReliabilityInput, RouteSpec } from "./schema.js";
import type { Detection, ReliabilityData, RunAnalysis, ThresholdCheck } from "./types.js";

export interface ReliabilityDeps {
  /** Pre-started injectors by dependency name (tests / embedding). The engine reverts its faults but does not close them. */
  injectors?: Record<string, FaultInjector>;
  /** Phase hook (tests: inject crashes/aborts at precise points). Errors thrown here abort the run (faults still reverted). */
  onPhase?: (
    phase: "steady" | "fault-applied" | "fault-reverted" | "run-done",
    info: { run: number },
  ) => void | Promise<void>;
  /** Passed to runPerformance (e.g. spinMs). `executor` is always the engine's recording executor. */
  perf?: Omit<PerformanceDeps, "executor">;
}

const ROUTE_HEADER = "x-sw-route";
const MAX_RECORDS = 500_000;

function headerValue(h: HttpRequestSpec["headers"], name: string): string | undefined {
  if (!h) return undefined;
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) if ((h[i] as string).toLowerCase() === name) return h[i + 1];
    return undefined;
  }
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** Wraps an executor to record every request (interrupted/aborted ones are excluded). */
export function recordingExecutor(inner: HttpExecutor, sink: ReqRecord[]): HttpExecutor {
  return {
    async execute(req, signal) {
      const r = await inner.execute(req, signal);
      if (r.error?.kind !== "aborted" && sink.length < MAX_RECORDS) {
        sink.push({
          route: headerValue(req.headers, ROUTE_HEADER) ?? "default",
          start: r.tStart,
          end: r.tEnd,
          status: r.status,
          ...(r.error ? { error: r.error.kind } : {}),
        });
      }
      return r;
    },
    get inFlight() {
      return inner.inFlight;
    },
    get openSockets() {
      return inner.openSockets;
    },
    close: () => inner.close(),
  };
}

interface ResolvedInjector {
  injector: FaultInjector;
  kind: InjectorKind;
  owned: boolean;
  arrivals: ((from: number, to: number) => number[]) | null;
}

async function resolveInjector(
  input: ReliabilityInput,
  ctx: EngineContext,
  deps: ReliabilityDeps,
): Promise<ResolvedInjector | { limitation: Limitation }> {
  const given = deps.injectors?.[input.dependency];
  const spec = input.dependencies[input.dependency];
  if (given) {
    const kind: InjectorKind =
      given instanceof BuiltinFaultProxy
        ? "builtin"
        : given instanceof DockerInjector
          ? "docker"
          : given instanceof ToxiproxyInjector
            ? "toxiproxy"
            : "builtin";
    return {
      injector: given,
      kind,
      owned: false,
      arrivals: given instanceof BuiltinFaultProxy ? (f, t) => given.arrivals(f, t) : null,
    };
  }
  if (!spec) {
    throw new ConfigError("SW_CONFIG_RELIABILITY", `Unknown dependency "${input.dependency}"`, {
      hint: "Declare it under reliability.dependencies.<name> (injector + upstream/listen, toxiproxy or container)",
    });
  }
  if (spec.injector === "builtin") {
    if (!spec.upstream) {
      throw new ConfigError(
        "SW_CONFIG_RELIABILITY",
        `dependencies.${input.dependency}.upstream is required for the built-in proxy`,
      );
    }
    const proxy = await BuiltinFaultProxy.start({
      upstream: spec.upstream,
      mode: spec.mode,
      port: spec.listen ?? 0,
      name: input.dependency,
      random: () => ctx.rng.next(),
      now: () => ctx.clock.now(),
    });
    ctx.log.info("fault proxy listening", {
      dependency: input.dependency,
      url: proxy.url,
      upstream: spec.upstream,
    });
    return { injector: proxy, kind: "builtin", owned: true, arrivals: (f, t) => proxy.arrivals(f, t) };
  }
  if (spec.injector === "toxiproxy") {
    if (!spec.toxiproxy)
      throw new ConfigError(
        "SW_CONFIG_RELIABILITY",
        `dependencies.${input.dependency}.toxiproxy.proxy is required`,
      );
    const inj = new ToxiproxyInjector({
      proxy: spec.toxiproxy.proxy,
      ...(spec.toxiproxy.apiUrl ? { apiUrl: spec.toxiproxy.apiUrl } : {}),
    });
    const caps = await inj.capabilities();
    if (!caps.available)
      return {
        limitation: {
          code: "injector-unavailable",
          message: `toxiproxy: ${caps.reason}`,
          impact: "invalidates",
        },
      };
    return { injector: inj, kind: "toxiproxy", owned: true, arrivals: null };
  }
  const inj = new DockerInjector();
  const caps = await inj.capabilities();
  if (!caps.available)
    return {
      limitation: { code: "injector-unavailable", message: `docker: ${caps.reason}`, impact: "invalidates" },
    };
  return { injector: inj, kind: "docker", owned: true, arrivals: null };
}

function scaleFault(f: Fault, k: number, steps: number): Fault {
  const s = k / steps;
  if (f.type === "latency") return { ...f, latencyMs: f.latencyMs * s, jitterMs: f.jitterMs * s };
  if (f.type === "http-status" || f.type === "reset" || f.type === "blackhole")
    return { ...f, percent: Math.max(1, Math.round(f.percent * s)) };
  return f;
}

function routeScenarios(routes: RouteSpec[]): unknown[] {
  return routes.map((r) => ({
    name: r.name,
    weight: r.weight,
    steps: [
      {
        name: r.name,
        method: r.method,
        path: r.path,
        headers: {
          ...r.headers,
          [ROUTE_HEADER]: r.name,
          ...(r.body !== undefined && !Object.keys(r.headers).some((h) => h.toLowerCase() === "content-type")
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(r.body !== undefined ? { body: r.body } : {}),
        ...(r.json !== undefined ? { json: r.json } : {}),
      },
    ],
  }));
}

function evalChecks(
  thresholds: Threshold[],
  records: readonly ReqRecord[],
  from: number,
  to: number,
  phase: "steady" | "fault",
): ThresholdCheck[] {
  return thresholds.map((t) => {
    const route = t.scope.startsWith("scenario.") ? t.scope.slice("scenario.".length) : undefined;
    const st = phaseStats(records, from, to, route);
    const scoped = records.filter(
      (r) => r.start >= from && r.start < to && (route === undefined || r.route === route),
    );
    const actual = statValue(st, t.stat, t.percentile, scoped);
    return { expression: t.source, actual, passed: evaluateThreshold(t, actual), phase };
  });
}

function parseAll(list: string[], key: string): Threshold[] {
  return list.map((e, i) => {
    const t = parseThreshold(e);
    if (t.scope !== "http" && !t.scope.startsWith("scenario.")) {
      throw new ConfigError(
        "SW_CONFIG_RELIABILITY",
        `${key}[${i}]: scope must be http or scenario.<route> ("${e}")`,
      );
    }
    return t;
  });
}

interface Plan {
  input: ReliabilityInput;
  faults: Fault[];
  routes: RouteSpec[];
  affected: ReadonlySet<string> | undefined;
  steadyTh: Threshold[];
  hypoTh: Threshold[];
  detectors: ReadonlySet<string>;
  sustained: boolean;
  /** Routes sending one key per logical operation (and retrying with it). */
  idempotency: ReadonlyMap<string, IdempotencySpec>;
  /** Routes whose operations are counted for invariants. */
  counted: ReadonlySet<string>;
  /** Scrubs secrets (route/invariant header values + built-in patterns) from evidence text. */
  redact: (s: string) => string;
}

const MAX_INVARIANT_BODY = 32 * 1024 * 1024;

function invariantFetcher(plan: Plan, ctx: EngineContext, signal: AbortSignal) {
  const executor = createUndiciExecutor({
    connections: 2,
    keepAlive: true,
    timeoutMs: Math.max(5000, plan.input.workload.timeout),
    connectTimeoutMs: 5000,
    maxBodyBytes: MAX_INVARIANT_BODY,
    now: () => ctx.clock.now(),
    safety: ctx.safety as ExecutorSafety,
  });
  const fetcher = createCollectionFetcher({
    executor,
    target: plan.input.target,
    routeHeaders: (name) => plan.routes.find((r) => r.name === name)?.headers,
    checkUrl: (u) => {
      const d = ctx.safety.checkTarget(u);
      if (!d.allowed) throw new Error(`collection ${u.origin} blocked by the safety guard (${d.code})`);
    },
    signal,
    maxBodyBytes: MAX_INVARIANT_BODY,
  });
  return { fetcher, close: () => executor.close() };
}

function scrubResults(results: InvariantResult[], redact: (s: string) => string): InvariantResult[] {
  return results.map((r) => ({
    ...r,
    name: redact(r.name),
    detail: redact(r.detail),
    ...(r.error !== undefined ? { error: redact(r.error) } : {}),
    ...(r.partial ? { partial: r.partial.map(redact) } : {}),
    ...(r.duplicates
      ? { duplicates: r.duplicates.map((d) => ({ ...d, key: redact(d.key), ids: d.ids.map(redact) })) }
      : {}),
  }));
}

function sleep(ctx: EngineContext, ms: number, signal: AbortSignal): Promise<void> {
  return ctx.clock.sleep(Math.max(0, ms), signal);
}

async function runOnce(
  index: number,
  plan: Plan,
  ctx: EngineContext,
  inj: ResolvedInjector,
  deps: ReliabilityDeps,
): Promise<RunAnalysis> {
  const { input } = plan;
  const clock = ctx.clock;
  const records: ReqRecord[] = [];
  const stack = new CleanupStack();
  const runCtl = new AbortController();
  const signal = AbortSignal.any([ctx.signal, ctx.safety.killSwitch, runCtl.signal]);
  const total = input.steady + input.duration + input.recovery;
  const recording = recordingExecutor(
    createUndiciExecutor({
      connections: 256,
      keepAlive: true,
      timeoutMs: input.workload.timeout,
      connectTimeoutMs: 5000,
      now: () => clock.now(),
      safety: ctx.safety as ExecutorSafety, // F6 (sw-perf)
    }),
    records,
  );
  const ledger = new OpLedger(
    `sw-${ctx
      .newId()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-10)}-r${index}`,
  );
  const tracksOps = plan.idempotency.size > 0 || plan.counted.size > 0;
  const executor = tracksOps
    ? opExecutor(recording, ledger, {
        routeHeader: ROUTE_HEADER,
        idempotency: plan.idempotency,
        counted: plan.counted,
        sleep: (ms, sig) => clock.sleep(ms, sig),
      })
    : recording;
  // Invariant baselines (count / conserved sums) before any workload traffic.
  let baselines: InvariantBaseline[] = [];
  let invariantResults: InvariantResult[] | null = null;
  if (input.invariants.length > 0) {
    const f = invariantFetcher(plan, ctx, ctx.signal);
    try {
      baselines = await takeBaselines(input.invariants, f.fetcher);
    } finally {
      await f.close();
    }
  }
  const origin = new URL(input.target).origin;
  const perfInput = {
    target: origin,
    model: "open" as const,
    rate: input.workload.rate,
    arrival: input.workload.arrival,
    duration: total,
    timeout: input.workload.timeout,
    gracefulStop: Math.min(input.workload.timeout, 3000),
    scenarios: routeScenarios(plan.routes),
    ...(input.seed !== undefined ? { seed: input.seed + index } : {}),
  };
  const t0 = clock.now();
  let tF0 = Number.NaN;
  let tF1 = Number.NaN;
  let steadyOk = true;
  let applied = false;
  let abortedEarly: string | null = null;
  let cancelled = false;
  const checks: ThresholdCheck[] = [];
  const perfP = runPerformance(
    perfInput as Parameters<typeof runPerformance>[0],
    { ...ctx, signal },
    { ...deps.perf, executor },
  ).then(
    (r) => r,
    (e: unknown) => e,
  );
  try {
    await deps.onPhase?.("steady", { run: index });
    await sleep(ctx, input.steady, signal);
    tF0 = clock.now();
    const steadyFrom = t0 + Math.min(500, input.steady / 4);
    checks.push(...evalChecks(plan.steadyTh, records, steadyFrom, tF0, "steady"));
    const steadyAll = phaseStats(records, steadyFrom, tF0);
    if (
      checks.some((c) => !c.passed) ||
      (steadyAll.requests > 0 && steadyAll.errors === steadyAll.requests)
    ) {
      steadyOk = false;
      runCtl.abort(new Error("steady state not met"));
    } else {
      // ---- inject
      const steps = input.ramp?.steps ?? 1;
      const ttl = input.duration + 5000;
      const appliedIds: { base: Fault; id: string }[] = [];
      for (const [i, f] of plan.faults.entries()) {
        const id = `sw-${ctx.newId()}-${i}`.toLowerCase();
        const fault: Fault = { ...scaleFault(f, 1, steps), id, ttlMs: ttl };
        const a = await inj.injector.apply(fault, signal);
        const unGlobal = registerGlobalCleanup(`reliability:${input.dependency}:${id}`, () => a.revert());
        stack.push(`revert ${id}`, async () => {
          unGlobal();
          await inj.injector.revert(id);
          ctx.safety.audit({ action: "fault.revert", target: input.dependency, detail: { id } });
        });
        ctx.safety.audit({
          action: "fault.apply",
          target: input.dependency,
          detail: { id, fault: describeFault(fault), ttlMs: ttl },
        });
        appliedIds.push({ base: f, id });
      }
      applied = true;
      tF0 = clock.now();
      ledger.phase = "fault";
      ctx.events.emit("reliability.fault", {
        run: index,
        phase: "applied",
        dependency: input.dependency,
        faults: plan.faults.map(describeFault),
      });
      await deps.onPhase?.("fault-applied", { run: index });
      // ---- observe (abort condition, ramp)
      const end = tF0 + input.duration;
      let step = 1;
      while (clock.now() < end) {
        await sleep(ctx, Math.min(250, end - clock.now()), signal);
        const now = clock.now();
        if (steps > 1) {
          const want = Math.min(steps, 1 + Math.floor(((now - tF0) / input.duration) * steps));
          if (want > step) {
            step = want;
            for (const { base, id } of appliedIds)
              await inj.injector.apply({ ...scaleFault(base, step, steps), id, ttlMs: ttl }, signal);
          }
        }
        if (input.abort && now - tF0 >= input.abort.graceMs) {
          let done = 0;
          let failed = 0;
          for (let i = records.length - 1; i >= 0; i--) {
            const r = records[i] as ReqRecord;
            if (r.end < now - 1000) break;
            done++;
            if (r.status === 0 || r.status >= 500) failed++;
          }
          if (done >= 5 && failed / done > input.abort.errorRate) {
            abortedEarly = `error rate ${((failed / done) * 100).toFixed(1)}% > abort threshold ${(input.abort.errorRate * 100).toFixed(1)}%`;
            ctx.log.warn("abort condition met: reverting fault early", { reason: abortedEarly });
            break;
          }
        }
      }
      await stack.runAll();
      tF1 = clock.now();
      ledger.phase = "recovery";
      ctx.events.emit("reliability.fault", { run: index, phase: "reverted", dependency: input.dependency });
      await deps.onPhase?.("fault-reverted", { run: index });
    }
  } catch (e) {
    if (ctx.signal.aborted || ctx.safety.killSwitch.aborted) cancelled = true;
    else {
      runCtl.abort(e);
      await stack.runAll();
      await perfP;
      throw e;
    }
  } finally {
    // Guaranteed revert (success, error, abort).
    const errs = await stack.runAll();
    if (Number.isNaN(tF1) && applied) tF1 = clock.now();
    ledger.phase = "recovery";
    for (const e of errs) ctx.log.error("fault revert failed", { name: e.name, error: String(e.error) });
  }
  const perf = await perfP;
  if (perf instanceof Error && !cancelled && steadyOk) throw perf;
  // ---- invariants after the recovery phase
  if (input.invariants.length > 0 && applied && steadyOk && !cancelled) {
    const f = invariantFetcher(plan, ctx, ctx.signal);
    try {
      invariantResults = scrubResults(
        await evaluateInvariants(input.invariants, baselines, f.fetcher, ledger, [
          ...plan.idempotency.keys(),
        ]),
        plan.redact,
      );
    } finally {
      await f.close();
    }
  }
  const operations: Record<string, RouteOpCounts> = {};
  for (const [route, c] of ledger.counts) operations[route] = { ...c };
  await deps.onPhase?.("run-done", { run: index });
  const tEnd = Math.max(clock.now(), t0 + total);
  return analyse(index, plan, inj, records, {
    t0,
    tF0,
    tF1,
    tEnd,
    steadyOk,
    applied,
    abortedEarly,
    cancelled,
    checks,
    invariants: invariantResults,
    operations: tracksOps ? operations : null,
  });
}

function analyse(
  index: number,
  plan: Plan,
  inj: ResolvedInjector,
  records: ReqRecord[],
  t: {
    t0: number;
    tF0: number;
    tF1: number;
    tEnd: number;
    steadyOk: boolean;
    applied: boolean;
    abortedEarly: string | null;
    cancelled: boolean;
    checks: ThresholdCheck[];
    invariants?: InvariantResult[] | null;
    operations?: Record<string, RouteOpCounts> | null;
  },
): RunAnalysis {
  const { input } = plan;
  const steadyFrom = t.t0 + Math.min(500, input.steady / 4);
  const tF0 = Number.isFinite(t.tF0) ? t.tF0 : t.t0 + input.steady;
  const tF1 = Number.isFinite(t.tF1) ? t.tF1 : tF0;
  // Steady stats only from requests that also finished before the fault (in-flight ones were hit by it).
  const steadyRecs = records.filter((r) => r.start < tF0 && r.end < tF0);
  const steady = phaseStats(steadyRecs, steadyFrom, tF0);
  const during = phaseStats(records, tF0, tF1);
  const recoveryPhase = phaseStats(records, tF1, t.tEnd);
  const routes = plan.routes.map((r) => ({
    route: r.name,
    steady: phaseStats(steadyRecs, steadyFrom, tF0, r.name),
    during: phaseStats(records, tF0, tF1, r.name),
  }));
  const arrivalsAll = inj.arrivals ? inj.arrivals(steadyFrom, t.tEnd) : null;
  const windows = windowize(records, arrivalsAll, steadyFrom, t.tEnd, {
    ref: tF0,
    ...(plan.affected ? { routes: plan.affected } : {}),
  });
  const base: RunAnalysis = {
    index,
    steadyOk: t.steadyOk,
    fault: { applied: t.applied, durationMs: t.applied ? tF1 - tF0 : 0, abortedEarly: t.abortedEarly },
    cancelled: t.cancelled,
    steady,
    during,
    recoveryPhase,
    routes,
    windows,
    recovery: null,
    amplification: null,
    jitter: null,
    breaker: null,
    timeout: null,
    isolation: [],
    checks: [...t.checks],
    detections: [],
    ...(t.invariants ? { invariants: t.invariants } : {}),
    ...(t.operations ? { operations: t.operations } : {}),
  };
  const det: Detection[] = base.detections;
  if (!t.steadyOk) {
    const failed = t.checks.filter((c) => !c.passed);
    det.push({
      ruleId: "reliability/steady-state-not-met",
      kind: "threshold",
      severity: "medium",
      title: `Steady state not met before injecting ${plan.input.scenario}: experiment not run`,
      description: failed.length
        ? `Failed: ${failed.map((c) => `${c.expression} (actual ${fmt(c.actual)})`).join(", ")}`
        : "Every request failed during the steady-state phase (target or dependency down?)",
      recommendation:
        "Fix the baseline (or relax the steady-state thresholds) before running fault experiments",
      metrics: [{ metric: "steady.error_rate", value: steady.errorRate, unit: "ratio" }],
    });
    return base;
  }
  if (!t.applied) return base;

  // ---- hypothesis
  const hypo = evalChecks(plan.hypoTh, records, tF0, tF1, "fault");
  base.checks.push(...hypo);
  const violated = hypo.filter((c) => !c.passed);
  if (violated.length > 0) {
    det.push({
      ruleId: "reliability/hypothesis-violated",
      kind: "threshold",
      severity: "medium",
      title: `Hypothesis violated under ${plan.faults.map(describeFault).join(" + ")} on ${input.dependency}`,
      description: violated.map((c) => `${c.expression}: actual ${fmt(c.actual)}`).join("; "),
      recommendation: "Add timeouts, fallbacks or bulkheads so the dependency failure stays contained",
      metrics: violated.map((c) => ({ metric: c.expression, value: c.actual, unit: "" })),
    });
  }

  // ---- recovery
  const steadyBoundsExplicit: { p95Ms?: number; errorRate?: number } = {};
  for (const th of plan.steadyTh) {
    if (th.scope !== "http" || (th.op !== "<" && th.op !== "<=")) continue;
    if (th.stat === "p95") steadyBoundsExplicit.p95Ms = th.value;
    if (th.stat === "error_rate") steadyBoundsExplicit.errorRate = th.value;
  }
  const bounds = deriveBounds(steady, steadyBoundsExplicit);
  const recWindows = windowize(records, null, tF1, t.tEnd);
  base.recovery = recoveryTime(recWindows, bounds);
  if (
    plan.detectors.has("recovery") &&
    !base.recovery.recovered &&
    recWindows.filter((w) => w.requests > 0).length >= 3 &&
    !t.cancelled
  ) {
    det.push({
      ruleId: "reliability/slow-recovery",
      kind: "detector",
      severity: "medium",
      title: `No recovery within ${Math.round(input.recovery / 1000)} s after ${input.dependency} was restored`,
      description: `p95 ≤ ${fmt(bounds.p95Ms)} ms and error rate ≤ ${fmt(bounds.errorRate * 100)}% did not hold for 3 consecutive 1 s windows after the revert.`,
      recommendation:
        "Check connection pools, caches and breakers that stay degraded after the dependency recovers",
      metrics: [
        { metric: "recovery.error_rate", value: recoveryPhase.errorRate, unit: "ratio" },
        { metric: "recovery.p95", value: recoveryPhase.p95, unit: "ms" },
      ],
    });
  }

  // ---- amplification + jitter
  const steadyWin = { from: steadyFrom, to: tF0 };
  const faultWin = { from: tF0, to: tF1 };
  if (inj.arrivals) {
    const arrivals = inj.arrivals(steadyFrom, t.tEnd);
    const amp = amplification(arrivals, records, steadyWin, faultWin, plan.affected);
    base.amplification = amp;
    const ampMetrics = [
      { metric: "retry.amplification", value: round2(amp.factor), unit: "x" },
      { metric: "dependency.calls_per_request", value: round2(amp.faultRatio), unit: "ratio" },
      { metric: "dependency.calls", value: amp.proxyRequests, unit: "count" },
      { metric: "client.requests", value: amp.clientRequests, unit: "count" },
    ];
    const faultArr = arrivals.filter((a) => a >= tF0 && a < tF1);
    const ctlArr = arrivals.filter((a) => a >= steadyFrom && a < tF0);
    if (plan.detectors.has("jitter") && amp.factor > 1.5) {
      base.jitter = detectSynchronizedRetries(faultArr, ctlArr);
    }
    const unbounded = amp.factor > 10;
    if (plan.detectors.has("amplification") && unbounded) {
      det.push({
        ruleId: "reliability/retry-without-backoff",
        kind: "detector",
        severity: "high",
        title: `Retry storm: ${round1(amp.factor)}x dependency calls per request to ${input.dependency} (unbounded retries without backoff)`,
        description: `While ${input.dependency} failed, ${amp.proxyRequests} calls were made for ${amp.clientRequests} client requests (${round1(amp.faultRatio)} per request; steady state ${amp.steadyRatio === null ? "n/a" : round2(amp.steadyRatio)}). Amplification above 10x means retries are not capped or backed off.`,
        recommendation:
          "Cap attempts (e.g. 3), use exponential backoff with full jitter, add a circuit breaker",
        metrics: ampMetrics,
      });
    } else if (base.jitter?.detected) {
      det.push({
        ruleId: "reliability/retry-without-jitter",
        kind: "detector",
        severity: "medium",
        title: `Synchronised retries to ${input.dependency}: constant ~${base.jitter.lagMs} ms retry delay without jitter`,
        description: `Dependency calls during the fault cluster at a fixed lag of ~${base.jitter.lagMs} ms (lag-histogram peak z=${round1(base.jitter.z)}, ${round1(base.jitter.ratio)}x background; steady-state control z=${base.jitter.controlZ === null ? "n/a" : round1(base.jitter.controlZ)}). Clients retry in lock-step, amplifying load ${round1(amp.factor)}x${amp.storm ? " (retry storm)" : ""}.`,
        recommendation: "Exponential backoff with full jitter: delay = random(0, min(cap, base·2^attempt))",
        metrics: [
          { metric: "retry.sync_lag", value: base.jitter.lagMs ?? 0, unit: "ms" },
          { metric: "retry.sync_z", value: round2(base.jitter.z), unit: "z" },
          ...ampMetrics,
        ],
      });
    } else if (plan.detectors.has("amplification") && amp.storm) {
      det.push({
        ruleId: "reliability/retry-storm",
        kind: "detector",
        severity: "medium",
        title: `Retry storm: ${round1(amp.factor)}x dependency calls per request to ${input.dependency}`,
        description: `Amplification ${round1(amp.factor)}x > 3x while ${input.dependency} was failing.`,
        recommendation: "Reduce attempts, add backoff with jitter and a retry budget / circuit breaker",
        metrics: ampMetrics,
      });
    }

    // ---- circuit breaker
    if (plan.detectors.has("breaker") && plan.sustained && input.duration >= 3000) {
      const fw = windowize(records, arrivals, tF0, tF1, plan.affected ? { routes: plan.affected } : {});
      const half = tF0 + (tF1 - tF0) / 2;
      base.breaker = detectCircuitBreaker(
        fw,
        amp.steadyRatio,
        arrivals.filter((a) => a >= half && a < tF1),
      );
      if (base.breaker.verdict === "no-breaker") {
        det.push({
          ruleId: "reliability/no-circuit-breaker",
          kind: "detector",
          severity: "medium",
          title: `No circuit breaker: ${input.dependency} keeps being called on every request during a sustained failure`,
          description: `In the second half of the fault, every client request still made ${round2(base.breaker.lateRatio ?? 0)} calls to ${input.dependency} (baseline ${base.breaker.baselineRatio === null ? "n/a" : round2(base.breaker.baselineRatio)}), with ${round1((base.breaker.lateErrorRate ?? 0) * 100)}% client errors and p50 ${fmt(base.breaker.lateP50 ?? Number.NaN)} ms (no fast-fail). ${base.breaker.reason}.`,
          recommendation:
            "Open a breaker after N consecutive failures; fail fast while open; probe with half-open requests after a cooldown",
          metrics: [
            {
              metric: "breaker.late_calls_per_request",
              value: round2(base.breaker.lateRatio ?? 0),
              unit: "ratio",
            },
            {
              metric: "breaker.late_error_rate",
              value: round2(base.breaker.lateErrorRate ?? 0),
              unit: "ratio",
            },
            { metric: "breaker.late_p50", value: round2(base.breaker.lateP50 ?? 0), unit: "ms" },
          ],
        });
      }
    }
  }

  // ---- timeout correctness
  const isBlackhole = plan.faults.some(
    (f) =>
      (f.type === "blackhole" || (f.type === "container" && f.action === "pause")) &&
      f.percent >= 100 &&
      !f.flapping,
  );
  if (plan.detectors.has("timeout") && isBlackhole) {
    const tol = Math.min(750, Math.max(250, (tF1 - tF0) / 8));
    base.timeout = assessTimeout(records, tF0, tF1, {
      toleranceMs: tol,
      budgetMs: input.maxOutboundBudget,
      ...(plan.affected ? { routes: plan.affected } : {}),
    });
    const to = base.timeout;
    if (to.verdict === "no-timeout") {
      det.push({
        ruleId: "reliability/outbound-no-timeout",
        kind: "detector",
        severity: "high",
        title: `No outbound timeout to ${input.dependency}: client latency tracks the black-hole instead of a timeout`,
        description: `While ${input.dependency} was black-holed for ${Math.round((tF1 - tF0) / 1000)} s, none of ${to.eligible} requests was answered; ${round1(to.trackingFraction * 100)}% completed only when the dependency came back (or hit the client timeout). Median latency ${fmt(to.medianLatencyMs ?? Number.NaN)} ms.`,
        recommendation:
          "Set a timeout on every outbound call (e.g. fetch(..., { signal: AbortSignal.timeout(2000) }))",
        metrics: [
          { metric: "timeout.answered_during_fault", value: to.completedDuringFault, unit: "count" },
          { metric: "timeout.tracking_fraction", value: round2(to.trackingFraction), unit: "ratio" },
          { metric: "timeout.median_latency", value: round2(to.medianLatencyMs ?? 0), unit: "ms" },
        ],
      });
    } else if (
      to.verdict === "timeout" &&
      input.expectTimeout !== undefined &&
      to.effectiveTimeoutMs !== null
    ) {
      const diff = Math.abs(to.effectiveTimeoutMs - input.expectTimeout);
      if (diff > Math.max(250, 0.25 * input.expectTimeout)) {
        det.push({
          ruleId: "reliability/timeout-mismatch",
          kind: "detector",
          severity: "medium",
          title: `Effective timeout to ${input.dependency} is ~${Math.round(to.effectiveTimeoutMs)} ms, configured ${Math.round(input.expectTimeout)} ms`,
          description: `Requests during the black-hole were answered after a median ${fmt(to.effectiveTimeoutMs)} ms; expected ≈ ${input.expectTimeout} ms ± 25%. Retries multiply the effective timeout.`,
          recommendation:
            "Align the outbound timeout × attempts with the latency budget of the calling route",
          metrics: [{ metric: "timeout.effective", value: round2(to.effectiveTimeoutMs), unit: "ms" }],
        });
      }
    }
  }

  // ---- duplicate-operation invariants (evaluated after the recovery phase)
  if (t.invariants) {
    for (const d of invariantDetections(t.invariants, {
      dependency: input.dependency,
      faults: plan.faults.map(describeFault),
      redact: plan.redact,
    })) {
      det.push({ ...d, kind: "detector" });
    }
  }

  // ---- isolation / propagation
  if (plan.detectors.has("isolation")) {
    const byRoute = new Map(routes.map((r) => [r.route, r]));
    base.isolation = assessIsolation(
      plan.routes,
      input.dependency,
      (r) => (byRoute.get(r)?.steady ?? steady) as PhaseStats,
      (r) => (byRoute.get(r)?.during ?? during) as PhaseStats,
    );
    for (const iso of base.isolation.filter((x) => x.isolationFailure)) {
      det.push({
        ruleId: "reliability/isolation-failure",
        kind: "detector",
        severity: "high",
        title: `Isolation failure: route ${iso.route} degraded although it does not depend on ${input.dependency}`,
        description: `${iso.reason}. A failure in ${input.dependency} propagates to unrelated routes (shared pool, event loop or thread starvation).`,
        recommendation:
          "Bulkhead the dependency (separate pools/concurrency limits), add timeouts, avoid busy retry loops",
        metrics: [
          { metric: `route.${iso.route}.error_rate`, value: round2(iso.fault.errorRate), unit: "ratio" },
          { metric: `route.${iso.route}.p95`, value: round2(iso.fault.p95), unit: "ms" },
        ],
      });
    }
  }
  return base;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}
function fmt(x: number): string {
  return Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : "n/a";
}

/** Config errors for invariants that reference unknown routes or cannot attribute operations. */
function validateInvariants(input: ReliabilityInput, routes: RouteSpec[]): void {
  const names = new Set(routes.map((r) => r.name));
  const idem = routes.filter((r) => r.idempotency).map((r) => r.name);
  const bad = (i: number, msg: string): never => {
    throw new ConfigError("SW_CONFIG_RELIABILITY", `invariants[${i}]: ${msg}`, {
      hint: "See docs/03-engines/reliability-lab.md §3 (duplicate operations)",
    });
  };
  for (const [i, inv] of input.invariants.entries()) {
    const cols = inv.type === "conserved" ? inv.terms : [inv];
    for (const c of cols) {
      if (c.headersFrom !== undefined && !names.has(c.headersFrom))
        bad(i, `headersFrom "${c.headersFrom}" is not a workload route`);
      try {
        parseCollectionRef(c.collection, input.target);
      } catch {
        bad(i, `invalid collection "${c.collection}"`);
      }
    }
    if (inv.type === "no-duplicates") {
      if (inv.scope === "workload" && idem.length === 0)
        bad(i, "no-duplicates needs a workload route with `idempotency` (or scope: all)");
      continue;
    }
    for (const r of inv.routes ?? []) if (!names.has(r)) bad(i, `route "${r}" is not a workload route`);
    if (!inv.routes && idem.length === 0)
      bad(i, `${inv.type} needs \`routes\` or a workload route with \`idempotency\``);
  }
}

/** Runs the experiment (all repetitions) and builds the EngineResult. */
export async function executeReliability(
  input: ReliabilityInput,
  ctx: EngineContext,
  deps: ReliabilityDeps = {},
): Promise<EngineResult<ReliabilityData>> {
  const startedAt = ctx.clock.isoNow();
  const runId = ctx.newId();
  const limitations: Limitation[] = [];
  const scenario = getScenario(input.scenario);
  if (!scenario && !input.fault) {
    throw new ConfigError("SW_CONFIG_RELIABILITY", `Unknown scenario "${input.scenario}"`, {
      hint: "Run `sw reliability list` for the catalogue, or pass a custom `fault`",
    });
  }
  const total = input.repeat * (input.steady + input.duration + input.recovery);
  if (total > input.maxDuration) {
    throw new ConfigError(
      "SW_CONFIG_RELIABILITY",
      `Experiment needs ${total} ms (repeat × (steady + duration + recovery)) > maxDuration ${input.maxDuration} ms`,
    );
  }
  const steadyTh = parseAll(input.steadyState, "steadyState");
  const hypoTh = parseAll(input.hypothesis, "hypothesis");

  // ---- blast radius / safety (docs/11 §2, reliability-lab §6)
  const safetyCfg = (ctx.safety as { config?: { environment?: string; maxDurationMs?: number } }).config;
  const environment = input.environment ?? safetyCfg?.environment ?? "local";
  if (environment === "production" && !input.allowProduction) {
    throw new SafetyError(
      "SW_SAFETY_PRODUCTION_FAULTS",
      "Fault injection in a production environment is blocked by default",
      {
        hint: "Use an isolated/staging environment, or set allowProduction: true and approve explicitly",
      },
    );
  }
  if (safetyCfg?.maxDurationMs !== undefined && total > safetyCfg.maxDurationMs) {
    throw new SafetyError(
      "SW_SAFETY_BUDGET",
      `Experiment duration ${total} ms exceeds safety.maxDuration ${safetyCfg.maxDurationMs} ms`,
    );
  }
  const target = new URL(input.target);
  const decision = ctx.safety.checkTarget(target);
  if (!decision.allowed) {
    throw new SafetyError(
      decision.code as `SW_SAFETY_${string}`,
      decision.reason,
      decision.hint ? { hint: decision.hint } : {},
    );
  }
  if (environment === "production")
    await ctx.safety.requireApproval(
      "production-target",
      `fault injection on ${input.dependency} (production)`,
    );
  await ctx.safety.requireApproval(
    "fault-injection",
    `${input.scenario} on dependency "${input.dependency}" for ${Math.round(input.duration / 1000)} s × ${input.repeat}`,
  );

  // ---- routes
  const routes: RouteSpec[] = input.workload.routes.length
    ? input.workload.routes
    : [
        {
          name: "default",
          method: "GET",
          path: `${target.pathname}${target.search}`,
          headers: {},
          weight: 1,
        },
      ];
  for (const r of routes) {
    if (r.auth !== undefined) {
      limitations.push({
        code: "RELIABILITY_AUTH_UNRESOLVED",
        message: `route "${r.name}": auth role "${r.auth}" was not resolved (not in config.auth, unsupported type, or secret missing); requests were sent without credentials`,
        impact: "reduces-confidence",
      });
    }
  }
  validateInvariants(input, routes);
  const withDeps = routes.filter((r) => r.dependsOn !== undefined);
  const affected = withDeps.length
    ? new Set(withDeps.filter((r) => r.dependsOn?.includes(input.dependency)).map((r) => r.name))
    : undefined;

  const mkResult = (
    status: EngineResult["status"],
    data: ReliabilityData | undefined,
    findings: EngineResult["findings"] = [],
  ): EngineResult<ReliabilityData> => ({
    schemaVersion: 1,
    engine: "reliability",
    runId,
    status,
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings,
    limitations,
    artifacts: [],
    ...(data ? { data } : {}),
  });

  // ---- injector + fault
  const resolved = await resolveInjector(input, ctx, deps);
  if ("limitation" in resolved) {
    limitations.push(resolved.limitation);
    return mkResult("skipped", undefined);
  }
  const inj = resolved;
  try {
    let faults: Fault[];
    if (input.fault) faults = [parseFault(input.fault)];
    else {
      const spec = input.dependencies[input.dependency];
      const b = scenario?.build(input.params, {
        injector: inj.kind,
        container: spec?.container,
        network: spec?.network,
      });
      if (!b?.ok) {
        limitations.push({
          code: "requires-adapter",
          message: b && !b.ok ? b.limitation : "scenario unavailable",
          impact: "invalidates",
        });
        return mkResult("skipped", undefined);
      }
      if (b.note) limitations.push({ code: "scenario-emulated", message: b.note, impact: "informational" });
      faults = [b.fault, ...extraFaults(input.scenario, input.params)].map((f: FaultInput) => parseFault(f));
    }
    const caps = await inj.injector.capabilities();
    for (const f of faults) {
      if (!caps.faults.includes(f.type)) {
        limitations.push({
          code: "requires-adapter",
          message: `${inj.injector.name} cannot inject "${f.type}"`,
          impact: "invalidates",
        });
        return mkResult("skipped", undefined);
      }
    }
    if (!caps.countsRequests) {
      limitations.push({
        code: "no-request-counting",
        message: `${inj.injector.name} does not count dependency calls: retry amplification, jitter and circuit-breaker detection are disabled (use the built-in proxy)`,
        impact: "reduces-confidence",
      });
    }
    const sustained = faults.some(
      (f) =>
        (f.type === "http-status" || f.type === "reset" || f.type === "blackhole") &&
        f.percent >= 90 &&
        !f.flapping,
    );
    const idempotency = new Map<string, IdempotencySpec>();
    for (const r of routes) if (r.idempotency) idempotency.set(r.name, r.idempotency);
    const counted = new Set<string>();
    for (const inv of input.invariants)
      for (const r of defaultCountedRoutes(inv, [...idempotency.keys()])) counted.add(r);
    const secrets: string[] = [];
    for (const r of routes) secrets.push(...Object.values(r.headers));
    for (const inv of input.invariants) {
      const cols = inv.type === "conserved" ? inv.terms : [inv];
      for (const c of cols) secrets.push(...Object.values(c.headers));
    }
    const redactor = createRedactor({ secrets });
    const plan: Plan = {
      input,
      faults,
      routes,
      affected,
      steadyTh,
      hypoTh,
      idempotency,
      counted,
      redact: (x) => redactor.redactString(x),
      detectors: new Set(
        input.fault
          ? ["amplification", "jitter", "breaker", "timeout", "recovery", "isolation"]
          : (scenario?.detectors ?? []),
      ),
      sustained,
    };
    if (routes.some((r) => r.dependsOn === undefined)) {
      limitations.push({
        code: "route-relations-unknown",
        message:
          "Some routes have no `dependsOn`: isolation (unrelated-route degradation) is only checked for routes with declared dependencies",
        impact: "informational",
      });
    }

    const runs: RunAnalysis[] = [];
    for (let i = 0; i < input.repeat; i++) {
      if (ctx.signal.aborted || ctx.safety.killSwitch.aborted) break;
      ctx.log.info("reliability run", {
        run: i + 1,
        of: input.repeat,
        scenario: input.scenario,
        dependency: input.dependency,
      });
      const r = await runOnce(i, plan, ctx, inj, deps);
      runs.push(r);
      if (!r.steadyOk || r.cancelled) break;
    }
    const cancelled = runs.some((r) => r.cancelled) || ctx.signal.aborted;
    // Partial collections (pagination bound / loop / refused link) → the invariant is not trusted.
    const partialSeen = new Set<string>();
    for (const r of runs)
      for (const inv of r.invariants ?? []) {
        if (!inv.partial || partialSeen.has(inv.name)) continue;
        partialSeen.add(inv.name);
        limitations.push({
          code: "invariant-partial-collection",
          message: `invariant "${inv.name}" was evaluated on a partial collection (${inv.partial.join("; ")}), so its result is not trusted${inv.status === "violated" ? " beyond the duplicates it lists" : ""}`,
          impact: "reduces-confidence",
        });
      }
    // Black-hole watched for too short a time to tell "no timeout" from "long timeout chain".
    const shortRun = runs.find((r) => r.timeout?.windowTooShort);
    if (shortRun?.timeout) {
      const to = shortRun.timeout;
      limitations.push({
        code: "timeout-window-too-short",
        message: `Outbound timeout to ${input.dependency} not assessed: nothing was answered during the black-hole, but the longest observed wait was ${Math.round(to.longestWaitMs ?? 0)} ms (client timeout ${input.workload.timeout} ms, fault ${input.duration} ms) < maxOutboundBudget ${to.budgetMs} ms, so an outbound timeout chain (timeout × attempts + backoff) longer than that cannot be ruled out. Raise workload.timeout and the fault duration above the suspected budget, or set maxOutboundBudget to the app's real budget.`,
        impact: "reduces-confidence",
      });
    }
    const data: ReliabilityData = {
      schema: 1,
      scenario: input.scenario,
      dependency: input.dependency,
      injector: inj.injector.name,
      faults: faults.map(describeFault),
      environment,
      phases: { steadyMs: input.steady, faultMs: input.duration, recoveryMs: input.recovery },
      workload: {
        rate: input.workload.rate,
        arrival: input.workload.arrival,
        routes: routes.map((r) => r.name),
      },
      repeat: input.repeat,
      verdict: "held",
      reproduced: [],
      runs,
      methods: {
        workload:
          "Open-model Poisson arrivals via the Performance Lab; one continuous run per repetition (steady → fault → recovery)",
        failure: "Failure = transport error or HTTP 5xx; latency = client send → body consumed",
        windows: "1 s windows by request start time",
        recovery:
          "First window after revert from which 3 consecutive windows with traffic keep p95 and error rate within steady-state bounds",
        amplification:
          "Dependency calls seen by the proxy ÷ client requests (affected routes), fault vs steady state; storm > 3x",
        jitter:
          "Lag histogram (pairwise inter-arrival lags 10–1000 ms, 5 ms bins) of dependency calls = autocorrelation of the arrival process; strongest 20 ms-window peak (or 10 ms-window peak for precise timers, when it is not a lattice) z ≥ 5 and ≥ 1.25x the p90 of all window sums of that width (robust to timer-tick lattices), absent from the steady-state control",
        breaker:
          "Second half of a sustained failure: calls per request ≤ 0.5× baseline → breaker; ≥ 0.8× with ≥ 50% client errors → no breaker",
        timeout:
          "Black-holed dependency: requests answered during the fault → timeout present; none answered, latency tracking the revert/client timeout AND ≥ 3 requests observed waiting ≥ maxOutboundBudget → no timeout; none answered within a shorter observable window → inconclusive (limitation timeout-window-too-short)",
        ...(input.invariants.length > 0
          ? {
              invariants:
                "One key per logical operation (reused on client retries). After the recovery phase: no-duplicates = at most 1 resource per workload key; count-matches = resources created (after - before) within [confirmed, confirmed + ambiguous] x perOperation; conserved = change of the weighted sum within perOperation x [confirmed, confirmed + ambiguous] +/- tolerance. Ambiguous = timeout/reset/5xx without success (may have been applied once). Paginated collections (offset/page/cursor/link) are read page by page within bounds; a collection read only partially makes its invariant untrusted (error), except duplicates actually found.",
            }
          : {}),
      },
    };
    const okRuns = runs.filter((r) => r.steadyOk && r.fault.applied);
    data.verdict =
      okRuns.length === 0 || cancelled
        ? "inconclusive"
        : okRuns.some((r) => r.checks.some((c) => c.phase === "fault" && !c.passed))
          ? "violated"
          : "held";
    const { findings, reproduced } = buildFindings(data, ctx, input);
    data.reproduced = reproduced;
    const status: EngineResult["status"] = cancelled
      ? "cancelled"
      : runs.some((r) => !r.steadyOk) ||
          data.verdict === "violated" ||
          findings.some((f) => f.severity !== "info" && f.severity !== "low")
        ? "failed"
        : "passed";
    return mkResult(status, data, findings);
  } finally {
    // Never leave a fault behind (also covers faults applied by a crashed repetition).
    // Faults applied by this engine are reverted per run (cleanup stack); owned injectors are closed
    // (close reverts everything). Injectors passed in by the caller keep the caller's own faults.
    if (inj.owned) {
      try {
        await inj.injector.close();
      } catch (e) {
        ctx.log.error("injector close failed", { error: String(e) });
      }
    }
  }
}

export { ENGINE_VERSION };
