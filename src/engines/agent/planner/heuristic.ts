/**
 * Heuristic planner (default, no AI) — docs/03-engines/adversarial-test-agent.md §1.
 *
 * Proposes ordinary API test cases per arm (operation × technique):
 * - status-gap: documented status codes not yet observed (401 anonymous call on a secured
 *   operation, 404 for an id that does not exist, 400 for a missing required field);
 * - param-gap: optional query parameters not yet exercised, with a valid value;
 * - boundary: boundary pairs on bounded numeric params/body fields (min-1/min, max/max+1);
 * - idempotency / idempotency-concurrent: duplicate submit with the same Idempotency-Key
 *   (sequential, then concurrent copies) when the contract documents the header;
 * - ownership: cross-account access on `{id}` items using the configured test accounts
 *   (owner creates and reads, the other account must not read);
 * - privilege: privileged operations called with an ordinary test account;
 * - lifecycle: create → read-back round trip;
 * - concurrency: concurrent copies of a create (no 5xx);
 * - history: re-checks of earlier reproduced defects;
 * - arch-risk: probes from architecture hints (ARCH005 → larger page sizes, ARCH001 →
 *   response-time bound on outbound-calling operations, ARCH004 → concurrent copies with a
 *   time bound, ARCH007 → anonymous call).
 * All values come from the contract, configured values and harvested ids. Output is a list
 * of untrusted proposals; the engine validates each one.
 */
import type { Operation } from "../../bugs/contract.js";
import {
  baseRequest,
  type DerivedResource,
  deriveResources,
  type GenContext,
  isPrivileged,
} from "../../bugs/generate.js";
import { numericBounds, sampleValid } from "../../bugs/generators/sample.js";
import type { RequestTemplate } from "../../bugs/http.js";
import { getPointer, isObject, type JsonSchema, normalize, primaryType } from "../../bugs/json-schema.js";
import type { ArchHint, HistoryItem } from "../context.js";
import type { ScenarioInput, Step } from "../scenario.js";
import type { AgentTechnique } from "../schema.js";
import { type Arm, armKey, type Planner, type PlanState } from "./types.js";

export interface HeuristicOptions {
  g: GenContext;
  /** Operations the agent may plan for (already include/exclude-filtered). */
  ops: Operation[];
  techniques: readonly AgentTechnique[];
  history?: HistoryItem[];
  hints?: ArchHint[];
  maxCopies: number;
  slowMs: number;
}

type NumericField = {
  where: "query" | "path" | "body";
  name: string;
  pointer: string;
  lo: number;
  hi: number;
  integer: boolean;
};

const PAGE_PARAM = /^(limit|page_?size|per_?page|size|count|take|max)$/i;

function toStep(tpl: RequestTemplate, label?: string): Step {
  const st: Step = { operation: tpl.operation };
  if (tpl.role !== undefined) st.role = tpl.role;
  const scal = (o: Record<string, unknown>): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(o))
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
      else if (v !== undefined) out[k] = JSON.stringify(v);
    return out;
  };
  if (Object.keys(tpl.pathParams).length > 0) st.pathParams = scal(tpl.pathParams);
  if (Object.keys(tpl.query).length > 0) st.query = scal(tpl.query);
  if (Object.keys(tpl.headers).length > 0) st.headers = { ...tpl.headers };
  if (tpl.body.kind === "json") st.body = tpl.body.value as never;
  if (label) st.label = label;
  return st;
}

function setPointer(root: unknown, pointer: string, value: unknown): unknown {
  const copy = structuredClone(root);
  const segs = pointer.split("/").slice(1);
  let cur: unknown = copy;
  for (const [i, seg] of segs.entries()) {
    const last = i === segs.length - 1;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (last) cur[idx] = value;
      else cur = cur[idx];
    } else if (isObject(cur)) {
      if (last) cur[seg] = value;
      else cur = cur[seg];
    } else return copy;
  }
  return copy;
}

const scenario = (
  title: string,
  hypothesis: string,
  steps: Step[],
  assertions: ScenarioInput["assertions"],
  extra: Partial<ScenarioInput> = {},
): ScenarioInput => ({
  title: title.slice(0, 200),
  hypothesis: hypothesis.slice(0, 1000),
  steps,
  assertions,
  expectedClassification: "defect",
  ...extra,
});

export class HeuristicPlanner implements Planner {
  readonly kind = "heuristic" as const;
  private readonly resources: DerivedResource[];
  private readonly opsByKey: Map<string, Operation>;

  constructor(private readonly o: HeuristicOptions) {
    this.resources = deriveResources(o.g.contract).filter(
      (r) => o.ops.some((x) => x.key === r.create.key) && o.ops.some((x) => x.key === r.read.key),
    );
    this.opsByKey = new Map(o.ops.map((x) => [x.key, x]));
  }

  // ------------------------------------------------------------------ arms

  arms(): Arm[] {
    const out: Arm[] = [];
    const on = new Set(this.o.techniques);
    const add = (t: AgentTechnique, op: string): void => {
      if (on.has(t) && !out.some((a) => a.technique === t && a.operation === op))
        out.push({ key: armKey(t, op), technique: t, operation: op });
    };
    const roles = this.o.g.roles;
    for (const op of this.o.ops) {
      if (this.statusGapCandidates(op).length > 0) add("status-gap", op.key);
      if (op.params.some((p) => p.in === "query" && !p.required)) add("param-gap", op.key);
      if (this.numericFields(op).length > 0) add("boundary", op.key);
      if (op.idempotencyHeader && op.mutating) {
        add("idempotency", op.key);
        add("idempotency-concurrent", op.key);
      }
      if (isPrivileged(this.o.g, op) && roles.unprivileged.length > 0) add("privilege", op.key);
      if (op.method === "POST" && !/\{[^}]+\}/.test(op.path) && op.body) add("concurrency", op.key);
    }
    for (const r of this.resources) {
      if (roles.owner && roles.attacker && roles.owner !== roles.attacker) add("ownership", r.read.key);
      add("lifecycle", r.read.key);
    }
    for (const h of this.o.history ?? []) if (this.opsByKey.has(h.operation)) add("history", h.operation);
    for (const op of this.archOps()) add("arch-risk", op);
    return out;
  }

  async propose(arm: Arm, state: PlanState): Promise<unknown[]> {
    const op = this.opsByKey.get(arm.operation);
    if (!op) return [];
    switch (arm.technique) {
      case "status-gap":
        return this.statusGap(op, state);
      case "param-gap":
        return this.paramGap(op, state);
      case "boundary":
        return this.boundary(op);
      case "idempotency":
        return this.idempotency(op, false);
      case "idempotency-concurrent":
        return this.idempotency(op, true);
      case "ownership":
        return this.ownership(op);
      case "privilege":
        return this.privilege(op);
      case "lifecycle":
        return this.lifecycle(op);
      case "concurrency":
        return this.concurrency(op);
      case "history":
        return (this.o.history ?? []).filter((h) => h.operation === op.key).map((h) => h.scenario);
      case "arch-risk":
        return this.archRisk(op);
    }
  }

  // ------------------------------------------------------------------ helpers

  private base(op: Operation): RequestTemplate {
    const tpl = baseRequest(this.o.g, op);
    if (op.idempotencyHeader) delete tpl.headers[op.idempotencyHeader];
    return tpl;
  }

  private resolver() {
    return this.o.g.contract.resolver;
  }

  /** Bounded numeric params and body fields (body walked iteratively, depth ≤ 3). */
  numericFields(op: Operation): NumericField[] {
    const out: NumericField[] = [];
    const r = this.resolver();
    for (const p of op.params) {
      if (p.in !== "query" && p.in !== "path") continue;
      const s = normalize(p.schema, r);
      const t = primaryType(s);
      if (t !== "integer" && t !== "number") continue;
      const { lo, hi } = numericBounds(s, t === "integer");
      if (Number.isFinite(lo) || Number.isFinite(hi))
        out.push({
          where: p.in,
          name: p.name,
          pointer: `${p.in}:${p.name}`,
          lo,
          hi,
          integer: t === "integer",
        });
    }
    if (op.body?.schema !== undefined) {
      const stack: [JsonSchema, string, number][] = [[normalize(op.body.schema, r), "", 0]];
      while (stack.length > 0 && out.length < 20) {
        const [s, ptr, d] = stack.pop() as [JsonSchema, string, number];
        const t = primaryType(s);
        if (t === "integer" || t === "number") {
          const { lo, hi } = numericBounds(s, t === "integer");
          if (ptr !== "" && (Number.isFinite(lo) || Number.isFinite(hi)))
            out.push({ where: "body", name: ptr, pointer: ptr, lo, hi, integer: t === "integer" });
        } else if (t === "object" && d < 3 && isObject(s.properties)) {
          for (const [k, v] of Object.entries(s.properties).reverse())
            stack.push([normalize(v, r), `${ptr}/${k}`, d + 1]);
        } else if (t === "array" && d < 3 && s.items !== undefined) {
          stack.push([normalize(s.items, r), `${ptr}/0`, d + 1]);
        }
      }
    }
    return out;
  }

  private idPointer(op: Operation): string | undefined {
    const ok = op.responses.find((x) => /^2/.test(x.status));
    const media = ok ? Object.values(ok.content)[0] : undefined;
    if (!media?.schema) return undefined;
    const s = normalize(media.schema, this.resolver());
    if (isObject(s.properties) && "id" in s.properties) return "/id";
    return undefined;
  }

  private statusGapCandidates(op: Operation): string[] {
    const documented = op.responses.map((x) => x.status);
    const out: string[] = [];
    if (documented.includes("401") && op.secured) out.push("401");
    if (documented.includes("404") && /\{[^}]+\}/.test(op.path) && op.method === "GET") out.push("404");
    if (
      documented.includes("400") &&
      (op.body?.required || op.params.some((p) => p.required && p.in !== "header"))
    )
      out.push("400");
    return out;
  }

  private missingId(op: Operation, name: string): string | number {
    const p = op.params.find((x) => x.in === "path" && x.name === name);
    const s = p ? normalize(p.schema, this.resolver()) : {};
    const t = primaryType(s);
    if (t === "integer" || t === "number") {
      const { hi } = numericBounds(s, t === "integer");
      return Number.isFinite(hi) ? hi : 987654321;
    }
    return "sw-missing-0";
  }

  // ------------------------------------------------------------------ techniques

  private statusGap(op: Operation, st: PlanState): unknown[] {
    const out: unknown[] = [];
    for (const code of this.statusGapCandidates(op)) {
      if (st.coverage.has("status", op.key, code)) continue;
      const tpl = this.base(op);
      if (code === "401") {
        tpl.role = null;
        out.push(
          scenario(
            `Anonymous call to ${op.key}`,
            `${op.key} requires authentication, so a call without credentials must not succeed`,
            [toStep(tpl, "no credentials")],
            [
              { kind: "status-class", step: 0, class: "not-2xx", rule: "bugs/missing-authentication" },
              { kind: "no-5xx" },
            ],
          ),
        );
      } else if (code === "404") {
        const name = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string).pop() as string;
        tpl.pathParams[name] = this.missingId(op, name);
        out.push(
          scenario(
            `Unknown id on ${op.key}`,
            `An id that does not exist yields a documented 4xx, not a 5xx`,
            [toStep(tpl, "unknown id")],
            [
              { kind: "no-5xx", rule: "bugs/server-error" },
              { kind: "status-class", step: 0, class: "4xx" },
            ],
            { expectedClassification: "contract-gap" },
          ),
        );
      } else if (code === "400") {
        if (op.body?.required && tpl.body.kind === "json") tpl.body = { kind: "json", value: {} };
        else {
          const p = op.params.find((x) => x.required && (x.in === "query" || x.in === "path"));
          if (p?.in === "query") delete tpl.query[p.name];
          else if (p?.in === "path") tpl.pathParams[p.name] = "not-a-valid-value";
        }
        out.push(
          scenario(
            `Missing required input on ${op.key}`,
            `A request missing a required field is rejected with 4xx, not 5xx`,
            [toStep(tpl, "missing required input")],
            [
              { kind: "no-5xx", rule: "bugs/server-error-on-invalid-input" },
              { kind: "status-class", step: 0, class: "not-2xx", rule: "agent/accepts-invalid-input" },
            ],
          ),
        );
      }
    }
    return out;
  }

  private paramGap(op: Operation, st: PlanState): unknown[] {
    const out: unknown[] = [];
    for (const p of op.params) {
      if (p.in !== "query" || p.required || st.coverage.has("param", op.key, p.name)) continue;
      const tpl = this.base(op);
      const s = normalize(p.schema, this.resolver());
      const enums = Array.isArray(s.enum)
        ? s.enum
        : [
            sampleValid(
              p.schema,
              { resolver: this.resolver(), dict: this.o.g.dict, path: op.path, variant: 0 },
              p.name,
            ),
          ];
      for (const v of enums.slice(0, 4)) {
        if (!["string", "number", "boolean"].includes(typeof v)) continue;
        out.push(
          scenario(
            `Optional parameter ${p.name}=${String(v)} on ${op.key}`,
            `A valid value for the optional parameter ${p.name} is handled and the response matches the contract`,
            [toStep({ ...tpl, query: { ...tpl.query, [p.name]: v } }, `${p.name}=${String(v)}`)],
            [{ kind: "no-5xx" }, { kind: "schema-valid", step: 0 }],
          ),
        );
      }
    }
    return out;
  }

  private boundary(op: Operation): unknown[] {
    const out: unknown[] = [];
    for (const f of this.numericFields(op)) {
      const unit = f.integer ? 1 : 0.01;
      const values: [number, boolean][] = [];
      if (Number.isFinite(f.lo)) values.push([f.lo - unit, false], [f.lo, true]);
      if (Number.isFinite(f.hi)) values.push([f.hi, true], [f.hi + unit, false]);
      for (const [v, valid] of values) {
        const tpl = this.base(op);
        if (f.where === "query") tpl.query[f.name] = v;
        else if (f.where === "path") tpl.pathParams[f.name] = v;
        else if (tpl.body.kind === "json") {
          if (getPointer(tpl.body.value, f.pointer.replace(/\/[^/]*$/, "") || "") === undefined) continue;
          tpl.body = { kind: "json", value: setPointer(tpl.body.value, f.pointer, v) };
        } else continue;
        const where = f.where === "body" ? `body ${f.pointer}` : `${f.where} ${f.name}`;
        const assertions: ScenarioInput["assertions"] = [
          { kind: "no-5xx", rule: "bugs/server-error-on-boundary" },
        ];
        if (!valid)
          assertions.push({
            kind: "status-class",
            step: 0,
            class: "not-2xx",
            rule: "agent/accepts-invalid-input",
          });
        out.push(
          scenario(
            `Boundary ${where}=${v} on ${op.key}`,
            valid
              ? `The boundary value ${v} (${where}) is inside the documented range and must not cause a 5xx`
              : `The value ${v} (${where}) is just outside the documented range and must be rejected with 4xx`,
            [toStep(tpl, `${where}=${v}`)],
            assertions,
          ),
        );
      }
    }
    return out;
  }

  private idempotency(op: Operation, concurrent: boolean): unknown[] {
    const h = op.idempotencyHeader;
    const ptr = this.idPointer(op);
    if (!h || !ptr) return [];
    const tpl = this.base(op);
    tpl.headers[h] = "{{$nonce}}";
    const step = toStep(tpl, `${h} reused`);
    if (!concurrent) {
      return [
        scenario(
          `Duplicate submit of ${op.key} with the same ${h}`,
          `Repeating ${op.key} with the same ${h} returns the original resource instead of creating a new one`,
          [step, { ...step, label: "repeat with the same key" }],
          [
            { kind: "same-json", steps: [0, 1], pointer: ptr, rule: "bugs/idempotency-key-ignored" },
            { kind: "no-5xx" },
          ],
        ),
      ];
    }
    const copies = Math.min(3, this.o.maxCopies);
    if (copies < 2) return [];
    return [
      scenario(
        `Concurrent duplicate submits of ${op.key} with the same ${h}`,
        `${copies} concurrent copies with one ${h} all refer to the same resource`,
        [step],
        [
          { kind: "copies-agree", step: 0, pointer: ptr, rule: "agent/idempotency-key-race" },
          { kind: "no-5xx" },
        ],
        { parallel: { copies } },
      ),
    ];
  }

  private resourceFor(op: Operation): DerivedResource | undefined {
    return this.resources.find((r) => r.read.key === op.key);
  }

  private createStep(r: DerivedResource, role: string | undefined, label: string): Step {
    const tpl = this.base(r.create);
    if (r.body !== undefined) tpl.body = { kind: "json", value: r.body };
    if (role !== undefined) tpl.role = role;
    return { ...toStep(tpl, label), extract: { rid: r.idPointer } };
  }

  private readStep(r: DerivedResource, role: string | undefined, label: string): Step {
    const tpl = this.base(r.read);
    tpl.pathParams[r.idParam] = "{{rid}}";
    if (role !== undefined) tpl.role = role;
    return toStep(tpl, label);
  }

  private ownership(op: Operation): unknown[] {
    const r = this.resourceFor(op);
    const { owner, attacker } = this.o.g.roles;
    if (!r || !owner || !attacker || owner === attacker) return [];
    return [
      scenario(
        `Cross-account read on ${op.key}`,
        `A ${r.name} created by test account "${owner}" is not readable by test account "${attacker}"`,
        [this.readStep(r, attacker, `${attacker} reads ${owner}'s ${r.name}`)],
        [{ kind: "status-class", step: 0, class: "not-2xx", rule: "bugs/bola" }],
        {
          setup: [
            this.createStep(r, owner, `${owner} creates`),
            this.readStep(r, owner, `${owner} reads own ${r.name}`),
          ],
        },
      ),
    ];
  }

  private privilege(op: Operation): unknown[] {
    const roles = this.o.g.roles;
    return roles.unprivileged.slice(0, 2).map((role) => {
      const tpl = this.base(op);
      tpl.role = role;
      return scenario(
        `Ordinary account "${role}" calls ${op.key}`,
        `${op.key} is privileged, so the ordinary test account "${role}" must be refused`,
        [toStep(tpl, `as ${role}`)],
        [{ kind: "status-class", step: 0, class: "not-2xx", rule: "bugs/bfla" }],
      );
    });
  }

  private lifecycle(op: Operation): unknown[] {
    const r = this.resourceFor(op);
    if (!r) return [];
    const role = r.role ?? this.o.g.roles.owner;
    const create = this.createStep(r, role, "create");
    const assertions: ScenarioInput["assertions"] = [
      { kind: "status-class", step: 1, class: "2xx", rule: "bugs/state-model-mismatch" },
      { kind: "same-json", steps: [0, 1], pointer: r.idPointer, rule: "bugs/state-model-mismatch" },
      { kind: "schema-valid", step: 1 },
      { kind: "no-5xx" },
    ];
    // Top-level scalar fields sent on create must read back unchanged.
    if (isObject(create.body))
      for (const [k, v] of Object.entries(create.body).slice(0, 8))
        if (["string", "number", "boolean"].includes(typeof v))
          assertions.push({
            kind: "json",
            step: 1,
            pointer: `/${k}`,
            equals: v,
            rule: "bugs/state-model-mismatch",
          });
    return [
      scenario(
        `Create then read back via ${op.key}`,
        `A created ${r.name} is readable by its creator with the values that were sent`,
        [create, this.readStep(r, role, "read back")],
        assertions,
      ),
    ];
  }

  private concurrency(op: Operation): unknown[] {
    const copies = Math.min(5, this.o.maxCopies);
    if (copies < 2) return [];
    const tpl = this.base(op);
    return [
      scenario(
        `${copies} concurrent ${op.key}`,
        `Concurrent creates are handled without server errors`,
        [toStep(tpl, "concurrent copies")],
        [{ kind: "no-5xx", rule: "bugs/server-error" }],
        { parallel: { copies } },
      ),
    ];
  }

  private archOps(): string[] {
    const out = new Set<string>();
    for (const h of this.o.hints ?? []) {
      const ops = h.operations.filter((k) => this.opsByKey.has(k));
      if (ops.length > 0) {
        for (const k of ops) out.add(k);
      } else if (h.ruleId === "ARCH005") {
        for (const op of this.o.ops)
          if (op.method === "GET" && op.params.some((p) => p.in === "query")) out.add(op.key);
      } else if (h.ruleId === "ARCH001") {
        for (const op of this.o.ops)
          if (op.mutating && op.method === "POST" && !/\{/.test(op.path)) out.add(op.key);
      }
    }
    return [...out];
  }

  private archRisk(op: Operation): unknown[] {
    const out: unknown[] = [];
    const rules = new Set(
      (this.o.hints ?? [])
        .filter((h) => h.operations.includes(op.key) || h.operations.length === 0)
        .map((h) => h.ruleId),
    );
    const slow = {
      kind: "max-duration" as const,
      step: 0,
      ms: this.o.slowMs,
      rule: "agent/slow-response" as const,
    };
    if (rules.has("ARCH005")) {
      // Larger page sizes and expansion params: per-item queries grow with the result size.
      const tpl = this.base(op);
      for (const p of op.params) {
        if (p.in !== "query") continue;
        const s = normalize(p.schema, this.resolver());
        if (PAGE_PARAM.test(p.name)) {
          const { hi } = numericBounds(s, primaryType(s) === "integer");
          tpl.query[p.name] = Number.isFinite(hi) ? hi : 100;
        } else if (Array.isArray(s.enum) && s.enum.length > 0 && typeof s.enum[0] === "string")
          tpl.query[p.name] = s.enum[0];
      }
      out.push(
        scenario(
          `Large page on ${op.key}`,
          `Possible N+1 (ARCH005): the largest page with expansions still answers within ${this.o.slowMs} ms`,
          [toStep(tpl, "largest page")],
          [slow, { kind: "no-5xx" }],
        ),
      );
    }
    if (rules.has("ARCH001")) {
      out.push(
        scenario(
          `Response-time bound on ${op.key}`,
          `Outbound call without timeout (ARCH001): ${op.key} answers within ${this.o.slowMs} ms`,
          [toStep(this.base(op), "time-bounded call")],
          [slow, { kind: "no-5xx" }],
        ),
      );
    }
    if (rules.has("ARCH004")) {
      const copies = Math.min(5, this.o.maxCopies);
      if (copies >= 2)
        out.push(
          scenario(
            `Concurrent ${op.key} under a time bound`,
            `Synchronous work in the handler (ARCH004): ${copies} concurrent calls each answer within ${this.o.slowMs} ms`,
            [toStep(this.base(op), "concurrent")],
            [slow, { kind: "no-5xx" }],
            { parallel: { copies } },
          ),
        );
    }
    if (rules.has("ARCH007") && op.secured) {
      const tpl = this.base(op);
      tpl.role = null;
      out.push(
        scenario(
          `Anonymous call to ${op.key} (ARCH007)`,
          `The route may lack auth middleware: an anonymous call must not succeed`,
          [toStep(tpl, "no credentials")],
          [{ kind: "status-class", step: 0, class: "not-2xx", rule: "bugs/missing-authentication" }],
        ),
      );
    }
    if (out.length === 0)
      out.push(
        scenario(
          `Probe ${op.key} (architecture hint)`,
          `The flagged operation answers without server errors`,
          [toStep(this.base(op))],
          [{ kind: "no-5xx" }, slow],
        ),
      );
    return out;
  }
}
