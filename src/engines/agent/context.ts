/**
 * Planner context from earlier results — docs/03-engines/adversarial-test-agent.md §1
 * ("mutation of previous failures, architecture risks").
 *
 * - History: reproduced defects of earlier Bug Hunter runs (their replayable BugCase) and of
 *   earlier agent runs (their scenario) become re-check scenarios.
 * - Architecture hints: Architecture Inspector findings (ARCH0xx rule ids) mapped to contract
 *   operations, used for targeted probes (e.g. ARCH005 → larger page sizes).
 * Everything produced here is a proposal and goes through the safety validator like any other.
 */
import type { CaseStep } from "../bugs/cases.js";
import type { Operation } from "../bugs/contract.js";
import { ROLE_EXPIRED, ROLE_INVALID } from "../bugs/http.js";
import { normalizeOperationKey } from "./safety.js";
import type { AgentRule, ScenarioInput } from "./scenario.js";
import { AGENT_RULES } from "./scenario.js";

export interface HistoryItem {
  ruleId: string;
  operation: string;
  source: "bugs" | "agent";
  fingerprint: string;
  scenario: ScenarioInput;
}

export interface ArchHint {
  ruleId: string;
  title: string;
  operations: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const asRule = (r: string): AgentRule | undefined =>
  (AGENT_RULES as readonly string[]).includes(r) ? (r as AgentRule) : undefined;

function stepOf(cs: CaseStep): ScenarioInput["steps"][number] | undefined {
  const t = cs.request;
  if (t.body.kind === "raw") return undefined;
  const st: ScenarioInput["steps"][number] = { operation: t.operation };
  if (t.role === ROLE_INVALID || t.role === ROLE_EXPIRED) st.role = "$invalid";
  else if (t.role !== undefined) st.role = t.role;
  const scalars = (o: Record<string, unknown>): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(o))
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    return out;
  };
  if (Object.keys(t.pathParams).length > 0) st.pathParams = scalars(t.pathParams);
  if (Object.keys(t.query).length > 0) {
    const q: Record<string, string | number | boolean | (string | number | boolean)[]> = {};
    for (const [k, v] of Object.entries(t.query)) {
      if (Array.isArray(v))
        q[k] = v.filter((x) => ["string", "number", "boolean"].includes(typeof x)) as string[];
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") q[k] = v;
    }
    st.query = q;
  }
  if (Object.keys(t.headers).length > 0) st.headers = { ...t.headers };
  if (t.body.kind === "json") st.body = t.body.value as never;
  if (cs.extract) st.extract = { ...cs.extract };
  if (cs.label) st.label = cs.label.slice(0, 200);
  return st;
}

/** Converts a recorded Bug Hunter case into a re-check scenario. */
export function scenarioFromBugCase(
  bc: { steps: CaseStep[]; check: { kind: string } & Obj; label?: string },
  ruleId: string,
  operation: string,
  idempotencyHeader?: string,
): ScenarioInput | undefined {
  const all = bc.steps.map(stepOf);
  if (all.some((s) => s === undefined) || all.length === 0) return undefined;
  const steps = all as ScenarioInput["steps"];
  const rule = asRule(ruleId);
  const title = `Re-check ${ruleId} on ${operation}`.slice(0, 200);
  const hypothesis = `An earlier run reported ${ruleId} on ${operation}; check whether it still happens`;
  const base = { title, hypothesis, expectedClassification: "defect" as const };
  const chk = bc.check;
  // Burst steps become parallel copies.
  const burstIdx = bc.steps.findIndex((s) => (s.burst ?? 1) > 1);
  if (chk.kind === "denied" && typeof chk.step === "number") {
    const k = chk.step;
    if (k <= 0 || k >= steps.length || k > 10) return undefined;
    const r = asRule(String(chk.rule)) ?? rule;
    return {
      ...base,
      setup: steps.slice(0, k),
      steps: steps.slice(k, k + 1),
      assertions: [{ kind: "status-class", step: 0, class: "not-2xx", ...(r ? { rule: r } : {}) }],
    };
  }
  if (chk.kind === "idempotent" && steps.length >= 2) {
    const two = steps.slice(0, 2).map((s) => {
      const h = { ...(s.headers ?? {}) };
      if (idempotencyHeader && h[idempotencyHeader] !== undefined) h[idempotencyHeader] = "{{$nonce}}";
      return { ...s, headers: h };
    });
    return {
      ...base,
      steps: two,
      assertions: [
        {
          kind: "same-json",
          steps: [0, 1],
          pointer: typeof chk.pointer === "string" ? chk.pointer : "/id",
          rule: "bugs/idempotency-key-ignored",
        },
      ],
    };
  }
  if (steps.length > 50) return undefined;
  const last = steps.length - 1;
  const failing =
    [...steps.keys()].reverse().find((i) => normalizeOperationKey(steps[i]?.operation ?? "") === operation) ??
    last;
  const sc: ScenarioInput = { ...base, steps, assertions: [] };
  if (burstIdx >= 0)
    sc.parallel = { copies: Math.min(50, Math.max(2, bc.steps[burstIdx]?.burst ?? 2)), step: burstIdx };
  if (ruleId === "bugs/schema-mismatch")
    sc.assertions.push({ kind: "schema-valid", step: failing, rule: "bugs/schema-mismatch" });
  else if (chk.kind === "round-trip" && typeof chk.read === "number")
    sc.assertions.push({
      kind: "status-class",
      step: Math.min(last, chk.read),
      class: "2xx",
      rule: "bugs/state-model-mismatch",
    });
  else if (chk.kind === "model") {
    for (const [i, cs] of bc.steps.entries()) {
      if (typeof cs.expect === "object" && sc.assertions.length < 19)
        sc.assertions.push({
          kind: "status",
          step: i,
          oneOf: cs.expect.status.slice(0, 20),
          rule: "bugs/state-model-mismatch",
        });
    }
  }
  sc.assertions.push({ kind: "no-5xx", ...(rule && ruleId.startsWith("bugs/server-error") ? { rule } : {}) });
  return sc;
}

/** Reproduced defects from earlier bugs/agent results, as re-check scenarios. */
export function extractHistory(
  results: readonly Obj[],
  ops: ReadonlyMap<string, Operation>,
  max = 50,
): HistoryItem[] {
  const out: HistoryItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const engine = r.engine;
    const findings = Array.isArray(r.findings) ? (r.findings as Obj[]) : [];
    const data = isObj(r.data) ? r.data : {};
    for (const f of findings) {
      if (out.length >= max) return out;
      if (f.classification !== "reproduced-defect" || typeof f.fingerprint !== "string") continue;
      if (seen.has(f.fingerprint)) continue;
      const ruleId = typeof f.ruleId === "string" ? f.ruleId : "";
      const operation = normalizeOperationKey(String((f.affected as unknown[] | undefined)?.[0] ?? ""));
      if (!ops.has(operation)) continue;
      let scenario: ScenarioInput | undefined;
      if (engine === "bugs") {
        const rep = isObj(data.reproductions)
          ? (data.reproductions[f.fingerprint] as Obj | undefined)
          : undefined;
        const bc = rep && isObj(rep.case) ? rep.case : undefined;
        if (bc && Array.isArray(bc.steps) && isObj(bc.check))
          scenario = scenarioFromBugCase(
            bc as never,
            ruleId,
            operation,
            ops.get(operation)?.idempotencyHeader,
          );
      } else if (engine === "agent") {
        const list = Array.isArray(data.findings) ? (data.findings as Obj[]) : [];
        const hit = list.find((x) => x.fingerprint === f.fingerprint);
        if (hit && isObj(hit.scenario)) scenario = hit.scenario as unknown as ScenarioInput;
      }
      if (!scenario) continue;
      seen.add(f.fingerprint);
      out.push({
        ruleId,
        operation,
        source: engine === "agent" ? "agent" : "bugs",
        fingerprint: f.fingerprint,
        scenario,
      });
    }
  }
  return out;
}

/** "GET /orders/:id" → "GET /orders/{id}". */
function routeKey(s: string): string | undefined {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i.exec(s.trim());
  if (!m) return undefined;
  return `${(m[1] ?? "").toUpperCase()} ${(m[2] ?? "").replace(/:([A-Za-z_]\w*)/g, "{$1}").replace(/\/$/, "") || "/"}`;
}

/** Architecture Inspector findings mapped to contract operations. */
export function extractArchHints(results: readonly Obj[], ops: ReadonlyMap<string, Operation>): ArchHint[] {
  const out: ArchHint[] = [];
  for (const r of results) {
    if (r.engine !== "architecture" || !Array.isArray(r.findings)) continue;
    for (const f of r.findings as Obj[]) {
      const ruleId = typeof f.ruleId === "string" ? f.ruleId.toUpperCase() : "";
      if (!/^ARCH\d{3}$/.test(ruleId)) continue;
      const title = typeof f.title === "string" ? f.title : "";
      const text = `${title} ${typeof f.description === "string" ? f.description : ""}`;
      const matched = new Set<string>();
      for (const a of (f.affected as unknown[] | undefined) ?? []) {
        const k = typeof a === "string" ? routeKey(a) : undefined;
        if (k && ops.has(k)) matched.add(k);
      }
      for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:{}.-]*)/g)) {
        const k = routeKey(`${m[1]} ${m[2]}`);
        if (k && ops.has(k)) matched.add(k);
      }
      out.push({ ruleId, title: title.slice(0, 200), operations: [...matched] });
    }
  }
  return out;
}
