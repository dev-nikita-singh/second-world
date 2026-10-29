/**
 * Contract loading: OpenAPI 3.0/3.1 (Swagger 2.0 converted best-effort) → operation index.
 * docs/03-engines/api-bug-hunter.md §1.
 *
 * Uses swagger-parser `bundle` (internal `$ref`s only, never circular object graphs); schemas
 * are resolved lazily by the generators and natively by Ajv (validator.ts).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { ConfigError } from "../../core/errors.js";
import { sha256 } from "../../shared/util/hash.js";
import { createResolver, isObject, type JsonSchema, type SchemaResolver } from "./json-schema.js";
import { type ValidatorCache, validatorCacheFor } from "./validator.js";

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ParamSpec {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: unknown;
  style?: string;
  explode?: boolean;
}

export interface MediaSpec {
  schema?: unknown;
}

export interface ResponseSpec {
  /** "200", "4XX" or "default". */
  status: string;
  description: string;
  content: Record<string, MediaSpec>;
  headers: { name: string; required: boolean; schema?: unknown }[];
}

export interface Operation {
  /** Canonical key "GET /products/{id}". */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  summary: string;
  description: string;
  tags: string[];
  params: ParamSpec[];
  body?: { required: boolean; mediaType: string; schema?: unknown; mediaTypes: string[] };
  responses: ResponseSpec[];
  /** Requires authentication (effective `security` non-empty and no anonymous alternative). */
  secured: boolean;
  mutating: boolean;
  /** Header parameter acting as an idempotency key, if documented. */
  idempotencyHeader?: string;
  pathRegex: RegExp;
}

export interface Contract {
  source: string;
  version: "2.0" | "3.0" | "3.1";
  title?: string;
  hash: string;
  /** Bundled document (Swagger 2 converted to OpenAPI-3 shape for operations; schemas untouched). */
  document: Record<string, unknown>;
  operations: Operation[];
  resolver: SchemaResolver;
  validators: ValidatorCache;
  securitySchemes: Record<string, unknown>;
}

function pathToRegex(path: string): RegExp {
  const parts = path.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}/?$`);
}

function asParam(p: unknown, resolver: SchemaResolver, swagger2: boolean): ParamSpec | undefined {
  const r = resolver.resolve(p);
  const name = r.name;
  const loc = r.in;
  if (typeof name !== "string" || (loc !== "path" && loc !== "query" && loc !== "header" && loc !== "cookie"))
    return undefined;
  let schema: unknown = r.schema;
  if (swagger2 || schema === undefined) {
    // Swagger 2: type/format/enum/min/max live on the parameter itself.
    const s: JsonSchema = {};
    for (const k of [
      "type",
      "format",
      "enum",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minLength",
      "maxLength",
      "pattern",
      "items",
      "minItems",
      "maxItems",
      "uniqueItems",
      "default",
      "multipleOf",
    ]) {
      if (r[k] !== undefined) s[k] = r[k];
    }
    if (schema === undefined) schema = s;
  }
  const spec: ParamSpec = { name, in: loc, required: loc === "path" ? true : r.required === true, schema };
  if (typeof r.style === "string") spec.style = r.style;
  if (typeof r.explode === "boolean") spec.explode = r.explode;
  return spec;
}

/** Parses + bundles a contract from a path, URL-less object, or YAML/JSON text file. */
export async function loadContract(
  source: string | Record<string, unknown>,
  cwd = process.cwd(),
): Promise<Contract> {
  let input: string | Record<string, unknown>;
  let label: string;
  if (typeof source === "string") {
    const p = isAbsolute(source) ? source : resolve(cwd, source);
    label = p;
    try {
      await readFile(p);
    } catch (e) {
      throw new ConfigError("SW_CONFIG_BUGS_CONTRACT", `Cannot read contract ${p}: ${(e as Error).message}`, {
        hint: "Pass bugs.openapi as a path to an OpenAPI 3.x / Swagger 2.0 file",
      });
    }
    input = p;
  } else {
    label = "(inline)";
    input = structuredClone(source);
  }
  let doc: Record<string, unknown>;
  try {
    doc = (await new SwaggerParser().bundle(input as string)) as unknown as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError("SW_CONFIG_BUGS_CONTRACT", `Invalid contract ${label}: ${(e as Error).message}`, {
      hint: "Check the file with an OpenAPI validator",
    });
  }
  return indexContract(doc, label);
}

export function indexContract(doc: Record<string, unknown>, label = "(inline)"): Contract {
  const swagger2 = typeof doc.swagger === "string";
  const ver = typeof doc.openapi === "string" ? doc.openapi : "";
  const version: Contract["version"] = swagger2
    ? "2.0"
    : ver.startsWith("3.1") || ver.startsWith("3.2")
      ? "3.1"
      : "3.0";
  const resolver = createResolver(doc);
  const paths = isObject(doc.paths) ? doc.paths : {};
  const globalSecurity = Array.isArray(doc.security) ? doc.security : [];
  const components = isObject(doc.components) ? doc.components : {};
  const securitySchemes = swagger2
    ? isObject(doc.securityDefinitions)
      ? doc.securityDefinitions
      : {}
    : isObject(components.securitySchemes)
      ? components.securitySchemes
      : {};
  const globalConsumes = Array.isArray(doc.consumes) ? (doc.consumes as string[]) : ["application/json"];
  const globalProduces = Array.isArray(doc.produces) ? (doc.produces as string[]) : ["application/json"];
  const operations: Operation[] = [];
  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = resolver.resolve(itemRaw);
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of HTTP_METHODS) {
      const opRaw = item[m];
      if (!isObject(opRaw)) continue;
      const op = opRaw;
      const method = m.toUpperCase();
      const params = new Map<string, ParamSpec>();
      let body: Operation["body"];
      const consumes = Array.isArray(op.consumes) ? (op.consumes as string[]) : globalConsumes;
      for (const pr of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const r = resolver.resolve(pr);
        if (swagger2 && r.in === "body") {
          body = {
            required: r.required === true,
            mediaType: consumes[0] ?? "application/json",
            mediaTypes: consumes,
            schema: r.schema,
          };
          continue;
        }
        if (swagger2 && r.in === "formData") continue;
        const p = asParam(pr, resolver, swagger2);
        if (p) params.set(`${p.in}:${p.name}`, p);
      }
      if (!swagger2 && op.requestBody !== undefined) {
        const rb = resolver.resolve(op.requestBody);
        const content = isObject(rb.content) ? rb.content : {};
        const types = Object.keys(content);
        const mt = types.find((t) => /json/i.test(t)) ?? types[0];
        if (mt) {
          const media = resolver.resolve(content[mt]);
          body = { required: rb.required === true, mediaType: mt, mediaTypes: types, schema: media.schema };
        }
      }
      const responses: ResponseSpec[] = [];
      const respRaw = isObject(op.responses) ? op.responses : {};
      const produces = Array.isArray(op.produces) ? (op.produces as string[]) : globalProduces;
      for (const [status, rRaw] of Object.entries(respRaw)) {
        const r = resolver.resolve(rRaw);
        const content: Record<string, MediaSpec> = {};
        if (swagger2) {
          if (r.schema !== undefined) for (const t of produces) content[t] = { schema: r.schema };
        } else if (isObject(r.content)) {
          for (const [t, mRaw] of Object.entries(r.content)) {
            const media = resolver.resolve(mRaw);
            content[t] = media.schema === undefined ? {} : { schema: media.schema };
          }
        }
        const headers: ResponseSpec["headers"] = [];
        if (isObject(r.headers)) {
          for (const [hn, hRaw] of Object.entries(r.headers)) {
            const h = resolver.resolve(hRaw);
            headers.push({
              name: hn.toLowerCase(),
              required: h.required === true,
              schema: h.schema ?? (swagger2 ? { type: h.type } : undefined),
            });
          }
        }
        responses.push({
          status: status.toUpperCase(),
          description: typeof r.description === "string" ? r.description : "",
          content,
          headers,
        });
      }
      const sec = Array.isArray(op.security) ? op.security : globalSecurity;
      const secured = sec.length > 0 && !sec.some((s) => isObject(s) && Object.keys(s).length === 0);
      const paramList = [...params.values()];
      const idem = paramList.find((p) => p.in === "header" && /idempotency[-_]?key/i.test(p.name));
      const o: Operation = {
        key: `${method} ${path}`,
        method,
        path,
        summary: typeof op.summary === "string" ? op.summary : "",
        description: typeof op.description === "string" ? op.description : "",
        tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : [],
        params: paramList,
        responses,
        secured,
        mutating: MUTATING.has(method),
        pathRegex: pathToRegex(path),
      };
      if (typeof op.operationId === "string") o.operationId = op.operationId;
      if (body) o.body = body;
      if (idem) o.idempotencyHeader = idem.name;
      operations.push(o);
    }
  }
  const info = isObject(doc.info) ? doc.info : {};
  const c: Contract = {
    source: label,
    version,
    hash: sha256(JSON.stringify(doc)).slice(0, 16),
    document: doc,
    operations,
    resolver,
    validators: validatorCacheFor(doc, version === "3.1" ? "2020-12" : "draft-07"),
    securitySchemes: securitySchemes as Record<string, unknown>,
  };
  if (typeof info.title === "string") c.title = info.title;
  return c;
}

/** Finds the documented response for a status: exact, then "4XX" range, then "default". */
export function matchResponse(op: Operation, status: number): ResponseSpec | undefined {
  const s = String(status);
  return (
    op.responses.find((r) => r.status === s) ??
    op.responses.find((r) => r.status === `${s[0]}XX`) ??
    op.responses.find((r) => r.status === "DEFAULT")
  );
}

export function isDocumented(op: Operation, status: number): boolean {
  return matchResponse(op, status) !== undefined;
}

/** True when a media type from the response matches a documented one (wildcards, +json suffix). */
export function mediaTypeMatches(documented: string, actual: string): boolean {
  const d = documented.split(";")[0]?.trim().toLowerCase() ?? "";
  const a = actual.split(";")[0]?.trim().toLowerCase() ?? "";
  if (d === "*/*" || d === a) return true;
  const [dt, ds] = d.split("/");
  const [at, as] = a.split("/");
  if (dt === at && ds === "*") return true;
  if (ds === "json" && as?.endsWith("+json") && dt === at) return true;
  return false;
}

export function isJsonMedia(t: string): boolean {
  return /^application\/(.+\+)?json\b/i.test(t.trim()) || t.trim() === "*/*";
}

/** Matches an operation by "METHOD /path" pattern (`*` wildcard in path, METHOD may be `*`). */
export function matchesPattern(op: Operation, pattern: string): boolean {
  const [m, ...rest] = pattern.trim().split(/\s+/);
  const p = rest.join(" ");
  if (!m) return false;
  if (rest.length === 0) {
    // bare path or operationId
    if (op.operationId === m) return true;
    return globMatch(m, op.path);
  }
  if (m !== "*" && m.toUpperCase() !== op.method) return false;
  return globMatch(p, op.path);
}

function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(s);
}
