/**
 * Case generation per technique (docs/03-engines/api-bug-hunter.md §2):
 * contract, boundary, equivalence, pairwise (IPOG), negative, auth matrix, stateful
 * (round-trip, idempotency), concurrency bursts. Property-based and model-based live in
 * property.ts / model.ts (they need fast-check's runner for shrinking).
 *
 * Request validity is decided by Ajv on the typed parameter values and the JSON body, so the
 * expectation ("valid" ⇒ documented 2xx/4xx, "invalid" ⇒ never 5xx) is never mislabelled.
 */
import type { Rng } from "../../core/types.js";
import { ipog } from "./algorithms/ipog.js";
import type { BugCase, CaseStep, Check, StepExpect } from "./cases.js";
import { type Contract, matchesPattern, type Operation } from "./contract.js";
import { type Dictionary, resourceOf, singular } from "./dictionary.js";
import { boundaryValues, equivalenceValues, objectVariants } from "./generators/boundary.js";
import { negativeMutations, type RawBody } from "./generators/mutations.js";
import {
  ABSENT,
  applyBodyRow,
  bodyConstraint,
  bodyFactors,
  factorActive,
  scalarClasses,
  showValue,
} from "./generators/pairwise.js";
import { type SampleContext, sampleValid } from "./generators/sample.js";
import { type RequestTemplate, ROLE_EXPIRED, ROLE_INVALID } from "./http.js";
import { isObject, normalize, primaryType, type SchemaResolver } from "./json-schema.js";
import type { BugsInput, ConcurrencyTest, ResourceSpec, Technique } from "./schema.js";

export interface GenContext {
  contract: Contract;
  dict: Dictionary;
  rng: Rng;
  seed: number;
  input: BugsInput;
  /** Role names: default (ordinary), owner/attacker for BOLA, privileged roles. */
  roles: {
    default?: string;
    owner?: string;
    attacker?: string;
    privileged: string[];
    unprivileged: string[];
  };
}

let caseCounter = 0;
function caseId(technique: string): string {
  caseCounter = (caseCounter + 1) % 1_000_000_000;
  return `${technique}-${caseCounter.toString(36)}`;
}

function sctx(g: GenContext, op: Operation, variant = 0): SampleContext {
  return { resolver: g.contract.resolver, dict: g.dict, path: op.path, variant };
}

function isAuthHeader(name: string): boolean {
  return /^(authorization|cookie|x-api-key)$/i.test(name);
}

/** Base valid request for an operation (required params + body). */
export function baseRequest(
  g: GenContext,
  op: Operation,
  opts: { variant?: number; full?: boolean } = {},
): RequestTemplate {
  const sc = { ...sctx(g, op, opts.variant ?? 0), full: opts.full ?? false };
  const tpl: RequestTemplate = {
    operation: op.key,
    method: op.method,
    path: op.path,
    pathParams: {},
    query: {},
    headers: {},
    body: { kind: "none" },
    secured: op.secured,
  };
  for (const p of op.params) {
    if (p.in === "cookie" || (p.in === "header" && isAuthHeader(p.name))) continue;
    const known = g.dict.lookup(p.name, op.path).length > 0;
    if (!p.required && !(opts.full && p.in === "query") && !known) continue;
    if (p.in === "header" && op.idempotencyHeader === p.name) {
      tpl.headers[p.name] = `sw-${g.seed}-${caseCounter + 1}`;
      continue;
    }
    const v = sampleValid(p.schema, sc, p.name);
    if (p.in === "path") tpl.pathParams[p.name] = v;
    else if (p.in === "query") tpl.query[p.name] = v;
    else tpl.headers[p.name] = String(v);
  }
  if (op.body) {
    const v = op.body.schema === undefined ? {} : sampleValid(op.body.schema, sc);
    tpl.body =
      /json/i.test(op.body.mediaType) || op.body.mediaType === "*/*"
        ? { kind: "json", value: v }
        : { kind: "raw", text: String(v), contentType: op.body.mediaType };
  }
  return tpl;
}

/** Serialises a parameter value as on the wire and coerces it back per the schema type (OpenAPI simple/form style). */
export function wireCoerce(val: unknown, schema: Record<string, unknown>, resolver: SchemaResolver): unknown {
  if (Array.isArray(val))
    return primaryType(schema) === "array"
      ? val.map((x) => wireCoerce(x, normalize(schema.items ?? {}, resolver), resolver))
      : JSON.stringify(val);
  const s = val === null ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
  const t = primaryType(schema);
  if ((t === "integer" || t === "number") && s.trim() !== "" && Number.isFinite(Number(s))) return Number(s);
  if (t === "boolean" && (s === "true" || s === "false")) return s === "true";
  if (t === "null" && s === "") return null;
  return s;
}

/** Ajv check of all typed parameter values and the JSON body. Returns the first invalid input pointer or null. */
export function requestValidity(
  g: GenContext,
  op: Operation,
  tpl: RequestTemplate,
): { valid: boolean; pointer?: string } {
  const v = g.contract.validators;
  for (const p of op.params) {
    if (p.in === "cookie" || (p.in === "header" && isAuthHeader(p.name))) continue;
    const bag = p.in === "path" ? tpl.pathParams : p.in === "query" ? tpl.query : tpl.headers;
    const val = bag[p.name];
    if (val === undefined) {
      if (p.required) return { valid: false, pointer: `${p.in}:${p.name}` };
      continue;
    }
    if (p.in === "path" && (val === "" || val === null))
      return { valid: false, pointer: `${p.in}:${p.name}` };
    if (p.in === "path" && (Array.isArray(val) || isObject(val)))
      return { valid: false, pointer: `${p.in}:${p.name}` };
    // Parameters are strings on the wire: judge validity on what the server can parse.
    const typed = wireCoerce(val, normalize(p.schema, g.contract.resolver), g.contract.resolver);
    if (!v.isValid(p.schema, typed)) return { valid: false, pointer: `${p.in}:${p.name}` };
  }
  if (op.body) {
    if (tpl.body.kind === "none")
      return op.body.required ? { valid: false, pointer: "body:missing" } : { valid: true };
    if (tpl.body.kind === "raw") return { valid: false, pointer: "body:raw" };
    if (op.body.schema !== undefined) {
      const errs = v.validate(op.body.schema, tpl.body.value);
      if (errs.length > 0) return { valid: false, pointer: errs[0]?.pointer ?? "" };
    }
  }
  return { valid: true };
}

function mkCase(
  g: GenContext,
  technique: Technique,
  op: Operation,
  label: string,
  steps: CaseStep[],
  check: Check = { kind: "conformance" },
): BugCase {
  return { id: caseId(technique), technique, operation: op.key, label, seed: g.seed, steps, check };
}

function single(
  g: GenContext,
  technique: Technique,
  op: Operation,
  tpl: RequestTemplate,
  label: string,
  inputPointer?: string,
): BugCase {
  const val = requestValidity(g, op, tpl);
  const expect: StepExpect = val.valid ? "valid" : "invalid";
  const step: CaseStep = { request: tpl, expect, label };
  const ip = inputPointer ?? val.pointer;
  if (!val.valid && ip !== undefined) step.inputPointer = ip;
  return mkCase(g, technique, op, label, [step]);
}

function withParam(
  tpl: RequestTemplate,
  p: { in: string; name: string },
  value: unknown,
  omit = false,
): RequestTemplate {
  const t: RequestTemplate = structuredClone(tpl);
  const bag = p.in === "path" ? t.pathParams : p.in === "query" ? t.query : t.headers;
  if (omit) delete (bag as Record<string, unknown>)[p.name];
  else (bag as Record<string, unknown>)[p.name] = p.in === "header" ? String(value) : value;
  return t;
}

function withBody(tpl: RequestTemplate, body: RawBody): RequestTemplate {
  const t: RequestTemplate = structuredClone(tpl);
  t.body = body;
  return t;
}

export function contractCases(g: GenContext, op: Operation): BugCase[] {
  const out = [single(g, "contract", op, baseRequest(g, op), "valid request")];
  const full = baseRequest(g, op, { full: true });
  if (JSON.stringify(full) !== JSON.stringify(out[0]?.steps[0]?.request))
    out.push(single(g, "contract", op, full, "valid request (all optional fields)"));
  return out;
}

function paramVariants(g: GenContext, op: Operation, mode: "boundary" | "equivalence"): BugCase[] {
  const out: BugCase[] = [];
  const base = baseRequest(g, op);
  const sc = sctx(g, op);
  for (const p of op.params) {
    if (p.in === "cookie" || (p.in === "header" && (isAuthHeader(p.name) || p.name === op.idempotencyHeader)))
      continue;
    const cases =
      mode === "boundary" ? boundaryValues(p.schema, sc) : equivalenceValues(p.schema, sc, p.name);
    for (const c of cases) {
      if (p.in === "path" && (c.value === null || typeof c.value === "object" || c.value === "")) continue;
      const tpl = withParam(base, p, c.value);
      out.push(
        single(
          g,
          mode,
          op,
          tpl,
          `${p.in} ${p.name} = ${JSON.stringify(c.value)?.slice(0, 40)} (${c.label})`,
          `${p.in}:${p.name}`,
        ),
      );
    }
    if (mode === "equivalence" && p.required && p.in !== "path") {
      out.push(
        single(
          g,
          mode,
          op,
          withParam(base, p, undefined, true),
          `${p.in} ${p.name} missing`,
          `${p.in}:${p.name}`,
        ),
      );
    }
  }
  if (op.body?.schema !== undefined && base.body.kind === "json") {
    for (const v of objectVariants(op.body.schema, base.body.value, sc, mode)) {
      out.push(
        single(
          g,
          mode,
          op,
          withBody(base, { kind: "json", value: v.value }),
          `body ${v.pointer || "(root)"} ${v.label}`,
          v.pointer,
        ),
      );
    }
  }
  return out;
}

export function boundaryCases(g: GenContext, op: Operation): BugCase[] {
  return paramVariants(g, op, "boundary");
}

export function equivalenceCases(g: GenContext, op: Operation): BugCase[] {
  return paramVariants(g, op, "equivalence");
}

export function pairwiseCases(g: GenContext, op: Operation): BugCase[] {
  const base = baseRequest(g, op);
  const sc = sctx(g, op);
  const params = op.params.filter(
    (p) =>
      (p.in === "query" || p.in === "header") && !isAuthHeader(p.name) && p.name !== op.idempotencyHeader,
  );
  const valueSets: unknown[][] = params.map((p) => {
    const s = normalize(p.schema, g.contract.resolver);
    const vals = scalarClasses(s, sc, p.name, 4);
    if (!p.required) vals.unshift(ABSENT);
    return vals.slice(0, 5);
  });
  // JSON body properties (enum, boolean, numeric/string boundary classes, optional present/absent,
  // nested objects up to depth 3) join the same covering array as the parameters.
  const body =
    op.body?.schema !== undefined && base.body.kind === "json"
      ? bodyFactors(op.body.schema, sc, { maxDepth: 3, maxFactors: 12, maxValues: 4 })
      : undefined;
  const bodyF = body?.factors ?? [];
  const sizes = [...valueSets.map((v) => v.length), ...bodyF.map((f) => f.values.length)];
  if (sizes.length < 2) return [];
  const offset = valueSets.length;
  const rows = ipog(sizes, bodyF.length > 0 ? { constraint: bodyConstraint(bodyF, offset) } : {});
  return rows.slice(0, g.input.maxCasesPerOperation).map((row) => {
    let tpl = base;
    const parts: string[] = [];
    params.forEach((p, i) => {
      const v = valueSets[i]?.[row[i] as number];
      tpl = v === ABSENT ? withParam(tpl, p, undefined, true) : withParam(tpl, p, v);
      parts.push(`${p.name}=${showValue(v)}`);
    });
    if (body && bodyF.length > 0) {
      tpl = withBody(tpl, { kind: "json", value: applyBodyRow(body, row, offset) });
      bodyF.forEach((f, i) => {
        if (factorActive(bodyF, row, offset, i))
          parts.push(`${f.pointer}=${showValue(f.values[row[offset + i] as number])}`);
      });
    }
    const label = `pairwise ${parts.join(" ")}`;
    return single(g, "pairwise", op, tpl, label.length > 200 ? `${label.slice(0, 199)}…` : label);
  });
}

export function negativeCases(g: GenContext, op: Operation): BugCase[] {
  const base = baseRequest(g, op);
  const out: BugCase[] = [];
  if (op.body && base.body.kind === "json") {
    for (const m of negativeMutations(base.body.value, { mediaType: op.body.mediaType })) {
      const tpl = withBody(base, m.body);
      if (m.structural) {
        out.push(
          mkCase(g, "negative", op, `${m.operator}`, [
            { request: tpl, expect: "invalid", inputPointer: `body:${m.operator}`, label: m.operator },
          ]),
        );
      } else {
        const c = single(
          g,
          "negative",
          op,
          tpl,
          `${m.operator} ${m.pointer}`,
          m.pointer || `body:${m.operator}`,
        );
        out.push(c);
      }
    }
  } else {
    const tpl = structuredClone(base);
    tpl.query.__sw_extra = "1";
    out.push(
      mkCase(g, "negative", op, "unknown query parameter", [
        { request: tpl, expect: "any", label: "unknown query parameter" },
      ]),
    );
  }
  return out;
}

// ------------------------------------------------------------------ resources (stateful/BOLA)

export interface DerivedResource {
  name: string;
  create: Operation;
  read: Operation;
  update?: Operation;
  delete?: Operation;
  idPointer: string;
  /** Name of the item path parameter (e.g. "id"). */
  idParam: string;
  role?: string;
  body?: unknown;
}

function lastParam(path: string): string | undefined {
  const m = /\{([^}]+)\}\/?$/.exec(path);
  return m?.[1];
}

export function findOp(contract: Contract, pattern: string): Operation | undefined {
  const [m, ...rest] = pattern.trim().split(/\s+/);
  const p = rest.join(" ");
  return (
    contract.operations.find((o) => o.method === (m ?? "").toUpperCase() && o.path === p) ??
    contract.operations.find((o) => matchesPattern(o, pattern))
  );
}

export function deriveResources(contract: Contract, configured?: ResourceSpec[]): DerivedResource[] {
  const out: DerivedResource[] = [];
  if (configured && configured.length > 0) {
    for (const r of configured) {
      const create = findOp(contract, r.create);
      const read = findOp(contract, r.read);
      if (!create || !read) continue;
      const d: DerivedResource = {
        name: r.name,
        create,
        read,
        idPointer: r.idPointer,
        idParam: lastParam(read.path) ?? "id",
      };
      const up = r.update ? findOp(contract, r.update) : undefined;
      const del = r.delete ? findOp(contract, r.delete) : undefined;
      if (up) d.update = up;
      if (del) d.delete = del;
      if (r.role) d.role = r.role;
      if (r.body !== undefined) d.body = r.body;
      out.push(d);
    }
    return out;
  }
  for (const create of contract.operations) {
    if (create.method !== "POST" || /\{[^}]+\}\/?$/.test(create.path)) continue;
    if (!create.responses.some((r) => r.status.startsWith("2"))) continue;
    const base = create.path.replace(/\/$/, "");
    const itemRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\{[^}/]+\\}$`);
    const read = contract.operations.find((o) => o.method === "GET" && itemRe.test(o.path));
    if (!read) continue;
    const d: DerivedResource = {
      name: singular(resourceOf(base) ?? base),
      create,
      read,
      idPointer: "/id",
      idParam: lastParam(read.path) ?? "id",
    };
    const up = contract.operations.find(
      (o) => (o.method === "PUT" || o.method === "PATCH") && o.path === read.path,
    );
    const del = contract.operations.find((o) => o.method === "DELETE" && o.path === read.path);
    if (up) d.update = up;
    if (del) d.delete = del;
    out.push(d);
  }
  return out;
}

function createTemplate(g: GenContext, r: DerivedResource, role?: string): RequestTemplate {
  const tpl = baseRequest(g, r.create);
  if (r.body !== undefined) tpl.body = { kind: "json", value: r.body };
  if (role !== undefined) tpl.role = role;
  else if (r.role !== undefined) tpl.role = r.role;
  if (r.create.idempotencyHeader) delete tpl.headers[r.create.idempotencyHeader];
  return tpl;
}

function itemTemplate(
  g: GenContext,
  op: Operation,
  r: DerivedResource,
  idVar: string,
  role?: string,
): RequestTemplate {
  const tpl = baseRequest(g, op);
  tpl.pathParams[r.idParam] = `{{${idVar}}}`;
  if (role !== undefined) tpl.role = role;
  else if (r.role !== undefined) tpl.role = r.role;
  return tpl;
}

export function statefulCases(g: GenContext, resources: DerivedResource[]): BugCase[] {
  const out: BugCase[] = [];
  for (const r of resources) {
    out.push({
      id: caseId("stateful"),
      technique: "stateful",
      operation: r.read.key,
      label: `round-trip ${r.create.key} → ${r.read.key}`,
      seed: g.seed,
      steps: [
        { request: createTemplate(g, r), extract: { rid: r.idPointer }, expect: "valid", label: "create" },
        { request: itemTemplate(g, r.read, r, "rid"), expect: "valid", label: "read back" },
      ],
      check: { kind: "round-trip", create: 0, read: 1 },
    });
  }
  // Idempotency: same key twice → same resource.
  for (const op of g.contract.operations) {
    if (!op.idempotencyHeader || !op.mutating) continue;
    const tpl = baseRequest(g, op);
    tpl.headers[op.idempotencyHeader] = `sw-idem-${g.seed}-${g.rng.int(1, 1_000_000_000)}`;
    const ptr = deriveResources(g.contract).find((r) => r.create.key === op.key)?.idPointer ?? "/id";
    out.push({
      id: caseId("stateful"),
      technique: "stateful",
      operation: op.key,
      label: `idempotency ${op.key} (${op.idempotencyHeader} repeated)`,
      seed: g.seed,
      steps: [
        { request: tpl, expect: "valid", label: "first" },
        { request: tpl, expect: "valid", label: "repeat with same key" },
      ],
      check: { kind: "idempotent", pointer: ptr },
    });
  }
  return out;
}

// ------------------------------------------------------------------ auth matrix

const PRIV_TEXT = /\b(admin|administrator|privileged|staff|superuser|root)\b/i;

export function isPrivileged(g: GenContext, op: Operation): boolean {
  if (g.input.auth.privileged.some((p) => matchesPattern(op, p))) return true;
  const documents403 = op.responses.some((r) => r.status === "403");
  const text = `${op.summary} ${op.description} ${op.tags.join(" ")} ${op.path}`;
  return documents403 && PRIV_TEXT.test(text);
}

export function authCases(g: GenContext, ops: Operation[], resources: DerivedResource[]): BugCase[] {
  const out: BugCase[] = [];
  for (const op of ops) {
    if (!op.secured) continue;
    const base = baseRequest(g, op);
    const variants: [string | null, string][] = [
      [null, "no credentials"],
      [ROLE_INVALID, "invalid token"],
    ];
    if (g.input.auth.expiredToken) variants.push([ROLE_EXPIRED, "expired token"]);
    for (const [role, label] of variants) {
      const tpl = structuredClone(base);
      tpl.role = role;
      out.push(
        mkCase(g, "auth", op, `${label}`, [{ request: tpl, expect: "none", label }], {
          kind: "denied",
          step: 0,
          rule: "bugs/missing-authentication",
          detail: `${op.key} with ${label} must be rejected (401/403)`,
        }),
      );
    }
    // BFLA: privileged operation with an ordinary account.
    const attacker = g.roles.unprivileged[0];
    if (attacker !== undefined && g.roles.privileged.length > 0 && isPrivileged(g, op)) {
      const tpl = structuredClone(base);
      tpl.role = attacker;
      out.push(
        mkCase(
          g,
          "auth",
          op,
          `privileged operation as ${attacker}`,
          [{ request: tpl, expect: "none", label: `as ${attacker}` }],
          {
            kind: "denied",
            step: 0,
            rule: "bugs/bfla",
            detail: `${op.key} is privileged; a regular account (${attacker}) must get 403`,
          },
        ),
      );
    }
  }
  // BOLA: owner creates, attacker accesses the owner's object.
  const { owner, attacker } = g.roles;
  if (owner !== undefined && attacker !== undefined && owner !== attacker) {
    for (const r of resources) {
      if (!r.read.secured) continue;
      for (const op of [r.read, r.update, r.delete]) {
        if (!op) continue;
        const access = itemTemplate(g, op, r, "rid", attacker);
        if (op === r.update && r.body !== undefined) access.body = { kind: "json", value: r.body };
        out.push({
          id: caseId("auth"),
          technique: "auth",
          operation: op.key,
          label: `BOLA: ${attacker} → ${owner}'s ${r.name}`,
          seed: g.seed,
          steps: [
            {
              request: createTemplate(g, r, owner),
              extract: { rid: r.idPointer },
              expect: "none",
              label: `${owner} creates ${r.name}`,
            },
            { request: access, expect: "none", label: `${attacker} ${op.method} ${op.path}` },
          ],
          check: {
            kind: "denied",
            step: 1,
            rule: "bugs/bola",
            detail: `${attacker} accessed ${owner}'s ${r.name} via ${op.key} (expected 403/404)`,
          },
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ concurrency

function concurrencyTemplate(
  g: GenContext,
  spec: {
    operation: string;
    role?: string | undefined;
    pathParams: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, string>;
    body?: unknown;
  },
): { tpl: RequestTemplate; op: Operation | undefined } {
  const op = findOp(g.contract, spec.operation);
  const [m, ...rest] = spec.operation.trim().split(/\s+/);
  const tpl: RequestTemplate = op
    ? baseRequest(g, op)
    : {
        operation: spec.operation,
        method: (m ?? "POST").toUpperCase(),
        path: rest.join(" "),
        pathParams: {},
        query: {},
        headers: {},
        body: { kind: "none" },
        secured: true,
      };
  Object.assign(tpl.pathParams, spec.pathParams);
  Object.assign(tpl.query, spec.query);
  Object.assign(tpl.headers, spec.headers);
  if (op?.idempotencyHeader) delete tpl.headers[op.idempotencyHeader];
  if (spec.body !== undefined) tpl.body = { kind: "json", value: spec.body };
  else if (!/^(POST|PUT|PATCH)$/.test(tpl.method)) tpl.body = { kind: "none" };
  if (spec.role !== undefined) tpl.role = spec.role;
  return { tpl, op };
}

export function concurrencyCases(g: GenContext, tests: ConcurrencyTest[]): BugCase[] {
  const out: BugCase[] = [];
  tests.forEach((t, i) => {
    const { tpl, op } = concurrencyTemplate(g, t);
    if (t.sameIdempotencyKey)
      tpl.headers[op?.idempotencyHeader ?? "Idempotency-Key"] = `sw-burst-${g.seed}-${i}`;
    const step: CaseStep = { request: tpl, burst: t.burst, expect: "none", label: `burst x${t.burst}` };
    if (t.mix.length > 0) {
      step.mix = t.mix.map((m, tag) => ({
        request: concurrencyTemplate(g, m).tpl,
        count: m.count,
        phase: m.phase,
        tag,
      }));
      step.label = `burst x${t.burst} + ${t.mix.map((m) => `${m.count}x ${m.operation} (${m.as}, ${m.phase})`).join(", ")}`;
    }
    out.push({
      id: caseId("concurrency"),
      technique: "concurrency",
      operation: op?.key ?? t.operation,
      label: t.name ?? `${t.burst} concurrent ${t.operation}${t.mix.length > 0 ? " (mixed)" : ""}`,
      seed: g.seed,
      steps: [step],
      check: { kind: "concurrency", test: i },
    });
  });
  return out;
}
