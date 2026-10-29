/**
 * Compiles scenarios once into prepared steps: origins resolved, headers pre-merged into undici's
 * flat array form, static bodies pre-serialised, templates compiled to closures, expect/extract
 * rules compiled. See docs/05-optimization.md §2 (items 1-4) and docs/03-engines/performance-lab.md §3.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { HttpRequestSpec, HttpResult } from "../../adapters/http/undici-executor.js";
import { ConfigError } from "../../core/errors.js";
import type { Rng } from "../../core/types.js";
import type { PerformanceInput, PerformanceStep } from "./schema.js";
import {
  type CompiledTemplate,
  compileJsonBody,
  compileTemplate,
  TemplateError,
  type TemplateScope,
} from "./templates.js";

export type Extractor =
  | { var: string; kind: "json"; path: (string | number)[] }
  | { var: string; kind: "header"; name: string }
  | { var: string; kind: "regex"; re: RegExp };

export interface CompiledStep {
  /** Endpoint key used for metrics: "METHOD /path-template". */
  key: string;
  name: string;
  scenario: string;
  method: string;
  origin: string;
  /** Path template (for reports). */
  pathTemplate: string;
  path: CompiledTemplate;
  /** Constant headers already flattened, plus templated ones. */
  staticHeaders: string[];
  dynamicHeaders: [string, CompiledTemplate][];
  body: Buffer | CompiledTemplate | undefined;
  readBody: boolean;
  /** null → default rule: status < 400. */
  expectStatus: ReadonlySet<number> | null;
  bodyContains: string | undefined;
  followRedirects: boolean;
  extractors: Extractor[];
}

export interface CompiledScenario {
  name: string;
  weight: number;
  steps: CompiledStep[];
}

export interface CompiledPlan {
  scenarios: CompiledScenario[];
  /** Cumulative weights for O(k) weighted pick. */
  cumulative: number[];
  totalWeight: number;
  /** Every origin the plan will contact (for the Safety Guard). */
  origins: string[];
}

/** Parses "$.a.b[0].c" / "$['x']" into path segments. */
export function parseJsonPath(expr: string): (string | number)[] {
  const s = expr.trim();
  if (!s.startsWith("$"))
    throw new ConfigError("SW_CONFIG_EXTRACT", `extract path must start with "$": ${expr}`);
  const out: (string | number)[] = [];
  let i = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      let j = i + 1;
      while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
      const key = s.slice(i + 1, j);
      if (key === "") throw new ConfigError("SW_CONFIG_EXTRACT", `empty key in extract path: ${expr}`);
      out.push(key);
      i = j;
    } else if (c === "[") {
      const j = s.indexOf("]", i);
      if (j < 0) throw new ConfigError("SW_CONFIG_EXTRACT", `unterminated [ in extract path: ${expr}`);
      const inner = s.slice(i + 1, j).trim();
      if (/^\d+$/.test(inner)) out.push(Number(inner));
      else if (/^(['"]).*\1$/.test(inner)) out.push(inner.slice(1, -1));
      else
        throw new ConfigError(
          "SW_CONFIG_EXTRACT",
          `unsupported selector [${inner}] in extract path: ${expr}`,
        );
      i = j + 1;
    } else {
      throw new ConfigError("SW_CONFIG_EXTRACT", `unexpected "${c}" in extract path: ${expr}`);
    }
  }
  return out;
}

function compileExtractor(name: string, expr: string): Extractor {
  if (expr.startsWith("header:"))
    return { var: name, kind: "header", name: expr.slice(7).trim().toLowerCase() };
  if (expr.startsWith("regex:")) {
    try {
      return { var: name, kind: "regex", re: new RegExp(expr.slice(6)) };
    } catch (e) {
      throw new ConfigError("SW_CONFIG_EXTRACT", `invalid regex for ${name}: ${(e as Error).message}`);
    }
  }
  return { var: name, kind: "json", path: parseJsonPath(expr) };
}

function wrapTemplate<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TemplateError) throw new ConfigError("SW_CONFIG_TEMPLATE", e.message);
    throw e;
  }
}

function authHeader(auth: PerformanceInput["auth"], scenario: string | null): [string, string] | null {
  if (!auth) return null;
  if (typeof auth === "string") {
    const where = scenario === null ? "performance.auth" : `scenario "${scenario}" auth`;
    throw new ConfigError("SW_CONFIG_AUTH", `${where}: role "${auth}" was not resolved to credentials`, {
      hint: `Define "${auth}" in config.auth and run through createWorld / the CLI, or pass a resolved auth object ({ type: "bearer", token })`,
    });
  }
  switch (auth.type) {
    case "bearer":
      return ["authorization", `Bearer ${auth.token}`];
    case "basic":
      return [
        "authorization",
        `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
      ];
    case "header":
      return [auth.name.toLowerCase(), auth.value];
  }
}

function resolveOriginAndPath(target: URL, path: string): { origin: string; path: string } {
  if (/^https?:\/\//i.test(path)) {
    const m = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(path);
    if (!m || (m[1] ?? "").includes("{{")) {
      throw new ConfigError("SW_CONFIG_STEP", `absolute step URL must have a constant origin: ${path}`);
    }
    const origin = new URL(m[1] as string).origin;
    const rest = m[2] ?? "";
    return { origin, path: rest === "" ? "/" : rest };
  }
  if (path.startsWith("/")) return { origin: target.origin, path };
  const base = target.pathname.endsWith("/") ? target.pathname : `${target.pathname}/`;
  return { origin: target.origin, path: base + path };
}

function compileStep(
  step: PerformanceStep,
  scenario: string,
  idx: number,
  input: PerformanceInput,
  auth: [string, string] | null,
): CompiledStep {
  const target = new URL(input.target);
  const { origin, path: rawPath } = resolveOriginAndPath(target, step.path);
  // Query: appended with URI-encoded templated values.
  let pathSrc = rawPath;
  const q = Object.entries(step.query);
  if (q.length > 0) {
    const qs = q.map(([k, v]) => `${encodeURIComponent(k)}=${String(v)}`).join("&");
    pathSrc += (pathSrc.includes("?") ? "&" : "?") + qs;
  }
  const path = wrapTemplate(() => compileTemplate(pathSrc, encodeURIComponent));

  const headers: Record<string, string> = {};
  // Scenario auth (or section auth) first; explicit step headers override it.
  if (auth) headers[auth[0]] = auth[1];
  for (const [k, v] of Object.entries(step.headers)) headers[k.toLowerCase()] = v;
  let body: Buffer | CompiledTemplate | undefined;
  if (step.json !== undefined) {
    const c = wrapTemplate(() => compileJsonBody(step.json));
    body = c.constant ?? c.render;
    if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
  } else if (step.body !== undefined) {
    const t = wrapTemplate(() => compileTemplate(step.body as string));
    body = t.constant ? Buffer.from(step.body) : t;
  }
  const staticHeaders: string[] = [];
  const dynamicHeaders: [string, CompiledTemplate][] = [];
  for (const [k, v] of Object.entries(headers)) {
    const t = wrapTemplate(() => compileTemplate(v));
    if (t.constant) staticHeaders.push(k, v);
    else dynamicHeaders.push([k, t]);
  }
  if (Buffer.isBuffer(body)) staticHeaders.push("content-length", String(body.length));

  const extractors = Object.entries(step.extract).map(([k, v]) => compileExtractor(k, v));
  const st = step.expect?.status;
  const expectStatus = st === undefined ? null : new Set(Array.isArray(st) ? st : [st]);
  const bodyContains = step.expect?.bodyContains;
  const readBody = bodyContains !== undefined || extractors.some((e) => e.kind !== "header");
  const pathTemplate = origin === target.origin ? rawPath : `${origin}${rawPath}`;
  return {
    key: `${step.method} ${pathTemplate.split("?")[0]}`,
    name: step.name ?? `${scenario}#${idx + 1}`,
    scenario,
    method: step.method,
    origin,
    pathTemplate,
    path,
    staticHeaders,
    dynamicHeaders,
    body,
    readBody,
    followRedirects: step.followRedirects,
    expectStatus,
    bodyContains,
    extractors,
  };
}

export function compilePlan(input: PerformanceInput): CompiledPlan {
  const origins = new Set<string>();
  const sectionAuth = authHeader(input.auth, null);
  const scenarios: CompiledScenario[] = input.scenarios.map((sc) => {
    const auth = sc.auth !== undefined ? authHeader(sc.auth, sc.name) : sectionAuth;
    const steps = sc.steps.map((st, i) => compileStep(st, sc.name, i, input, auth));
    for (const s of steps) origins.add(s.origin);
    return { name: sc.name, weight: sc.weight, steps };
  });
  const cumulative: number[] = [];
  let total = 0;
  for (const s of scenarios) {
    total += s.weight;
    cumulative.push(total);
  }
  return { scenarios, cumulative, totalWeight: total, origins: [...origins] };
}

export function pickScenario(plan: CompiledPlan, rng: Rng): CompiledScenario {
  if (plan.scenarios.length === 1) return plan.scenarios[0] as CompiledScenario;
  const x = rng.next() * plan.totalWeight;
  for (let i = 0; i < plan.cumulative.length; i++) {
    if (x < (plan.cumulative[i] as number)) return plan.scenarios[i] as CompiledScenario;
  }
  return plan.scenarios[plan.scenarios.length - 1] as CompiledScenario;
}

/** Renders a step into a transport request for one iteration. */
export function renderRequest(step: CompiledStep, scope: TemplateScope): HttpRequestSpec {
  let headers = step.staticHeaders;
  let body: Buffer | string | undefined;
  if (step.body === undefined) body = undefined;
  else if (Buffer.isBuffer(step.body)) body = step.body;
  else body = step.body(scope);
  if (step.dynamicHeaders.length > 0 || typeof body === "string") {
    headers = headers.slice();
    for (const [k, t] of step.dynamicHeaders) headers.push(k, t(scope));
  }
  const req: HttpRequestSpec = {
    origin: step.origin,
    method: step.method,
    path: step.path(scope),
    headers,
    readBody: step.readBody,
    ...(step.followRedirects ? { followRedirects: true } : {}),
  };
  if (body !== undefined) req.body = body;
  return req;
}

export type CheckOutcome =
  | { ok: true }
  | { ok: false; kind: "status" | "assertion" | "extract"; message: string };

/** Applies `expect` rules and extraction (writing into `vars`). */
export function checkResponse(
  step: CompiledStep,
  res: HttpResult,
  vars: Record<string, string>,
): CheckOutcome {
  const okStatus = step.expectStatus === null ? res.status < 400 : step.expectStatus.has(res.status);
  if (!okStatus) {
    return {
      ok: false,
      kind: "status",
      message: `unexpected status ${res.status}${step.expectStatus ? ` (expected ${[...step.expectStatus].join("|")})` : ""}`,
    };
  }
  let text: string | undefined;
  const bodyText = (): string => {
    if (text === undefined) text = res.body ? res.body.toString("utf8") : "";
    return text;
  };
  if (step.bodyContains !== undefined && !bodyText().includes(step.bodyContains)) {
    return {
      ok: false,
      kind: "assertion",
      message: `body does not contain ${JSON.stringify(step.bodyContains)}`,
    };
  }
  if (step.extractors.length === 0) return { ok: true };
  let json: unknown;
  let jsonParsed = false;
  for (const ex of step.extractors) {
    let value: string | undefined;
    if (ex.kind === "header") {
      const h = res.headers?.[ex.name];
      value = Array.isArray(h) ? h[0] : h;
    } else if (ex.kind === "regex") {
      const m = ex.re.exec(bodyText());
      value = m ? (m[1] ?? m[0]) : undefined;
    } else {
      if (!jsonParsed) {
        jsonParsed = true;
        try {
          json = JSON.parse(bodyText());
        } catch {
          json = undefined;
        }
      }
      let cur: unknown = json;
      for (const seg of ex.path) {
        if (cur === null || typeof cur !== "object") {
          cur = undefined;
          break;
        }
        cur = (cur as Record<string | number, unknown>)[seg];
      }
      if (cur !== undefined && cur !== null)
        value = typeof cur === "object" ? JSON.stringify(cur) : String(cur);
    }
    if (value === undefined) return { ok: false, kind: "extract", message: `could not extract "${ex.var}"` };
    vars[ex.var] = value;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- data feeder

export type DataRow = Record<string, string | number | boolean>;

export interface DataFeeder {
  /** Next row, or null when a `unique` feeder is exhausted. */
  next(rng: Rng): DataRow | null;
  readonly size: number;
}

/** Minimal RFC-4180-ish CSV parser (quoted fields, "" escapes, header row). Iterative. */
export function parseCsv(text: string): DataRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows.map((r) => {
    const o: DataRow = {};
    header.forEach((h, idx) => {
      o[h.trim()] = r[idx] ?? "";
    });
    return o;
  });
}

export async function loadData(
  data: NonNullable<PerformanceInput["data"]>,
  cwd = process.cwd(),
  /** worker_threads sharding: this shard reads rows index, index+count, … (falls back to all rows when its share is empty and rows may repeat). */
  shard?: { count: number; index: number },
): Promise<DataFeeder> {
  let rows: DataRow[] = data.rows ?? [];
  if (data.file !== undefined) {
    const { resolve } = await import("node:path");
    const file = resolve(cwd, data.file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      throw new ConfigError("SW_CONFIG_DATA", `cannot read data file ${data.file}: ${(e as Error).message}`);
    }
    const ext = extname(file).toLowerCase();
    try {
      if (ext === ".csv") rows = parseCsv(text);
      else if (ext === ".jsonl" || ext === ".ndjson")
        rows = text
          .split(/\r?\n/)
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as DataRow);
      else rows = JSON.parse(text) as DataRow[];
    } catch (e) {
      throw new ConfigError("SW_CONFIG_DATA", `cannot parse data file ${data.file}: ${(e as Error).message}`);
    }
    if (!Array.isArray(rows))
      throw new ConfigError("SW_CONFIG_DATA", `data file ${data.file} must contain an array of rows`);
  }
  if (rows.length === 0) throw new ConfigError("SW_CONFIG_DATA", "data feeder has no rows");
  let all = rows;
  if (shard && shard.count > 1) {
    const part = rows.filter((_, idx) => idx % shard.count === shard.index);
    if (part.length > 0 || data.mode === "unique") all = part;
  }
  let i = 0;
  return {
    size: all.length,
    next(rng: Rng): DataRow | null {
      switch (data.mode) {
        case "random":
          return rng.pick(all);
        case "unique":
          return i < all.length ? (all[i++] as DataRow) : null;
        default: {
          const r = all[i % all.length] as DataRow;
          i++;
          return r;
        }
      }
    },
  };
}
