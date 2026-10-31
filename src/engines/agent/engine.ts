/**
 * Adversarial Test Agent run loop — docs/03-engines/adversarial-test-agent.md §2–§6,
 * docs/04-data-structures-and-algorithms.md §8.1 (bandit), §7.4 (ddmin).
 *
 *   collect context → pick arm (bandit) → proposal → validate (schema + safety + budget)
 *   → execute → assert → record coverage & evidence → update arm score
 *
 * Bounded by iterations, requests (hard cap enforced by the budget lease), time, "no new
 * information for k rounds" and cancellation. A new failing assertion is replayed after a reset
 * (bugs `classifyReplays`, Wilson) and multi-step scenarios are minimised with bugs `ddmin`.
 * Execution reuses the Bug Hunter session (same HTTP client, safety checks, redaction).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult, Evidence, Finding, Limitation } from "../../core/evidence/schemas.js";
import { createFinding } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import { sha256 } from "../../shared/util/hash.js";
import { ddmin } from "../bugs/algorithms/ddmin.js";
import { classifyReplays, type ReplayClassification } from "../bugs/classify.js";
import { matchesPattern, type Operation } from "../bugs/contract.js";
import { BudgetExhausted, type Exchange, ROLE_INVALID } from "../bugs/http.js";
import { isObject, normalize, primaryType } from "../bugs/json-schema.js";
import { RULES, type RuleId } from "../bugs/rules.js";
import { type BugsInput, BugsInputSchema } from "../bugs/schema.js";
import { openSession, type Session } from "../bugs/session.js";
import { type Bandit, createBandit } from "./bandit.js";
import { extractArchHints, extractHistory } from "./context.js";
import { CoverageTracker, NoveltySet } from "./coverage.js";
import { type AgentFailure, compileStep, executeScenario, type ScenarioRun } from "./execute.js";
import { type SuggestedTest, suggestedTest } from "./export.js";
import { HeuristicPlanner } from "./planner/heuristic.js";
import type { Arm, Planner, PlanState } from "./planner/types.js";
import { type SafetyPolicy, validateProposal } from "./safety.js";
import {
  type AgentRule,
  canonicalJson,
  parallelStep,
  parseScenario,
  requestCount,
  type Scenario,
  type ScenarioAssertion,
  scenarioFingerprint,
} from "./scenario.js";
import type { AgentInput, AgentTechnique } from "./schema.js";

export const ENGINE_VERSION = "0.1.0";

/** Rules whose failures are reported as observations (not defects) even when they reproduce. */
const OBSERVATION_RULES = new Set<AgentRule>([
  "agent/accepts-invalid-input",
  "agent/slow-response",
  "bugs/undocumented-status",
]);
const MAX_HYPOTHESES = 500;

/** Titles/severities for agent-specific rules (bugs/* rules use the Bug Hunter's RULES table). */
const AGENT_RULE_INFO: Record<
  string,
  {
    title: string;
    severity: "info" | "low" | "medium" | "high";
    category: "bug" | "performance";
    recommendation: string;
  }
> = {
  "agent/assertion-failed": {
    title: "Assertion failed",
    severity: "low",
    category: "bug",
    recommendation: "Review the failing assertion against the intended behaviour",
  },
  "agent/accepts-invalid-input": {
    title: "Invalid input accepted",
    severity: "low",
    category: "bug",
    recommendation: "Validate the input against the documented limits and answer 400",
  },
  "agent/slow-response": {
    title: "Slow response",
    severity: "low",
    category: "performance",
    recommendation: "Profile the operation (see the architecture hint) and bound its latency",
  },
  "agent/idempotency-key-race": {
    title: "Idempotency-Key not enforced for concurrent duplicates",
    severity: "medium",
    category: "bug",
    recommendation:
      "Reserve the key atomically before doing the work (insert-if-absent / unique constraint), then replay the stored response",
  },
};
const MAX_REJECTED = 200;

export type StopReason = "iterations" | "requests" | "time" | "no-new-info" | "cancelled" | "arms-exhausted";

export type HypothesisOutcome =
  | "passed"
  | "failed"
  | "inconclusive"
  | "confirmed"
  | "flaky"
  | "not-reproduced"
  | "observation";

export interface HypothesisRecord {
  iteration: number;
  arm: string;
  technique: AgentTechnique | "regression";
  operation: string;
  source: string;
  title: string;
  hypothesis: string;
  fingerprint: string;
  outcome: HypothesisOutcome;
  reason?: string;
  requests: number;
  newCoverage: number;
  failures: string[];
}

export interface RejectedProposal {
  source: string;
  arm?: string;
  title?: string;
  reasons: string[];
}

export interface AgentFindingSummary {
  id: string;
  fingerprint: string;
  ruleId: string;
  operation: string;
  technique: string;
  classification: "reproduced-defect" | "observation";
  severity: string;
  title: string;
  hypothesis: string;
  message: string;
  flaky: boolean;
  failures: number;
  replays: number;
  rate: number;
  wilson: { lower: number; upper: number };
  minimized: boolean;
  /** The (minimised) scenario: replayable with `agent.regression`. */
  scenario: Scenario;
  curl: string[];
  exchanges: {
    step: number;
    method: string;
    url: string;
    status: number;
    durationMs: number;
    error?: string;
  }[];
}

export interface AgentData {
  schema: 1;
  planner: "heuristic";
  bandit: "ucb1" | "thompson";
  target: string;
  seed: number;
  contract: { source: string; hash: string; operations: number };
  findings: AgentFindingSummary[];
  coverage: {
    /** Documented (operation, status) pairs observed / documented, in %. */
    percent: number;
    documented: { observed: number; total: number };
    bits: Record<"status" | "branch" | "param" | "trans", number>;
  };
  hypotheses: HypothesisRecord[];
  rejected: RejectedProposal[];
  rejectedTotal: number;
  budget: {
    iterations: { used: number; max: number };
    requests: { used: number; max: number; replays: number };
    durationMs: { used: number; max?: number };
    stopReason: StopReason;
  };
  arms: Record<string, { pulls: number; reward: number; mean: number }>;
  suggestedTests: SuggestedTest[];
  mutationsAllowed: boolean;
}

export interface AgentDeps {
  /** Planner factory (tests). Default: heuristic. */
  planner?: (env: PlannerEnv) => Planner | Promise<Planner>;
  /** Session opener (tests). */
  openSession?: (input: BugsInput, ctx: EngineContext) => Promise<Session>;
}

export interface PlannerEnv {
  input: AgentInput;
  ctx: EngineContext;
  session: Session;
  ops: Operation[];
  heuristic: HeuristicPlanner;
  limitations: Limitation[];
}

interface Candidate {
  failure: AgentFailure;
  scenario: Scenario;
  arm: Arm | { key: string; technique: "regression"; operation: string };
  source: string;
  run: ScenarioRun;
  stats?: ReplayClassification & { inconclusive: number };
  failingRun?: ScenarioRun;
  minimized: boolean;
  occurrences: number;
}

export function toBugsInput(input: AgentInput): BugsInput {
  const budget: Record<string, unknown> = { maxRequests: input.budget.maxRequests };
  if (input.budget.maxRps !== undefined) budget.maxRps = input.budget.maxRps;
  if (input.budget.maxConcurrency !== undefined) budget.maxConcurrency = input.budget.maxConcurrency;
  if (input.budget.maxDuration !== undefined) budget.maxDuration = input.budget.maxDuration;
  return BugsInputSchema.parse({
    target: input.target,
    openapi: input.openapi,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.allowMutations === undefined ? {} : { allowMutations: input.allowMutations }),
    techniques: [],
    operations: input.operations,
    replays: input.replays,
    maxReplays: input.maxReplays,
    minimize: input.minimize,
    timeout: input.timeout,
    headers: input.headers,
    auth: input.auth,
    hooks: input.hooks,
    values: input.values,
    budget,
  });
}

async function loadContextResults(input: AgentInput): Promise<Record<string, unknown>[]> {
  const out = [...input.context.results];
  const cwd = input.cwd ?? process.cwd();
  for (const f of input.context.files) {
    const p = isAbsolute(f) ? f : resolve(cwd, f);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(p, "utf8"));
    } catch (e) {
      throw new ConfigError(
        "SW_CONFIG_AGENT_CONTEXT",
        `Cannot read context report ${f}: ${(e as Error).message}`,
      );
    }
    const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.results) ? raw.results : [raw];
    for (const r of list) if (isObject(r)) out.push(r);
  }
  return out;
}

function allowedHosts(input: AgentInput, ctx: EngineContext): string[] {
  const hosts = new Set<string>([new URL(input.target).hostname.replace(/^\[|\]$/g, "")]);
  const cfg = (ctx.safety as { config?: { allowHosts?: string[] } }).config;
  for (const h of cfg?.allowHosts ?? []) {
    if (h.includes("*")) continue;
    hosts.add(h.replace(/^\[|\]$/g, "").replace(/:\d+$/, ""));
  }
  return [...hosts];
}

function selectOps(s: Session, input: AgentInput): Operation[] {
  const { include, exclude } = input.operations;
  return (s.contract?.operations ?? []).filter(
    (o) =>
      (include.length === 0 || include.some((p) => matchesPattern(o, p))) &&
      !exclude.some((p) => matchesPattern(o, p)),
  );
}

function shapeOf(
  op: Operation | undefined,
  s: Session,
): { required: string[]; types: Record<string, string> } | undefined {
  if (!op || !s.contract) return undefined;
  const ok = op.responses.find((r) => /^2\d\d$/.test(r.status));
  const media = ok ? Object.values(ok.content)[0] : undefined;
  if (!media?.schema) return undefined;
  const sch = normalize(media.schema, s.contract.resolver);
  if (!isObject(sch.properties)) return undefined;
  const types: Record<string, string> = {};
  for (const [k, v] of Object.entries(sch.properties)) {
    const t = primaryType(normalize(v, s.contract.resolver));
    if (t && t !== "null") types[k] = t;
  }
  return {
    required: Array.isArray(sch.required)
      ? (sch.required as string[]).filter((x) => typeof x === "string")
      : [],
    types,
  };
}

export async function executeAgent(
  input: AgentInput,
  ctx: EngineContext,
  deps: AgentDeps = {},
): Promise<EngineResult<AgentData>> {
  const startedAt = ctx.clock.isoNow();
  const t0 = ctx.clock.now();
  const runId = ctx.newId();
  const bugsInput = toBugsInput(input);
  const s = await (deps.openSession ?? openSession)(bugsInput, ctx);
  const limitations: Limitation[] = [...s.limitations];
  if (!s.contract || !s.gen) {
    await s.close();
    throw new ConfigError(
      "SW_CONFIG_AGENT",
      "The agent needs an OpenAPI contract (steps may only reference contract operations)",
    );
  }
  const contract = s.contract;
  const ops = selectOps(s, input);
  const opsByKey = new Map(ops.map((o) => [o.key, o]));
  const results = await loadContextResults(input);
  const history = input.techniques.includes("history") ? extractHistory(results, opsByKey) : [];
  const hints = input.techniques.includes("arch-risk") ? extractArchHints(results, opsByKey) : [];
  const heuristic = new HeuristicPlanner({
    g: s.gen,
    ops,
    techniques: input.techniques,
    history,
    hints,
    maxCopies: input.maxCopies,
    slowMs: input.slowMs,
    ...(input.resources === undefined ? {} : { resources: input.resources }),
  });
  const planner: Planner = deps.planner
    ? await deps.planner({ input, ctx, session: s, ops, heuristic, limitations })
    : heuristic;

  const coverage = new CoverageTracker();
  for (const o of ops)
    for (const r of o.responses) if (/^\d{3}$/.test(r.status)) coverage.addDocumented(o.key, r.status);
  const novelty = new NoveltySet(input.novelty);
  const bandit: Bandit = createBandit(input.bandit, ctx.rng.fork("agent-bandit"), input.exploration);
  const credentialHeaders = Object.values(input.auth.roles)
    .filter((c): c is Extract<typeof c, { type: "header" }> => c.type === "header")
    .map((c) => c.name);
  const maxRequests = input.budget.maxRequests;
  const sent = (): number => s.http.stats.sent;
  const remaining = (): number => Math.max(0, maxRequests - sent());
  const policy = (): SafetyPolicy => ({
    operations: opsByKey,
    roles: Object.keys(input.auth.roles),
    credentialHeaders,
    allowedHosts: allowedHosts(input, ctx),
    mutationsAllowed: s.mutationsAllowed,
    destructiveAllowed: input.allowDestructive,
    destructivePatterns: input.destructive,
    maxPayloadBytes: input.maxPayloadBytes,
    maxCopies: input.maxCopies,
    remainingRequests: remaining(),
  });
  const audit = ctx.safety.audit.bind(ctx.safety);

  const hypotheses: HypothesisRecord[] = [];
  const rejected: RejectedProposal[] = [];
  const rejectedKeys = new Set<string>();
  let rejectedTotal = 0;
  const candidates = new Map<string, Candidate>();
  const confirmed = new Set<string>();
  let iteration = 0;
  let replayRequests = 0;
  let sinceNew = 0;
  let stopReason: StopReason = "arms-exhausted";
  let budgetHit = false;
  let nonceCounter = 0;
  const nonce = (): string => `sw-${s.seed}-${runId.slice(-6)}-${++nonceCounter}`;

  const reject = (r: RejectedProposal): void => {
    rejectedTotal++;
    const key = `${r.source}|${r.title ?? ""}|${r.reasons.join(";")}`;
    if (rejectedKeys.has(key) || rejected.length >= MAX_REJECTED) return;
    rejectedKeys.add(key);
    rejected.push(r);
  };

  /** Reset → run; returns undefined when the budget does not allow another run. */
  const runOnce = async (
    sc: Scenario,
    cov?: CoverageTracker,
  ): Promise<(ScenarioRun & { newCoverage: number }) | undefined> => {
    if (requestCount(sc) > remaining()) return undefined;
    await s.hooks.run("reset");
    return executeScenario(sc, s, nonce(), cov);
  };

  const replay = async (c: Candidate): Promise<void> => {
    let failures = 0;
    let runs = 0;
    let inconclusive = 0;
    let target = input.replays;
    let attempts = 0;
    while (runs < target && attempts < target * 2 + 2) {
      attempts++;
      if (ctx.signal.aborted) break;
      const before = sent();
      const run = await runOnce(c.scenario);
      if (!run) {
        limitations.push({
          code: "AGENT_REPLAY_BUDGET",
          message: `Replays of "${c.scenario.title}" stopped: request budget exhausted (${runs} conclusive replays)`,
          impact: "reduces-confidence",
        });
        break;
      }
      replayRequests += sent() - before;
      if (run.inconclusive) {
        inconclusive++;
        continue;
      }
      runs++;
      if (run.failures.some((f) => f.fingerprint === c.failure.fingerprint)) {
        failures++;
        c.failingRun ??= run;
      }
      if (runs === target && failures > 0 && failures < runs && target < input.maxReplays)
        target = input.maxReplays;
    }
    c.stats = { ...classifyReplays({ failures, runs }), inconclusive };
  };

  /** ddmin over setup steps and steps no assertion references (each test = reset + run). */
  const minimise = async (c: Candidate): Promise<void> => {
    const sc = c.scenario;
    const pinned = new Set<number>();
    const ps = parallelStep(sc);
    if (ps !== undefined) pinned.add(ps);
    for (const a of sc.assertions) {
      if (a.kind === "same-json") for (const x of a.steps) pinned.add(x);
      else if (a.kind === "no-5xx") pinned.add(sc.steps.length - 1);
      else pinned.add(a.step);
    }
    const items: { kind: "setup" | "step"; idx: number }[] = [
      ...sc.setup.map((_, idx) => ({ kind: "setup" as const, idx })),
      ...sc.steps.map((_, idx) => ({ kind: "step" as const, idx })).filter((x) => !pinned.has(x.idx)),
    ];
    if (items.length === 0) return;
    const build = (keep: typeof items): Scenario | undefined => {
      const setupIdx = keep.filter((k) => k.kind === "setup").map((k) => k.idx);
      const stepIdx = [
        ...new Set([...pinned, ...keep.filter((k) => k.kind === "step").map((k) => k.idx)]),
      ].sort((a, b) => a - b);
      const map = new Map(stepIdx.map((old, i) => [old, i]));
      const m = (i: number): number => map.get(i) ?? 0;
      const assertions = sc.assertions.map((a): ScenarioAssertion => {
        if (a.kind === "same-json") return { ...a, steps: [m(a.steps[0]), m(a.steps[1])] };
        if (a.kind === "no-5xx") return a;
        return { ...a, step: m(a.step) };
      });
      const next = {
        ...sc,
        setup: setupIdx.map((i) => sc.setup[i]),
        steps: stepIdx.map((i) => sc.steps[i]),
        assertions,
        ...(sc.parallel
          ? { parallel: { ...sc.parallel, ...(ps === undefined ? {} : { step: m(ps) }) } }
          : {}),
      };
      const p = parseScenario(next);
      return p.ok ? p.scenario : undefined;
    };
    const fails = async (keep: typeof items): Promise<boolean> => {
      const cand = build(keep);
      if (!cand || ctx.signal.aborted) return false;
      const before = sent();
      const run = await runOnce(cand);
      replayRequests += sent() - before;
      return !!run && !run.inconclusive && run.failures.some((f) => f.fingerprint === c.failure.fingerprint);
    };
    // ddmin assumes a non-empty failing core; try the empty removable set first.
    const kept = (await fails([]))
      ? []
      : items.length < 2
        ? items
        : (await ddmin(items, fails, { maxTests: 20 })).result;
    if (kept.length < items.length) {
      const min = build(kept);
      if (min) {
        c.scenario = min;
        c.minimized = true;
      }
    }
  };

  const outcomeOf = (c: Candidate): HypothesisOutcome => {
    if (OBSERVATION_RULES.has(c.failure.rule) || c.scenario.expectedClassification === "contract-gap")
      return "observation";
    if (!c.stats || c.stats.runs === 0) return "failed";
    if (c.stats.classification === "observation") return "not-reproduced";
    return c.stats.flaky ? "flaky" : "confirmed";
  };

  /** Executes one validated scenario and records everything; returns the arm reward. */
  const attempt = async (sc: Scenario, arm: Candidate["arm"], source: string): Promise<number> => {
    const before = sent();
    const run = await runOnce(sc, coverage);
    if (!run) return 0;
    iteration++;
    const rec: HypothesisRecord = {
      iteration,
      arm: arm.key,
      technique: arm.technique,
      operation: arm.operation,
      source,
      title: sc.title,
      hypothesis: sc.hypothesis,
      fingerprint: scenarioFingerprint(sc),
      outcome: run.inconclusive ? "inconclusive" : run.failures.length > 0 ? "failed" : "passed",
      requests: sent() - before,
      newCoverage: run.newCoverage,
      failures: [],
    };
    if (run.reason !== undefined) rec.reason = run.reason;
    let reward = run.newCoverage > 0 ? 1 : 0;
    for (const f of run.failures) {
      rec.failures.push(f.fingerprint);
      const known = candidates.get(f.fingerprint);
      if (known) {
        known.occurrences++;
        continue;
      }
      const c: Candidate = { failure: f, scenario: sc, arm, source, run, minimized: false, occurrences: 1 };
      candidates.set(f.fingerprint, c);
      const observationOnly = OBSERVATION_RULES.has(f.rule) || sc.expectedClassification === "contract-gap";
      if (!observationOnly) {
        await replay(c);
        if (
          input.minimize &&
          c.stats?.classification === "reproduced-defect" &&
          !c.stats.flaky &&
          sc.setup.length + sc.steps.length > 2
        )
          await minimise(c);
        if (c.stats?.classification === "reproduced-defect") {
          confirmed.add(`${f.rule}|${f.operation}`);
          reward = 1;
        }
      } else reward = Math.max(reward, 0.5);
      rec.outcome = outcomeOf(c);
    }
    if (hypotheses.length < MAX_HYPOTHESES) hypotheses.push(rec);
    (planner as { note?: (arm: string, line: string) => void }).note?.(
      arm.key,
      `${sc.title}: ${rec.outcome}`,
    );
    ctx.events.emit("agent.iteration", {
      runId,
      iteration,
      arm: arm.key,
      outcome: rec.outcome,
      requests: sent(),
      coverage: coverage.documentedRatio().ratio,
    });
    return reward;
  };

  const rejectedRaw = new Set<string>();
  const consider = (raw: unknown, source: string, armKey?: string): Scenario | undefined => {
    // A proposal rejected once is rejected again (the remaining budget only shrinks): skip it silently.
    let rawKey: string;
    try {
      rawKey = sha256(canonicalJson(raw)).slice(0, 32);
    } catch {
      rawKey = "";
    }
    if (rawKey !== "" && rejectedRaw.has(rawKey)) return undefined;
    const v = validateProposal(raw, policy(), audit, source);
    if (!v.ok) {
      if (rawKey !== "" && rejectedRaw.size < 100_000) rejectedRaw.add(rawKey);
      const r: RejectedProposal = { source, reasons: v.reasons.slice(0, 10) };
      if (armKey) r.arm = armKey;
      if (v.title !== undefined) r.title = v.title;
      reject(r);
      return undefined;
    }
    return novelty.add(scenarioFingerprint(v.scenario)) ? v.scenario : undefined;
  };

  const stopCheck = (): StopReason | undefined => {
    if (ctx.signal.aborted) return "cancelled";
    if (iteration >= input.budget.maxIterations) return "iterations";
    if (remaining() <= 0) return "requests";
    if (input.budget.maxDuration !== undefined && ctx.clock.now() - t0 >= input.budget.maxDuration)
      return "time";
    if (sinceNew >= input.budget.patience) return "no-new-info";
    return undefined;
  };

  try {
    await s.hooks.run("setup");
    // Pinned regression scenarios first.
    for (const raw of input.regression) {
      const stop = stopCheck();
      if (stop) {
        stopReason = stop;
        break;
      }
      const sc = consider(raw, "regression");
      if (sc) {
        const op = sc.steps[sc.steps.length - 1]?.operation ?? "";
        await attempt(sc, { key: `regression ${op}`, technique: "regression", operation: op }, "regression");
      }
    }
    const arms = planner.arms();
    const exhausted = new Set<string>();
    for (;;) {
      const stop = stopCheck();
      if (stop) {
        stopReason = stop;
        break;
      }
      const live = arms.filter((a) => !exhausted.has(a.key));
      if (live.length === 0) {
        stopReason = "arms-exhausted";
        break;
      }
      const key = bandit.select(live.map((a) => a.key));
      const arm = live.find((a) => a.key === key) as Arm;
      const state: PlanState = { coverage, iteration, confirmed, signal: ctx.signal };
      const proposals = await planner.propose(arm, state);
      let chosen: Scenario | undefined;
      for (const raw of proposals) {
        chosen = consider(raw, arm.technique === "history" ? "history" : "heuristic", arm.key);
        if (chosen) break;
      }
      if (!chosen) {
        exhausted.add(arm.key);
        continue;
      }
      const reward = await attempt(chosen, arm, planner.kind);
      bandit.update(arm.key, reward);
      sinceNew = reward > 0 ? 0 : sinceNew + 1;
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) {
      await s.close();
      throw err;
    }
    budgetHit = true;
    stopReason = ctx.signal.aborted ? "cancelled" : "requests";
  }
  if (stopReason === "requests" || budgetHit)
    limitations.push({
      code: "AGENT_BUDGET_EXHAUSTED",
      message: `Request budget of ${maxRequests} requests used up; the search stopped early`,
      impact: "informational",
    });

  // ---------------------------------------------------------------- findings
  const findings: Finding[] = [];
  const summaries: AgentFindingSummary[] = [];
  const suggested: SuggestedTest[] = [];
  for (const c of candidates.values()) {
    const f = c.failure;
    const info =
      (f.rule in RULES ? RULES[f.rule as RuleId] : undefined) ??
      AGENT_RULE_INFO[f.rule] ??
      (AGENT_RULE_INFO["agent/assertion-failed"] as (typeof AGENT_RULE_INFO)[string]);
    const observationOnly =
      OBSERVATION_RULES.has(f.rule) || c.scenario.expectedClassification === "contract-gap";
    const cls = observationOnly || !c.stats ? classifyReplays({ failures: 0, runs: 0 }) : c.stats;
    const reproduced = !observationOnly && cls.classification === "reproduced-defect";
    const run = c.failingRun ?? c.run;
    const allSteps = [...c.scenario.setup, ...c.scenario.steps];
    const tpls = allSteps.map((st) => compileStep(st, opsByKey));
    const curl = tpls.map((t) => s.http.curl(t));
    const exchanges = run.exchanges.slice(0, 64).map((e: Exchange, i) => ({
      step: i,
      method: e.method,
      url: e.url,
      status: e.status,
      durationMs: Math.round(e.durationMs * 100) / 100,
      ...(e.error ? { error: e.error } : {}),
    }));
    const failEx = run.steps[f.step]?.[0];
    const evidence: Evidence[] = [];
    if (failEx)
      evidence.push({
        kind: "http-exchange",
        requestHash: f.fingerprint,
        method: failEx.method,
        url: failEx.url,
        status: failEx.status,
      });
    evidence.push({ kind: "note", text: `${f.message}. Hypothesis: ${c.scenario.hypothesis}` });
    if (c.stats && c.stats.runs > 0)
      evidence.push({
        kind: "measurement",
        metric: "replay.failure_rate",
        value: cls.rate,
        unit: "ratio",
        runId,
      });
    const severity = reproduced ? info.severity : "info";
    const title = `${info.title}: ${f.operation}${f.pointer ? ` (${f.pointer})` : ""}`.slice(0, 200);
    const steps = allSteps.map((st, i) => `${i + 1}. ${st.operation}${st.label ? ` — ${st.label}` : ""}`);
    if (s.hooks.has("reset")) steps.unshift("0. run the reset hook (known state)");
    const technique = c.arm.technique;
    const finding = createFinding(
      {
        engine: "agent",
        ruleId: f.rule,
        category: info.category,
        title,
        description: `${f.message}. Scenario "${c.scenario.title}" (${technique}, ${c.source} planner). ${
          observationOnly
            ? "Recorded as an observation (contract gap / informational rule)."
            : c.stats && c.stats.runs > 0
              ? `Replayed ${c.stats.runs}x after reset: failed ${c.stats.failures}/${c.stats.runs}${cls.flaky ? ` (flaky, Wilson 95 % [${(cls.wilson.lower * 100).toFixed(0)}, ${(cls.wilson.upper * 100).toFixed(0)}] %)` : ""}.`
              : "Not replayed (budget)."
        }`,
        severity,
        classification: reproduced ? "reproduced-defect" : "observation",
        confidence: reproduced ? cls.confidence : observationOnly ? 0.5 : 0.3,
        evidence,
        affected: [f.operation],
        reproduction: {
          steps,
          command: "sw agent (agent.regression: see suggested config)",
          seed: s.seed,
          artifacts: [],
        },
        recommendation: info.recommendation,
        occurrences: Math.max(1, c.occurrences),
        tags: [
          "agent",
          technique,
          c.source,
          ...(cls.flaky ? ["flaky"] : []),
          ...(c.minimized ? ["minimized"] : []),
        ],
        fingerprint: f.fingerprint,
      },
      { newId: ctx.newId, clock: ctx.clock },
    );
    findings.push(finding);
    summaries.push({
      id: finding.id,
      fingerprint: f.fingerprint,
      ruleId: f.rule,
      operation: f.operation,
      technique,
      classification: finding.classification as "reproduced-defect" | "observation",
      severity,
      title,
      hypothesis: c.scenario.hypothesis,
      message: f.message,
      flaky: cls.flaky,
      failures: cls.failures,
      replays: cls.runs,
      rate: cls.rate,
      wilson: cls.wilson,
      minimized: c.minimized,
      scenario: c.scenario,
      curl,
      exchanges,
    });
    if (reproduced) {
      const roles = tpls.map((t) => {
        const r = t.role === ROLE_INVALID ? null : t.role;
        return r === undefined ? (t.secured ? (s.roles.default ?? null) : null) : r;
      });
      const shapes: Record<number, { required: string[]; types: Record<string, string> }> = {};
      allSteps.forEach((st, i) => {
        const sh = shapeOf(opsByKey.get(st.operation.trim().replace(/^(\S+)/, (m) => m.toUpperCase())), s);
        if (sh) shapes[i] = sh;
      });
      suggested.push(
        suggestedTest(c.scenario, {
          fingerprint: f.fingerprint,
          ruleId: f.rule,
          operation: f.operation,
          target: input.target,
          roles,
          requests: tpls.map((t) => ({ method: t.method, path: t.path })),
          credentials: input.auth.roles,
          shapes,
        }),
      );
    }
  }
  const docs = coverage.documentedRatio();
  const data: AgentData = {
    schema: 1,
    planner: planner.kind,
    bandit: input.bandit,
    target: input.target,
    seed: s.seed,
    contract: { source: contract.source, hash: contract.hash, operations: ops.length },
    findings: summaries,
    coverage: {
      percent: Math.round(docs.ratio * 1000) / 10,
      documented: { observed: docs.observed, total: docs.total },
      bits: coverage.counts(),
    },
    hypotheses,
    rejected,
    rejectedTotal,
    budget: {
      iterations: { used: iteration, max: input.budget.maxIterations },
      requests: { used: sent(), max: maxRequests, replays: replayRequests },
      durationMs: {
        used: ctx.clock.now() - t0,
        ...(input.budget.maxDuration === undefined ? {} : { max: input.budget.maxDuration }),
      },
      stopReason,
    },
    arms: bandit.stats(),
    suggestedTests: suggested,
    mutationsAllowed: s.mutationsAllowed,
  };
  const st = s.http.stats;
  await s.close();
  const cancelled = stopReason === "cancelled";
  // Every request failed at transport level: nothing was tested, so this is not a pass.
  const targetUnreachable = st.sent > 0 && st.transportErrors === st.sent;
  if (targetUnreachable) {
    limitations.push({
      code: "target-unreachable",
      message: `All ${st.sent} requests failed at transport level (connection refused / timeout). Is ${input.target} running?`,
      impact: "invalidates",
    });
  }
  const hasDefect = findings.some((f) => f.classification === "reproduced-defect");
  const status = cancelled
    ? "cancelled"
    : targetUnreachable
      ? "error"
      : hasDefect
        ? "failed"
        : budgetHit
          ? "partial"
          : "passed";
  ctx.events.emit("agent.done", {
    runId,
    iterations: iteration,
    findings: findings.length,
    defects: findings.filter((f) => f.classification === "reproduced-defect").length,
    stopReason,
  });
  return {
    schemaVersion: 1,
    engine: "agent",
    runId,
    status,
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings,
    limitations,
    artifacts: [],
    data,
  };
}
