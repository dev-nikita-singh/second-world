/**
 * JSON Schema → fast-check Arbitrary mapper (valid values, integrated shrinking).
 * docs/04-data-structures-and-algorithms.md §7.2.
 *
 * Supports type (incl. arrays of types), const, enum, numeric bounds (exclusive, multipleOf),
 * string lengths/format/pattern, arrays (min/max/uniqueItems), objects (properties, required,
 * additionalProperties false), allOf (merged), anyOf/oneOf, nullable. Recursive schemas are cut
 * at `maxDepth` (only required properties / minItems below it). An optional `isValid` filter
 * guarantees validity for keywords the mapper does not model (e.g. oneOf exclusivity, not).
 */
import fc from "fast-check";
import type { Dictionary } from "../dictionary.js";
import {
  isObject,
  type JsonSchema,
  normalize,
  type SchemaResolver,
  type SchemaType,
  schemaTypes,
} from "../json-schema.js";
import { FORMAT_SAMPLES, numericBounds } from "./sample.js";

export interface ArbitraryOptions {
  resolver: SchemaResolver;
  dict?: Dictionary;
  path?: string;
  maxDepth?: number;
  /** Max generated string length when maxLength is absent. Default 24. */
  maxStringLength?: number;
  /** Max generated array length when maxItems is absent. Default 4. */
  maxArrayLength?: number;
  /** Final validity filter (e.g. Ajv). */
  isValid?: (v: unknown) => boolean;
}

const DATE_MIN = new Date("1970-01-01T00:00:00.000Z");
const DATE_MAX = new Date("2099-12-31T23:59:59.000Z");

function stringArb(s: JsonSchema, o: ArbitraryOptions): fc.Arbitrary<string> {
  const fmt = typeof s.format === "string" ? s.format : undefined;
  switch (fmt) {
    case "uuid":
      return fc.uuid();
    case "email":
      return fc.emailAddress();
    case "date-time":
      return fc.date({ min: DATE_MIN, max: DATE_MAX, noInvalidDate: true }).map((d) => d.toISOString());
    case "date":
      return fc
        .date({ min: DATE_MIN, max: DATE_MAX, noInvalidDate: true })
        .map((d) => d.toISOString().slice(0, 10));
    case "ipv4":
      return fc.ipV4();
    case "uri":
    case "url":
      return fc.webUrl();
    default:
      break;
  }
  if (fmt !== undefined && FORMAT_SAMPLES[fmt] !== undefined && !["byte", "password"].includes(fmt)) {
    return fc.constant(FORMAT_SAMPLES[fmt] as string);
  }
  const minLength = typeof s.minLength === "number" ? s.minLength : 0;
  const maxLength = typeof s.maxLength === "number" ? s.maxLength : minLength + (o.maxStringLength ?? 24);
  if (typeof s.pattern === "string") {
    let re: RegExp | undefined;
    try {
      re = new RegExp(s.pattern);
    } catch {
      re = undefined;
    }
    if (re) {
      const r = re;
      return fc
        .stringMatching(r)
        .filter((x) => [...x].length >= minLength && [...x].length <= maxLength && r.test(x));
    }
  }
  return fc.string({ minLength, maxLength, unit: "grapheme-ascii" });
}

function numberArb(s: JsonSchema, integer: boolean): fc.Arbitrary<number> {
  const { lo, hi } = numericBounds(s, integer);
  const mult = typeof s.multipleOf === "number" && s.multipleOf > 0 ? s.multipleOf : undefined;
  if (integer) {
    const min = Number.isFinite(lo) ? lo : -1_000_000;
    const max = Number.isFinite(hi) ? hi : 1_000_000;
    if (mult !== undefined && Number.isInteger(mult)) {
      const kmin = Math.ceil(min / mult);
      const kmax = Math.floor(max / mult);
      return fc.integer({ min: kmin, max: Math.max(kmin, kmax) }).map((k) => k * mult);
    }
    return fc.integer({
      min: Math.max(min, Number.MIN_SAFE_INTEGER),
      max: Math.min(max, Number.MAX_SAFE_INTEGER),
    });
  }
  if (mult !== undefined) {
    const min = Number.isFinite(lo) ? lo : -1e6;
    const max = Number.isFinite(hi) ? hi : 1e6;
    return fc
      .integer({ min: Math.ceil(min / mult), max: Math.floor(max / mult) })
      .map((k) => Number((k * mult).toPrecision(12)));
  }
  const exMin = typeof s.exclusiveMinimum === "number" || s.exclusiveMinimum === true;
  const exMax = typeof s.exclusiveMaximum === "number" || s.exclusiveMaximum === true;
  const min =
    typeof s.exclusiveMinimum === "number"
      ? s.exclusiveMinimum
      : typeof s.minimum === "number"
        ? s.minimum
        : -1e9;
  const max =
    typeof s.exclusiveMaximum === "number"
      ? s.exclusiveMaximum
      : typeof s.maximum === "number"
        ? s.maximum
        : 1e9;
  return fc
    .double({ min, max, minExcluded: exMin, maxExcluded: exMax, noNaN: true, noDefaultInfinity: true })
    .map((x) => (Object.is(x, -0) ? 0 : x));
}

function typedArb(t: SchemaType, s: JsonSchema, o: ArbitraryOptions, depth: number): fc.Arbitrary<unknown> {
  const maxDepth = o.maxDepth ?? 5;
  switch (t) {
    case "null":
      return fc.constant(null);
    case "boolean":
      return fc.boolean();
    case "integer":
      return numberArb(s, true);
    case "number":
      return numberArb(s, false);
    case "string":
      return stringArb(s, o);
    case "array": {
      const minLength = typeof s.minItems === "number" ? s.minItems : 0;
      const cap = depth >= maxDepth ? minLength : minLength + (o.maxArrayLength ?? 4);
      const maxLength = typeof s.maxItems === "number" ? Math.min(s.maxItems, cap) : cap;
      const item = build(s.items ?? {}, o, depth + 1);
      if (s.uniqueItems === true)
        return fc.uniqueArray(item, { minLength, maxLength, selector: (v) => JSON.stringify(v) });
      return fc.array(item, { minLength, maxLength });
    }
    case "object": {
      const props = isObject(s.properties) ? s.properties : {};
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const model: Record<string, fc.Arbitrary<unknown>> = {};
      for (const [k, ps] of Object.entries(props)) {
        if (depth >= maxDepth && !required.has(k)) continue;
        const known = o.dict?.lookup(k) ?? [];
        model[k] = known.length > 0 ? fc.constantFrom(...known) : build(ps, o, depth + 1);
      }
      for (const k of required) if (!(k in model)) model[k] = fc.constant("swtest");
      const keys = Object.keys(model).filter((k) => required.has(k));
      return fc.record(model, { requiredKeys: keys }) as fc.Arbitrary<unknown>;
    }
    default:
      return fc.constant(null);
  }
}

function build(schema: unknown, o: ArbitraryOptions, depth: number): fc.Arbitrary<unknown> {
  const s = normalize(schema, o.resolver);
  if (s.const !== undefined) return fc.constant(s.const);
  if (Array.isArray(s.enum) && s.enum.length > 0) return fc.constantFrom(...s.enum);
  for (const k of ["oneOf", "anyOf"] as const) {
    const alts = s[k];
    if (Array.isArray(alts) && alts.length > 0) {
      const { [k]: _x, ...rest } = s;
      return fc.oneof(...alts.map((a) => build({ ...rest, ...normalize(a, o.resolver) }, o, depth + 1)));
    }
  }
  let types = schemaTypes(s);
  if (s.nullable === true && !types.includes("null")) types = [...types, "null"];
  if (types.length === 0) {
    if (depth >= (o.maxDepth ?? 5)) return fc.constant(null);
    return fc.oneof(
      fc.string({ maxLength: 8 }),
      fc.integer({ min: -100, max: 100 }),
      fc.boolean(),
      fc.constant(null),
    );
  }
  if (types.length === 1) return typedArb(types[0] as SchemaType, s, o, depth);
  return fc.oneof(...types.map((t) => typedArb(t, s, o, depth)));
}

/** Arbitrary producing values valid for `schema`. */
export function schemaToArbitrary(schema: unknown, o: ArbitraryOptions): fc.Arbitrary<unknown> {
  const arb = build(schema, o, 0);
  const valid = o.isValid;
  return valid ? arb.filter((v) => valid(v)) : arb;
}
