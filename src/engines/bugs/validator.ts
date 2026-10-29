/**
 * Ajv validators compiled once per schema (LRU keyed by schema hash) and response conformance.
 * docs/03-engines/api-bug-hunter.md §2 (contract conformance), §4 (dedup by JSON pointer + keyword).
 *
 * The whole bundled contract is registered as schema `sw://contract`; operation schemas keep
 * their `$ref`s, rewritten to absolute `sw://contract#/...` so circular refs work natively.
 * OpenAPI 3.1 → JSON Schema 2020-12 (Ajv2020); 3.0 / Swagger 2 → draft-07 after normalising
 * `nullable` and boolean `exclusiveMinimum/Maximum`.
 */
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsNs from "ajv-formats";
import { LRUCache } from "../../shared/ds/lru.js";
import { sha256 } from "../../shared/util/hash.js";
import { isObject } from "./json-schema.js";

type AjvLike = Ajv | Ajv2020;

const CONTRACT_ID = "sw://contract";

type FormatsPlugin = (ajv: AjvLike) => unknown;
function formatsPlugin(): FormatsPlugin {
  const ns = formatsNs as unknown as { default?: unknown };
  let f: unknown = ns.default ?? ns;
  if (typeof f !== "function" && isObject(f) && typeof f.default === "function") f = f.default;
  return f as FormatsPlugin;
}

export interface SchemaViolation {
  /** Instance JSON pointer, array indices normalised to `*` (e.g. `/items/*\/price`). */
  pointer: string;
  /** Raw instance pointer (first occurrence). */
  instancePath: string;
  keyword: string;
  message: string;
  schemaPath: string;
}

export function normalizePointer(p: string): string {
  return p.replace(/\/\d+(?=\/|$)/g, "/*");
}

export interface ValidatorCacheOptions {
  /** OpenAPI version of the contract ("3.1" selects JSON Schema 2020-12). */
  dialect?: "2020-12" | "draft-07";
  /** Bundled contract document registered as `sw://contract` (refs resolve into it). */
  document?: unknown;
  maxValidators?: number;
}

/** Walks a schema tree (no cycles: bundled form) and rewrites local refs to `sw://contract#...`. */
function absolutiseRefs(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(absolutiseRefs);
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$ref" && typeof v === "string" && v.startsWith("#")) out[k] = `${CONTRACT_ID}${v}`;
    else out[k] = absolutiseRefs(v);
  }
  return out;
}

/** Converts OpenAPI 3.0 / Swagger 2 schema dialect quirks to draft-07 (deep copy). */
export function normalizeOas30(schema: unknown, depth = 0): unknown {
  if (depth > 200) return schema;
  if (Array.isArray(schema)) return schema.map((s) => normalizeOas30(s, depth + 1));
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = normalizeOas30(v, depth + 1);
  if (out.exclusiveMinimum === true && typeof out.minimum === "number") {
    out.exclusiveMinimum = out.minimum;
    delete out.minimum;
  } else if (typeof out.exclusiveMinimum === "boolean") delete out.exclusiveMinimum;
  if (out.exclusiveMaximum === true && typeof out.maximum === "number") {
    out.exclusiveMaximum = out.maximum;
    delete out.maximum;
  } else if (typeof out.exclusiveMaximum === "boolean") delete out.exclusiveMaximum;
  if (out.nullable === true) {
    delete out.nullable;
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (Array.isArray(out.type) && !out.type.includes("null")) out.type = [...out.type, "null"];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  } else if (out.nullable === false) delete out.nullable;
  if (out["x-nullable"] === true && typeof out.type === "string") out.type = [out.type, "null"];
  return out;
}

export class ValidatorCache {
  private readonly ajv: AjvLike;
  private readonly cache: LRUCache<string, ValidateFunction>;
  readonly dialect: "2020-12" | "draft-07";
  compiled = 0;
  hits = 0;

  constructor(opts: ValidatorCacheOptions = {}) {
    this.dialect = opts.dialect ?? "2020-12";
    const ajvOpts = {
      strict: false,
      allErrors: true,
      validateSchema: false,
      logger: false as const,
      allowUnionTypes: true,
      unicodeRegExp: false,
    };
    this.ajv = this.dialect === "2020-12" ? new Ajv2020(ajvOpts) : new Ajv(ajvOpts);
    formatsPlugin()(this.ajv);
    for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) {
      this.ajv.addFormat(f, true);
    }
    if (opts.document !== undefined) {
      const doc = this.dialect === "draft-07" ? normalizeOas30(opts.document) : opts.document;
      this.ajv.addSchema({ ...(doc as Record<string, unknown>), $id: CONTRACT_ID }, CONTRACT_ID);
    }
    this.cache = new LRUCache<string, ValidateFunction>(opts.maxValidators ?? 512);
  }

  /** Returns a compiled validator for `schema` (cached by content hash). Throws on invalid schema. */
  get(schema: unknown): ValidateFunction {
    const key = sha256(JSON.stringify(schema) ?? "undefined");
    const hit = this.cache.get(key);
    if (hit) {
      this.hits++;
      return hit;
    }
    let s = absolutiseRefs(schema);
    if (this.dialect === "draft-07") s = normalizeOas30(s);
    const fn = this.ajv.compile(typeof s === "boolean" ? s : (s as Record<string, unknown>));
    this.compiled++;
    this.cache.set(key, fn);
    return fn;
  }

  /** Validates `value`; returns violations (empty = valid). Unknown/uncompilable schema → valid. */
  validate(schema: unknown, value: unknown): SchemaViolation[] {
    if (schema === undefined) return [];
    let fn: ValidateFunction;
    try {
      fn = this.get(schema);
    } catch {
      return [];
    }
    if (fn(value)) return [];
    const out: SchemaViolation[] = [];
    const seen = new Set<string>();
    for (const e of fn.errors ?? []) {
      // Composite keywords report their children too; keep leaf-ish errors only once per pointer+keyword.
      const pointer = normalizePointer(e.instancePath);
      const k = `${pointer}|${e.keyword}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        pointer,
        instancePath: e.instancePath,
        keyword: e.keyword,
        message: `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`,
        schemaPath: e.schemaPath,
      });
    }
    return out;
  }

  isValid(schema: unknown, value: unknown): boolean {
    return this.validate(schema, value).length === 0;
  }
}

const instances = new LRUCache<string, ValidatorCache>(8);

/** Shared ValidatorCache per contract document hash (replays reuse compiled validators). */
export function validatorCacheFor(document: unknown, dialect: "2020-12" | "draft-07"): ValidatorCache {
  const key = `${dialect}|${sha256(JSON.stringify(document) ?? "")}`;
  let v = instances.get(key);
  if (!v) {
    v = new ValidatorCache({ document, dialect });
    instances.set(key, v);
  }
  return v;
}
