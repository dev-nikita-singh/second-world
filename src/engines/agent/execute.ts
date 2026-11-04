/**
 * Scenario execution on top of the API Bug Hunter machinery (docs/03-engines/adversarial-test-agent.md
 * §2 "execute in approved env"). A validated Scenario is compiled into a bugs `BugCase` and run
 * with `runCase` on a bugs Session: same HTTP client (safety target check, budget lease,
 * mutation gate, redaction, barrier bursts, 429 back-off), same `{{var}}` substitution and the
 * same curl reproduction. The agent then evaluates its own explicit assertions on the exchanges.
 */
import { fingerprint } from "../../shared/util/fingerprint.js";
import { type BugCase, type CaseStep, conformance, runCase } from "../bugs/cases.js";
import type { Operation } from "../bugs/contract.js";
import { type Exchange, jsonAt, type RequestTemplate, ROLE_INVALID } from "../bugs/http.js";
import { getPointer, jsonType } from "../bugs/json-schema.js";
import type { Session } from "../bugs/session.js";
import type { CoverageTracker } from "./coverage.js";
import { responseShape } from "./coverage.js";
import { normalizeOperationKey } from "./safety.js";
import {
  AGENT_RULES,
  type AgentRule,
  assertionOperation,
  parallelStep,
  type Scenario,
  type ScenarioAssertion,
  type Step,
} from "./scenario.js";

export interface AgentFailure {
  assertion: number;
  kind: ScenarioAssertion["kind"];
  rule: AgentRule;
  operation: string;
  pointer: string;
  message: string;
  step: number;
  status: number;
  fingerprint: string;
}

export interface ScenarioRun {
  inconclusive: boolean;
  reason?: string;
  /** Exchanges per setup step / per step (several for parallel copies). */
  setup: Exchange[][];
  steps: Exchange[][];
  exchanges: Exchange[];
  failures: AgentFailure[];
}

const DEFAULT_RULE: Record<ScenarioAssertion["kind"], AgentRule> = {
  status: "agent/assertion-failed",
  "status-class": "agent/assertion-failed",
  "no-5xx": "bugs/server-error",
  "same-json": "agent/assertion-failed",
  "copies-agree": "agent/assertion-failed",
  "max-success": "bugs/race-lost-update",
  json: "agent/assertion-failed",
  "max-duration": "agent/slow-response",
  "schema-valid": "bugs/schema-mismatch",
};

export function ruleOf(a: ScenarioAssertion): AgentRule {
  return a.rule ?? DEFAULT_RULE[a.kind];
}

/**
 * One defect = (rule, operation, pointer). The assertion kind is deliberately not part of it:
 * a sequential and a concurrent duplicate-submit check that both fail are the same defect.
 */
export function failureFingerprint(rule: string, operation: string, pointer: string): string {
  return fingerprint(["agent", rule, operation, pointer]);
}

function replaceNonce<T>(v: T, nonce: string, depth = 0): T {
  if (depth > 32) return v;
  if (typeof v === "string") return v.replace(/\{\{\s*\$nonce\s*\}\}/g, nonce) as T;
  if (Array.isArray(v)) return v.map((x) => replaceNonce(x, nonce, depth + 1)) as T;
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = replaceNonce(x, nonce, depth + 1);
    return o as T;
  }
  return v;
}

export function compileStep(st: Step, ops: ReadonlyMap<string, Operation>): RequestTemplate {
  const op = ops.get(normalizeOperationKey(st.operation));
  if (!op) throw new Error(`unknown operation ${st.operation}`);
  const tpl: RequestTemplate = {
    operation: op.key,
    method: op.method,
    path: op.path,
    pathParams: { ...(st.pathParams ?? {}) },
    query: { ...(st.query ?? {}) },
    headers: { ...(st.headers ?? {}) },
    body: st.body === undefined ? { kind: "none" } : { kind: "json", value: st.body },
    secured: op.secured,
  };
  if (st.role !== undefined) tpl.role = st.role === "$invalid" ? ROLE_INVALID : st.role;
  return tpl;
}

/** Compiles a scenario into a replayable bugs BugCase (setup steps first). */
export function toBugCase(
  s: Scenario,
  ops: ReadonlyMap<string, Operation>,
  seed: number,
  nonce: string,
): BugCase {
  const sc = replaceNonce(s, nonce);
  const pstep = parallelStep(sc);
  const steps: CaseStep[] = [];
  for (const st of sc.setup) {
    const cs: CaseStep = {
      request: compileStep(st, ops),
      expect: "none",
      label: `setup: ${st.label ?? st.operation}`,
    };
    if (st.extract) cs.extract = st.extract;
    steps.push(cs);
  }
  sc.steps.forEach((st, i) => {
    const cs: CaseStep = { request: compileStep(st, ops), expect: "none", label: st.label ?? st.operation };
    if (st.extract) cs.extract = st.extract;
    if (pstep === i && sc.parallel) cs.burst = sc.parallel.copies;
    steps.push(cs);
  });
  return {
    id: `agent-${nonce}`,
    technique: "stateful",
    operation: sc.steps[sc.steps.length - 1]?.operation ?? "",
    label: sc.title,
    seed,
    steps,
    check: { kind: "conformance" },
  };
}

const is2xx = (s: number): boolean => s >= 200 && s < 300;
const show = (v: unknown): string => {
  const t = JSON.stringify(v);
  return t === undefined ? "undefined" : t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

type Verdict =
  | { ok: true }
  | { ok: false; message: string; status: number; pointer?: string; rule?: AgentRule }
  | { inconclusive: string };

function evalAssertion(
  a: ScenarioAssertion,
  s: Scenario,
  steps: Exchange[][],
  session: Pick<Session, "contract" | "env">,
  stepIndexOffset: number,
): Verdict {
  const exs = (i: number): Exchange[] => (steps[i] ?? []).filter((e) => !e.error && !e.blocked);
  const first = (i: number): Exchange | undefined => exs(i)[0];
  switch (a.kind) {
    case "status": {
      const bad = exs(a.step).find((e) => !a.oneOf.includes(e.status));
      return bad
        ? {
            ok: false,
            message: `step ${a.step} answered ${bad.status}, expected one of ${a.oneOf.join("/")}`,
            status: bad.status,
          }
        : { ok: true };
    }
    case "status-class": {
      const test = {
        "2xx": is2xx,
        "4xx": (x: number) => x >= 400 && x < 500,
        "not-2xx": (x: number) => !is2xx(x),
        "not-5xx": (x: number) => x < 500,
      }[a.class];
      const bad = exs(a.step).find((e) => !test(e.status));
      return bad
        ? {
            ok: false,
            message: `step ${a.step} answered ${bad.status}, expected ${a.class}`,
            status: bad.status,
          }
        : { ok: true };
    }
    case "no-5xx": {
      for (const [i, list] of steps.entries())
        for (const e of list)
          if (!e.error && e.status >= 500)
            return {
              ok: false,
              message: `step ${i} (${e.method} ${e.url}) answered ${e.status}`,
              status: e.status,
            };
      return { ok: true };
    }
    case "same-json": {
      const [x, y] = [first(a.steps[0]), first(a.steps[1])];
      if (!x || !y || !is2xx(x.status)) return { inconclusive: `step ${a.steps[0]} did not succeed` };
      if (!is2xx(y.status)) return { ok: true };
      const va = jsonAt(x, a.pointer);
      const vb = jsonAt(y, a.pointer);
      return va !== undefined && JSON.stringify(va) !== JSON.stringify(vb)
        ? {
            ok: false,
            message: `${a.pointer}: ${show(va)} then ${show(vb)}`,
            status: y.status,
            pointer: a.pointer,
          }
        : { ok: true };
    }
    case "copies-agree": {
      const ok = exs(a.step).filter((e) => is2xx(e.status));
      if (ok.length === 0) return { inconclusive: "no copy succeeded" };
      const vals = new Set(ok.map((e) => JSON.stringify(jsonAt(e, a.pointer))));
      return vals.size > 1
        ? {
            ok: false,
            message: `${ok.length} successful copies returned ${vals.size} different ${a.pointer} values`,
            status: ok[0]?.status ?? 0,
            pointer: a.pointer,
          }
        : { ok: true };
    }
    case "max-success": {
      const list = exs(a.step);
      const n = list.filter((e) => is2xx(e.status)).length;
      return n > a.max
        ? {
            ok: false,
            message: `${n} of ${list.length} concurrent copies succeeded (max ${a.max}); statuses [${list.map((e) => e.status).join(", ")}]`,
            status: list.find((e) => is2xx(e.status))?.status ?? 0,
          }
        : { ok: true };
    }
    case "json": {
      const e = first(a.step);
      if (!e) return { inconclusive: `step ${a.step} has no response` };
      const v = e.json === undefined ? undefined : getPointer(e.json, a.pointer);
      if (a.exists !== undefined && (v !== undefined) !== a.exists)
        return {
          ok: false,
          message: `${a.pointer} ${a.exists ? "missing" : "present"}`,
          status: e.status,
          pointer: a.pointer,
        };
      if (
        a.equals !== undefined &&
        !(a.ifPresent && v === undefined) &&
        JSON.stringify(v) !== JSON.stringify(a.equals)
      )
        return {
          ok: false,
          message: `${a.pointer}=${show(v)} != ${show(a.equals)}`,
          status: e.status,
          pointer: a.pointer,
        };
      if (a.type !== undefined && v !== undefined) {
        const t = jsonType(v);
        if (!(t === a.type || (a.type === "number" && t === "integer")))
          return {
            ok: false,
            message: `${a.pointer} is ${t}, expected ${a.type}`,
            status: e.status,
            pointer: a.pointer,
          };
      }
      return { ok: true };
    }
    case "max-duration": {
      const slow = exs(a.step).find((e) => e.durationMs > a.ms);
      const timedOut = (steps[a.step] ?? []).find((e) => e.error && /timeout/i.test(e.error));
      if (timedOut) return { ok: false, message: `step ${a.step} timed out (${timedOut.error})`, status: 0 };
      return slow
        ? {
            ok: false,
            message: `step ${a.step} took ${slow.durationMs.toFixed(0)} ms > ${a.ms} ms`,
            status: slow.status,
          }
        : { ok: true };
    }
    case "schema-valid": {
      const e = first(a.step);
      const op = session.env.opsByKey.get(normalizeOperationKey(s.steps[a.step]?.operation ?? ""));
      if (!e || !op || !session.contract) return { inconclusive: "no response / contract" };
      const f = conformance(op, e, "valid", a.step + stepIndexOffset, undefined, session.contract).filter(
        (x) => !x.observation,
      );
      const f0 = f[0];
      if (!f0) return { ok: true };
      const known = (AGENT_RULES as readonly string[]).includes(f0.ruleId)
        ? (f0.ruleId as AgentRule)
        : undefined;
      return {
        ok: false,
        message: f0.message,
        status: e.status,
        pointer: f0.pointer,
        ...(known ? { rule: known } : {}),
      };
    }
  }
}

/**
 * Executes one compiled scenario (caller runs the reset hook before). Records coverage when a
 * tracker is given; returns failures of explicit assertions.
 */
export async function executeScenario(
  s: Scenario,
  session: Session,
  nonce: string,
  coverage?: CoverageTracker,
): Promise<ScenarioRun & { newCoverage: number }> {
  const bc = toBugCase(s, session.env.opsByKey, session.seed, nonce);
  const run = await runCase(bc, session.env);
  // Split the flat exchange list per step (bursts contribute `burst` exchanges).
  const perStep: Exchange[][] = [];
  let k = 0;
  for (const st of bc.steps) {
    const n = st.burst ?? 1;
    perStep.push(run.exchanges.slice(k, k + n));
    k += n;
  }
  const setup = perStep.slice(0, s.setup.length);
  const steps = perStep.slice(s.setup.length);
  let newCoverage = 0;
  if (coverage) {
    let prev: string | undefined;
    bc.steps.forEach((cs, i) => {
      const list = perStep[i] ?? [];
      const tpl = cs.request;
      for (const p of [...Object.keys(tpl.pathParams), ...Object.keys(tpl.query)])
        if (list.length > 0 && coverage.mark("param", tpl.operation, p)) newCoverage++;
      if (tpl.body.kind === "json" && tpl.body.value !== null && typeof tpl.body.value === "object")
        for (const p of Object.keys(tpl.body.value as object))
          if (list.length > 0 && coverage.mark("param", tpl.operation, `body.${p}`)) newCoverage++;
      for (const e of list) {
        if (e.error || e.blocked) continue;
        if (coverage.mark("status", e.operation, e.status)) newCoverage++;
        if (coverage.mark("branch", e.operation, e.status, responseShape(e.json))) newCoverage++;
        if (prev !== undefined && coverage.mark("trans", prev, e.operation, e.status)) newCoverage++;
      }
      if (list[0]) prev = tpl.operation;
    });
  }
  const base = { setup, steps, exchanges: run.exchanges, newCoverage };
  const fail = (
    ai: number,
    a: ScenarioAssertion,
    v: { message: string; status: number; pointer?: string; rule?: AgentRule },
  ): AgentFailure => {
    const rule = a.rule ?? v.rule ?? ruleOf(a);
    const operation = normalizeOperationKey(assertionOperation(s, a));
    const pointer = v.pointer ?? ("pointer" in a ? a.pointer : "");
    return {
      assertion: ai,
      kind: a.kind,
      rule,
      operation,
      pointer,
      message: v.message,
      step: a.kind === "same-json" ? a.steps[1] : a.kind === "no-5xx" ? s.steps.length - 1 : a.step,
      status: v.status,
      fingerprint: failureFingerprint(rule, operation, pointer),
    };
  };
  if (run.inconclusive) {
    // A timeout is a conclusive failure for an explicit max-duration assertion (slow-dependency tests).
    if (/timeout/i.test(run.reason ?? "")) {
      const timeouts: AgentFailure[] = [];
      for (const [ai, a] of s.assertions.entries()) {
        if (a.kind !== "max-duration") continue;
        const v = evalAssertion(a, s, steps, session, s.setup.length);
        if (!("inconclusive" in v) && !v.ok) timeouts.push(fail(ai, a, v));
      }
      if (timeouts.length > 0) return { ...base, inconclusive: false, failures: timeouts };
    }
    return { ...base, inconclusive: true, reason: run.reason ?? "inconclusive", failures: [] };
  }
  for (const [i, list] of setup.entries()) {
    const e = list[0];
    if (!e || !is2xx(e.status))
      return {
        ...base,
        inconclusive: true,
        reason: `setup step ${i} answered ${e?.status ?? "nothing"}`,
        failures: [],
      };
  }
  const failures: AgentFailure[] = [];
  for (const [ai, a] of s.assertions.entries()) {
    const v = evalAssertion(a, s, steps, session, s.setup.length);
    if ("inconclusive" in v) return { ...base, inconclusive: true, reason: v.inconclusive, failures: [] };
    if (v.ok) continue;
    failures.push(fail(ai, a, v));
  }
  return { ...base, inconclusive: false, failures };
}
