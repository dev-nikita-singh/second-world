/**
 * Suggested tests — docs/03-engines/adversarial-test-agent.md §6 ("suggested tests to add
 * permanently to the user's suite, exported as Vitest/Jest or `sw` config").
 *
 * For each confirmed defect the agent emits:
 * - a self-contained Vitest file (Node ≥ 18 global fetch, no extra dependencies) that replays
 *   the minimised scenario and states its assertions as `expect` calls;
 * - an `sw` config snippet that pins the scenario under `agent.regression`.
 * Every scenario value is embedded with JSON.stringify (never spliced into code), and
 * credentials are never written: each test account's credential is read from
 * `SW_AUTH_<ROLE>` at run time, the same convention as the curl reproductions.
 */
import type { Credential } from "../bugs/schema.js";
import { parallelStep, type Scenario, type ScenarioAssertion } from "./scenario.js";

export interface SuggestedTest {
  fingerprint: string;
  ruleId: string;
  operation: string;
  title: string;
  /** Suggested file name, e.g. "agent-bola-get-orders-id.test.ts". */
  filename: string;
  vitest: string;
  /** Snippet for sw.config.ts (agent.regression). */
  config: string;
}

export interface ExportMeta {
  fingerprint: string;
  ruleId: string;
  operation: string;
  target: string;
  /** Effective role per step (setup first, then steps); null = anonymous. */
  roles: (string | null)[];
  /** Methods/paths per step (setup first, then steps). */
  requests: { method: string; path: string }[];
  /** Credential kinds of configured roles (no secrets). */
  credentials: Record<string, Credential>;
  /** Required top-level properties / primitive types per step index for schema-valid assertions. */
  shapes?: Record<number, { required: string[]; types: Record<string, string> }>;
}

/**
 * JSON is not quite JS source: U+2028/U+2029 survive JSON.stringify but are line terminators in JS,
 * so inside a `//` comment they would end it and turn the rest of an untrusted value (e.g. an OpenAPI
 * operation name) into code. Escape them everywhere a value is embedded in generated source.
 */
const jsSafe = (json: string): string => json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const J = (v: unknown): string => jsSafe(JSON.stringify(v));

export function envNameFor(role: string): string {
  return `SW_AUTH_${role.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "case"
  );
}

function authSpec(c: Credential | undefined): { header: string; prefix: string } {
  if (!c || c.type === "bearer") return { header: "authorization", prefix: "Bearer " };
  if (c.type === "basic") return { header: "authorization", prefix: "Basic " };
  return { header: c.name.toLowerCase(), prefix: "" };
}

function assertionLines(a: ScenarioAssertion, meta: ExportMeta, offset: number): string[] {
  const r = (i: number): string => `steps[${i}]`;
  const is2xx = (x: string): string => `(${x}.status >= 200 && ${x}.status < 300)`;
  switch (a.kind) {
    case "status":
      return [`expect(${J(a.oneOf)}).toContain(${r(a.step)}.status);`];
    case "status-class": {
      const x = `${r(a.step)}`;
      const cond = {
        "2xx": is2xx(x),
        "4xx": `(${x}.status >= 400 && ${x}.status < 500)`,
        "not-2xx": `!${is2xx(x)}`,
        "not-5xx": `${x}.status < 500`,
      }[a.class];
      return [`expect(${cond}, ${J(`step ${a.step} must be ${a.class}`)}).toBe(true);`];
    }
    case "no-5xx":
      return ["for (const s of [...setup, ...steps, ...copies]) expect(s.status).toBeLessThan(500);"];
    case "same-json":
      return [
        `expect(at(${r(a.steps[1])}.json, ${J(a.pointer)})).toEqual(at(${r(a.steps[0])}.json, ${J(a.pointer)}));`,
      ];
    case "copies-agree":
      return [
        `const agreeing = new Set(copies.filter((c) => c.status >= 200 && c.status < 300).map((c) => JSON.stringify(at(c.json, ${J(a.pointer)}))));`,
        "expect(agreeing.size).toBeLessThanOrEqual(1);",
      ];
    case "max-success":
      return [
        `expect(copies.filter((c) => c.status >= 200 && c.status < 300).length).toBeLessThanOrEqual(${a.max});`,
      ];
    case "json": {
      const v = `at(${r(a.step)}.json, ${J(a.pointer)})`;
      const out: string[] = [];
      if (a.exists !== undefined)
        out.push(a.exists ? `expect(${v}).toBeDefined();` : `expect(${v}).toBeUndefined();`);
      if (a.equals !== undefined) out.push(`expect(${v}).toEqual(${J(a.equals)});`);
      if (a.type !== undefined)
        out.push(`expect(typeOf(${v})).toBe(${J(a.type === "integer" ? "number" : a.type)});`);
      return out;
    }
    case "max-duration":
      return [`expect(${r(a.step)}.ms).toBeLessThan(${a.ms});`];
    case "schema-valid": {
      const shape = meta.shapes?.[a.step + offset];
      const out = [`expect(${r(a.step)}.status).toBeLessThan(500);`];
      if (shape) {
        out.push(`if (${r(a.step)}.status >= 200 && ${r(a.step)}.status < 300) {`);
        for (const k of shape.required)
          out.push(`  expect(at(${r(a.step)}.json, ${J(`/${k}`)})).toBeDefined();`);
        for (const [k, t] of Object.entries(shape.types))
          out.push(
            `  expect(typeOf(at(${r(a.step)}.json, ${J(`/${k}`)}))).toBe(${J(t === "integer" ? "number" : t)});`,
          );
        out.push("}");
      }
      return out;
    }
  }
}

const RUNTIME = `interface Res { status: number; json: unknown; ms: number }
interface Req { method: string; path: string; role: string | null; pathParams?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown; extract?: Record<string, string> }

const TARGET = (process.env.SW_TARGET ?? DEFAULT_TARGET).replace(/\\/$/, "");
const NONCE = \`sw-\${randomUUID()}\`;

function at(json: unknown, pointer: string): unknown {
  if (pointer === "") return json;
  let cur: unknown = json;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function typeOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function fill(v: unknown, scope: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const whole = /^\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}$/.exec(v);
    if (whole) return whole[1] === "$nonce" ? NONCE : scope[whole[1] as string];
    return v.replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (_m, k: string) => String(k === "$nonce" ? NONCE : scope[k]));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, scope));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, scope)]));
  return v;
}

function credential(role: string): Record<string, string> {
  const spec = AUTH[role];
  const env = \`SW_AUTH_\${role.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}\`;
  const value = process.env[env];
  if (!spec || value === undefined) throw new Error(\`Set \${env} to the credential of the test account "\${role}"\`);
  return { [spec.header]: spec.prefix && !value.toLowerCase().startsWith(spec.prefix.toLowerCase()) ? \`\${spec.prefix}\${value}\` : value };
}

async function send(req: Req, scope: Record<string, unknown>): Promise<Res> {
  const r = fill(req, scope) as Req;
  const path = r.path.replace(/\\{([^}]+)\\}/g, (_m, k: string) => encodeURIComponent(String(r.pathParams?.[k])));
  const url = new URL(TARGET + path);
  for (const [k, v] of Object.entries(r.query ?? {}))
    for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(x));
  const headers: Record<string, string> = { ...(r.role === null ? {} : credential(r.role)), ...(r.headers ?? {}) };
  if (r.body !== undefined) headers["content-type"] ??= "application/json";
  const t0 = performance.now();
  const res = await fetch(url, { method: r.method, headers, ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }) });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  for (const [name, ptr] of Object.entries(r.extract ?? {})) scope[name] = at(json, ptr);
  return { status: res.status, json, ms };
}`;

/** Builds the Vitest file text and the sw config snippet for one confirmed defect. */
export function suggestedTest(s: Scenario, meta: ExportMeta): SuggestedTest {
  const reqs = [...s.setup, ...s.steps].map((st, i) => {
    const rq = meta.requests[i] ?? { method: "GET", path: "/" };
    const o: Record<string, unknown> = { method: rq.method, path: rq.path, role: meta.roles[i] ?? null };
    if (st.pathParams) o.pathParams = st.pathParams;
    if (st.query) o.query = st.query;
    if (st.headers) o.headers = st.headers;
    if (st.body !== undefined) o.body = st.body;
    if (st.extract) o.extract = st.extract;
    return o;
  });
  const setupReqs = reqs.slice(0, s.setup.length);
  const stepReqs = reqs.slice(s.setup.length);
  const roles = new Set(meta.roles.filter((r): r is string => typeof r === "string"));
  const auth: Record<string, { header: string; prefix: string }> = {};
  for (const r of [...roles].sort()) auth[r] = authSpec(meta.credentials[r]);
  const pstep = parallelStep(s);
  const body: string[] = [];
  body.push("const scope: Record<string, unknown> = {};");
  body.push("const setup: Res[] = [];");
  body.push("const steps: Res[] = [];");
  body.push("let copies: Res[] = [];");
  body.push("for (const req of SETUP) {");
  body.push("  const r = await send(req, scope);");
  // Generated code: the template literal is part of the emitted test, not of this module.
  const precondition = "`precondition " + "$" + "{req.method} " + "$" + "{req.path}`";
  body.push(`  expect(r.status, ${precondition}).toBeGreaterThanOrEqual(200);`);
  body.push(`  expect(r.status, ${precondition}).toBeLessThan(300);`);
  body.push("  setup.push(r);");
  body.push("}");
  body.push("for (const [i, req] of STEPS.entries()) {");
  if (pstep !== undefined && s.parallel) {
    body.push(`  if (i === ${pstep}) {`);
    body.push(
      `    copies = await Promise.all(Array.from({ length: ${s.parallel.copies} }, () => send(req, scope)));`,
    );
    body.push("    steps.push(copies[0] as Res);");
    body.push("    continue;");
    body.push("  }");
  }
  body.push("  steps.push(await send(req, scope));");
  body.push("}");
  for (const a of s.assertions) body.push(...assertionLines(a, meta, s.setup.length));
  const indent = (l: string): string => `    ${l}`;
  const lines = [
    `// Suggested by SECOND WORLD (sw agent). Rule ${J(meta.ruleId)} on ${J(meta.operation)}; fingerprint ${J(meta.fingerprint)}.`,
    "// Run against a disposable test environment. Credentials: export SW_AUTH_<ROLE> (the full header value, e.g. \"Bearer <token>\") for each test account used below.",
    'import { randomUUID } from "node:crypto";',
    'import { describe, expect, it } from "vitest";',
    "",
    `const DEFAULT_TARGET = ${J(meta.target)};`,
    `const AUTH: Record<string, { header: string; prefix: string }> = ${J(auth)};`,
    `const SETUP: Req[] = ${J(setupReqs)};`,
    `const STEPS: Req[] = ${J(stepReqs)};`,
    "",
    RUNTIME,
    "",
    `describe(${J(`${meta.operation} — ${meta.ruleId}`)}, () => {`,
    `  it(${J(s.hypothesis)}, async () => {`,
    ...body.map(indent),
    "  });",
    "});",
    "",
  ];
  const pinned = {
    title: s.title,
    hypothesis: s.hypothesis,
    ...(s.setup.length > 0 ? { setup: s.setup } : {}),
    steps: s.steps,
    ...(s.parallel ? { parallel: s.parallel } : {}),
    assertions: s.assertions,
    expectedClassification: s.expectedClassification,
  };
  const config = `// sw.config.ts → agent.regression (re-run on every \`sw agent\`)\nagent: {\n  regression: [\n${jsSafe(JSON.stringify(pinned, null, 2))
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")},\n  ],\n},\n`;
  return {
    fingerprint: meta.fingerprint,
    ruleId: meta.ruleId,
    operation: meta.operation,
    title: s.title,
    filename: `agent-${slug(meta.ruleId.replace(/^.*\//, ""))}-${slug(meta.operation)}.test.ts`,
    vitest: lines.join("\n"),
    config,
  };
}
