/**
 * Deterministic "representative valid value" for a JSON Schema (equivalence-class representative).
 * docs/04-data-structures-and-algorithms.md §7.1. Prefers dictionary values, then example/default/
 * const/enum, then keyword-derived values. Bounded depth (recursive schemas stop at maxDepth).
 */
import type { Dictionary } from "../dictionary.js";
import { isObject, type JsonSchema, normalize, primaryType, type SchemaResolver } from "../json-schema.js";

export interface SampleContext {
  resolver: SchemaResolver;
  dict?: Dictionary;
  /** Operation path, for `{id}`-style dictionary lookups. */
  path?: string;
  maxDepth?: number;
  /** Include optional properties too (default false: required + dictionary-known ones). */
  full?: boolean;
  /** Pick index into dictionary values (rotates representatives). */
  variant?: number;
}

export const FORMAT_SAMPLES: Record<string, string> = {
  email: "sw.test@example.com",
  uuid: "123e4567-e89b-42d3-a456-426614174000",
  "date-time": "2024-01-15T10:30:00Z",
  date: "2024-01-15",
  time: "10:30:00Z",
  uri: "https://example.com/sw",
  url: "https://example.com/sw",
  "uri-reference": "/sw",
  hostname: "example.com",
  ipv4: "192.0.2.10",
  ipv6: "2001:db8::10",
  byte: "c3c=",
  password: "sw-test-password",
};

/** Near-miss invalid values for formats (equivalence: invalid class). */
export const FORMAT_NEAR_MISS: Record<string, string> = {
  email: "sw.test@",
  uuid: "123e4567-e89b-42d3-a456-42661417400",
  "date-time": "2024-13-45T25:61:00Z",
  date: "2024-02-30x",
  time: "25:61:00",
  uri: "not a uri",
  url: "not a url",
  hostname: "-bad-.example..com",
  ipv4: "256.0.2.10",
  ipv6: "2001:db8:::zz",
};

export function numericBounds(s: JsonSchema, integer: boolean): { lo: number; hi: number } {
  let lo = -Infinity;
  let hi = Infinity;
  if (typeof s.minimum === "number") lo = s.minimum;
  if (typeof s.exclusiveMinimum === "number")
    lo = Math.max(lo, integer ? Math.floor(s.exclusiveMinimum) + 1 : s.exclusiveMinimum + 1e-6);
  if (s.exclusiveMinimum === true && typeof s.minimum === "number")
    lo = integer ? s.minimum + 1 : s.minimum + 1e-6;
  if (typeof s.maximum === "number") hi = s.maximum;
  if (typeof s.exclusiveMaximum === "number")
    hi = Math.min(hi, integer ? Math.ceil(s.exclusiveMaximum) - 1 : s.exclusiveMaximum - 1e-6);
  if (s.exclusiveMaximum === true && typeof s.maximum === "number")
    hi = integer ? s.maximum - 1 : s.maximum - 1e-6;
  if (integer) {
    lo = Number.isFinite(lo) ? Math.ceil(lo) : lo;
    hi = Number.isFinite(hi) ? Math.floor(hi) : hi;
  }
  return { lo, hi };
}

function sampleNumber(s: JsonSchema, integer: boolean): number {
  const { lo, hi } = numericBounds(s, integer);
  let v: number;
  if (Number.isFinite(lo)) v = lo;
  else if (Number.isFinite(hi)) v = Math.min(hi, 1);
  else v = 1;
  if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
    const m = s.multipleOf;
    v = Math.ceil(v / m) * m;
    if (v > hi) v = Math.floor(hi / m) * m;
  }
  return v;
}

export function sampleString(s: JsonSchema): string {
  const fmt = typeof s.format === "string" ? FORMAT_SAMPLES[s.format] : undefined;
  if (fmt !== undefined) return fmt;
  const min = typeof s.minLength === "number" ? s.minLength : 0;
  const max = typeof s.maxLength === "number" ? s.maxLength : Infinity;
  const base = "swtest";
  let v = base.length >= min ? base : base + "x".repeat(min - base.length);
  if (v.length > max) v = v.slice(0, Math.max(min, max));
  return v;
}

export function sampleValid(schema: unknown, ctx: SampleContext, name?: string, depth = 0): unknown {
  const s = normalize(schema, ctx.resolver);
  if (name !== undefined && ctx.dict) {
    const vals = ctx.dict.lookup(name, ctx.path);
    if (vals.length > 0) return vals[(ctx.variant ?? 0) % vals.length];
  }
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum.find((x) => x !== null) ?? s.enum[0];
  for (const k of ["oneOf", "anyOf"] as const) {
    const alts = s[k];
    if (Array.isArray(alts) && alts.length > 0) {
      const { [k]: _x, ...rest } = s;
      const first = normalize(alts[0], ctx.resolver);
      return sampleValid({ ...rest, ...first }, ctx, name, depth + 1);
    }
  }
  const t = primaryType(s);
  const maxDepth = ctx.maxDepth ?? 6;
  switch (t) {
    case "integer":
      return sampleNumber(s, true);
    case "number":
      return sampleNumber(s, false);
    case "boolean":
      return true;
    case "string":
      return sampleString(s);
    case "null":
      return null;
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 0;
      const max = typeof s.maxItems === "number" ? s.maxItems : Infinity;
      const n = depth >= maxDepth ? min : Math.min(Math.max(min, 1), max);
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(sampleValid(s.items ?? {}, ctx, undefined, depth + 1));
      if (s.uniqueItems === true && n > 1) {
        // Make primitives distinct where possible.
        return out.map((v, i) => (typeof v === "number" ? v + i : typeof v === "string" ? `${v}${i}` : v));
      }
      return out;
    }
    case "object":
    case undefined: {
      if (t === undefined && !isObject(s.properties)) return t === undefined ? "swtest" : {};
      const props = isObject(s.properties) ? s.properties : {};
      const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const out: Record<string, unknown> = {};
      for (const [k, ps] of Object.entries(props)) {
        const known = ctx.dict ? ctx.dict.lookup(k).length > 0 : false;
        if (!req.has(k) && !(ctx.full && depth < 2) && !known) continue;
        if (depth >= maxDepth && !req.has(k)) continue;
        const pv = normalize(ps, ctx.resolver);
        if (pv.readOnly === true && !req.has(k)) continue;
        out[k] = sampleValid(ps, ctx, k, depth + 1);
      }
      for (const k of req) if (!(k in out)) out[k] = "swtest";
      return out;
    }
    default:
      return null;
  }
}
