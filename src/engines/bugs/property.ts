/**
 * Property-based (valid input ⇒ documented status + schema-valid; never 5xx) and model-based
 * (fast-check `commands` over a resource lifecycle) techniques with integrated shrinking.
 * docs/04-data-structures-and-algorithms.md §7.2, §7.6. Seeds are recorded for exact replay.
 */
import fc from "fast-check";
import { type BugCase, type CaseRun, type CaseStep, type EvalEnv, type Failure, runCase } from "./cases.js";
import type { Operation } from "./contract.js";
import { baseRequest, type DerivedResource, type GenContext, requestValidity } from "./generate.js";
import { schemaToArbitrary } from "./generators/arbitrary.js";
import type { RequestTemplate } from "./http.js";
import { isObject } from "./json-schema.js";

export type FailureSink = (c: BugCase, run: CaseRun, f: Failure) => void;

function paramArb(g: GenContext, op: Operation, schema: unknown, name: string): fc.Arbitrary<unknown> {
  const known = g.dict.lookup(name, op.path);
  if (known.length > 0) return fc.constantFrom(...known);
  const v = g.contract.validators;
  return schemaToArbitrary(schema, {
    resolver: g.contract.resolver,
    dict: g.dict,
    path: op.path,
    isValid: (x) => v.isValid(schema, x),
  });
}

/** Runs the "valid input ⇒ conforming response" property for one operation. */
export async function runPropertyTechnique(
  g: GenContext,
  op: Operation,
  env: EvalEnv,
  opts: { numRuns: number; seed: number; timeLimitMs: number; sink: FailureSink },
): Promise<{ runs: number; failed: boolean; shrunk?: BugCase; cases: number }> {
  const base = baseRequest(g, op);
  const pathA: Record<string, fc.Arbitrary<unknown>> = {};
  const queryA: Record<string, fc.Arbitrary<unknown>> = {};
  const optionalQuery: string[] = [];
  for (const p of op.params) {
    if (p.in === "path") pathA[p.name] = paramArb(g, op, p.schema, p.name);
    else if (p.in === "query") {
      queryA[p.name] = paramArb(g, op, p.schema, p.name);
      if (!p.required) optionalQuery.push(p.name);
    }
  }
  const required = Object.keys(queryA).filter((k) => !optionalQuery.includes(k));
  const bodySchema = op.body?.schema;
  const bodyA =
    bodySchema !== undefined && base.body.kind === "json"
      ? schemaToArbitrary(bodySchema, {
          resolver: g.contract.resolver,
          dict: g.dict,
          path: op.path,
          isValid: (x) => g.contract.validators.isValid(bodySchema, x),
        })
      : fc.constant(undefined);
  const arb = fc.record({
    path: fc.record(pathA),
    query: fc.record(queryA, { requiredKeys: required }),
    body: bodyA,
  });
  let runs = 0;
  let cases = 0;
  let lastFailing: BugCase | undefined;
  const toCase = (v: {
    path: Record<string, unknown>;
    query: Record<string, unknown>;
    body: unknown;
  }): BugCase => {
    const tpl: RequestTemplate = structuredClone(base);
    Object.assign(tpl.pathParams, v.path);
    tpl.query = { ...v.query };
    if (v.body !== undefined) tpl.body = { kind: "json", value: v.body };
    const valid = requestValidity(g, op, tpl).valid;
    return {
      id: `property-${op.key}-${runs}`,
      technique: "property",
      operation: op.key,
      label: `property: valid input ⇒ conforming response`,
      seed: opts.seed,
      steps: [{ request: tpl, expect: valid ? "valid" : "invalid", label: "generated" }],
      check: { kind: "conformance" },
    };
  };
  const prop = fc.asyncProperty(arb, async (v) => {
    runs++;
    const c = toCase(v);
    if (c.steps[0]?.expect !== "valid") return true; // generator produced an input Ajv rejects: skip
    cases++;
    const run = await runCase(c, env);
    if (run.inconclusive) return true;
    const real = run.failures.filter((f) => !f.observation);
    for (const f of run.failures) opts.sink(c, run, f);
    if (real.length > 0) {
      lastFailing = c;
      return false;
    }
    return true;
  });
  const r = await fc.check(prop, {
    numRuns: opts.numRuns,
    seed: opts.seed,
    interruptAfterTimeLimit: opts.timeLimitMs,
    markInterruptAsFailure: false,
    endOnFailure: false,
  });
  const out: { runs: number; failed: boolean; shrunk?: BugCase; cases: number } = {
    runs,
    failed: r.failed,
    cases,
  };
  if (r.failed && lastFailing) out.shrunk = lastFailing;
  return out;
}

// ------------------------------------------------------------------ model-based

interface Model {
  live: { v: string; fields: Record<string, unknown> }[];
  deleted: string[];
  n: number;
}
interface Real {
  trace: CaseStep[];
  scope: Record<string, unknown>;
}

const OK_CREATE = [200, 201];
const OK_UPDATE = [200, 204];
const OK_DELETE = [200, 202, 204];

function primitiveFields(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObject(v)) return out;
  for (const [k, x] of Object.entries(v))
    if (x === null || ["string", "number", "boolean"].includes(typeof x)) out[k] = x;
  return out;
}

export async function runModelTechnique(
  g: GenContext,
  r: DerivedResource,
  env: EvalEnv,
  opts: { runs: number; maxCommands: number; seed: number; reset: () => Promise<void>; timeLimitMs: number },
): Promise<{ failed: boolean; case?: BugCase; executions: number }> {
  let executions = 0;
  let failingTrace: CaseStep[] | undefined;

  const exec = async (real: Real, step: CaseStep, concrete: CaseStep): Promise<void> => {
    real.trace.push(step);
    const c: BugCase = {
      id: "model-step",
      technique: "stateful",
      operation: concrete.request.operation,
      label: "model step",
      seed: opts.seed,
      steps: [concrete],
      check: { kind: "conformance" },
    };
    const run = await runCase(c, env);
    if (run.inconclusive) throw new InconclusiveStep(run.reason ?? "inconclusive");
    for (const [k, ptr] of Object.entries(step.extract ?? {})) {
      const ex = run.stepExchanges[0];
      if (ex?.json !== undefined) {
        const val = ptr
          .split("/")
          .slice(1)
          .reduce<unknown>((o, s) => (isObject(o) ? o[s] : undefined), ex.json);
        if (val !== undefined) real.scope[k] = val;
      }
    }
    const real2 = run.failures.filter(
      (f) => !f.observation && (f.ruleId === "bugs/state-model-mismatch" || f.ruleId === "bugs/server-error"),
    );
    if (real2.length > 0) throw new Error(real2.map((f) => f.message).join("; "));
  };
  const concretize = (step: CaseStep, scope: Record<string, unknown>): CaseStep => {
    const json = JSON.stringify(step).replace(/"\{\{(\w+)\}\}"/g, (m, k: string) =>
      k in scope ? JSON.stringify(scope[k]) : m,
    );
    return JSON.parse(json) as CaseStep;
  };

  class Create implements fc.AsyncCommand<Model, Real> {
    check = (): boolean => true;
    async run(m: Model, real: Real): Promise<void> {
      const v = `id${m.n++}`;
      const tpl = baseRequest(g, r.create);
      if (r.body !== undefined) tpl.body = { kind: "json", value: r.body };
      if (r.role) tpl.role = r.role;
      if (r.create.idempotencyHeader) delete tpl.headers[r.create.idempotencyHeader];
      const fields = tpl.body.kind === "json" ? primitiveFields(tpl.body.value) : {};
      const step: CaseStep = {
        request: tpl,
        extract: { [v]: r.idPointer },
        expect: { status: OK_CREATE, message: `create ${r.name} failed` },
        label: `create ${v}`,
        model: { cmd: "create", v, fields },
      };
      await exec(real, step, step);
      if (!(v in real.scope)) throw new InconclusiveStep("create returned no id");
      m.live.push({ v, fields });
    }
    toString = (): string => `create ${r.name}`;
  }
  class Read implements fc.AsyncCommand<Model, Real> {
    constructor(readonly k: number) {}
    check = (m: Readonly<Model>): boolean => m.live.length > 0;
    async run(m: Model, real: Real): Promise<void> {
      const item = m.live[this.k % m.live.length];
      if (!item) return;
      const tpl = baseRequest(g, r.read);
      tpl.pathParams[r.idParam] = `{{${item.v}}}`;
      if (r.role) tpl.role = r.role;
      const step: CaseStep = {
        request: tpl,
        expect: { status: [200], message: `existing ${r.name} not readable` },
        expectJson: Object.entries(item.fields).map(([k, val]) => ({ pointer: `/${k}`, equals: val })),
        label: `read ${item.v}`,
        model: { cmd: "read", v: item.v },
      };
      await exec(real, step, concretize(step, real.scope));
    }
    toString = (): string => `read #${this.k}`;
  }
  class Update implements fc.AsyncCommand<Model, Real> {
    constructor(readonly k: number) {}
    check = (m: Readonly<Model>): boolean => m.live.length > 0 && r.update !== undefined;
    async run(m: Model, real: Real): Promise<void> {
      const item = m.live[this.k % m.live.length];
      if (!item || !r.update) return;
      const tpl = baseRequest(g, r.update, { variant: this.k + 1 });
      tpl.pathParams[r.idParam] = `{{${item.v}}}`;
      if (r.role) tpl.role = r.role;
      const upd = tpl.body.kind === "json" ? primitiveFields(tpl.body.value) : {};
      const step: CaseStep = {
        request: tpl,
        expect: { status: OK_UPDATE, message: `update ${r.name} failed` },
        label: `update ${item.v}`,
        model: { cmd: "update", v: item.v, fields: upd },
      };
      await exec(real, step, concretize(step, real.scope));
      if (tpl.body.kind === "json") item.fields = { ...item.fields, ...primitiveFields(tpl.body.value) };
    }
    toString = (): string => `update #${this.k}`;
  }
  class Delete implements fc.AsyncCommand<Model, Real> {
    constructor(readonly k: number) {}
    check = (m: Readonly<Model>): boolean => m.live.length > 0 && r.delete !== undefined;
    async run(m: Model, real: Real): Promise<void> {
      const idx = this.k % m.live.length;
      const item = m.live[idx];
      if (!item || !r.delete) return;
      const tpl = baseRequest(g, r.delete);
      tpl.pathParams[r.idParam] = `{{${item.v}}}`;
      if (r.role) tpl.role = r.role;
      const step: CaseStep = {
        request: tpl,
        expect: { status: OK_DELETE, message: `delete ${r.name} failed` },
        label: `delete ${item.v}`,
        model: { cmd: "delete", v: item.v },
      };
      await exec(real, step, concretize(step, real.scope));
      m.live.splice(idx, 1);
      m.deleted.push(item.v);
    }
    toString = (): string => `delete #${this.k}`;
  }
  class ReadDeleted implements fc.AsyncCommand<Model, Real> {
    constructor(readonly k: number) {}
    check = (m: Readonly<Model>): boolean => m.deleted.length > 0;
    async run(m: Model, real: Real): Promise<void> {
      const v = m.deleted[this.k % m.deleted.length];
      if (!v) return;
      const tpl = baseRequest(g, r.read);
      tpl.pathParams[r.idParam] = `{{${v}}}`;
      if (r.role) tpl.role = r.role;
      const step: CaseStep = {
        request: tpl,
        expect: { status: [404, 410], message: `deleted ${r.name} is still readable` },
        label: `read deleted ${v}`,
        model: { cmd: "read", v },
      };
      await exec(real, step, concretize(step, real.scope));
    }
    toString = (): string => `read-deleted #${this.k}`;
  }

  const k = fc.nat({ max: 7 });
  const cmds = fc.commands(
    [
      fc.constant(new Create()),
      k.map((x) => new Read(x)),
      k.map((x) => new Update(x)),
      k.map((x) => new Delete(x)),
      k.map((x) => new ReadDeleted(x)),
    ],
    { maxCommands: opts.maxCommands },
  );
  const prop = fc.asyncProperty(cmds, async (cs) => {
    await opts.reset();
    executions++;
    const real: Real = { trace: [], scope: {} };
    try {
      await fc.asyncModelRun(() => ({ model: { live: [], deleted: [], n: 0 }, real }), cs);
    } catch (e) {
      if (e instanceof InconclusiveStep) return true;
      failingTrace = real.trace;
      throw e;
    }
    return true;
  });
  // Random command lists rarely contain create → read → update → read in that order (5 command
  // kinds, ≤ maxCommands, fast-check starts with small sizes), so a read cache that the update
  // forgets to invalidate was never reached in the default 4 runs. The canonical lifecycle runs
  // first as a fixed example (commands whose check() fails are skipped, e.g. no update op), then
  // `runs` random lists explore other orders.
  const lifecycle = [
    new Create(),
    new Read(0),
    new Update(0),
    new Read(0),
    new Delete(0),
    new ReadDeleted(0),
  ];
  const res = await fc.check(prop, {
    numRuns: opts.runs + 1,
    examples: [[lifecycle]],
    seed: opts.seed,
    interruptAfterTimeLimit: opts.timeLimitMs,
    markInterruptAsFailure: false,
  });
  if (!res.failed || !failingTrace) return { failed: false, executions };
  return {
    failed: true,
    executions,
    case: {
      id: `model-${r.name}`,
      technique: "stateful",
      operation: failingTrace[failingTrace.length - 1]?.request.operation ?? r.read.key,
      label: `model-based ${r.name} lifecycle: ${failingTrace.map((s) => s.label).join(" → ")}`,
      seed: opts.seed,
      steps: failingTrace,
      check: { kind: "model" },
    },
  };
}

class InconclusiveStep extends Error {}
