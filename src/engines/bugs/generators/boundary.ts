/**
 * Boundary-value analysis and equivalence partitioning from JSON Schema keywords.
 * docs/04-data-structures-and-algorithms.md §7.1:
 *   minimum/maximum/exclusive* → {min−1, min, min+1, max−1, max, max+1}  (integer 1..100 → 0,1,2,99,100,101)
 *   minLength/maxLength, minItems/maxItems likewise; enum → each value + one invalid; type → one
 *   value of every wrong type; required → omit each; format → valid + near-miss; nullable → null.
 * Labels say which class a value was derived from; final validity is decided by Ajv by the caller.
 */
import {
  allowsNull,
  escapePointerSegment,
  isObject,
  type JsonSchema,
  normalize,
  primaryType,
  type SchemaType,
} from "../json-schema.js";
import {
  FORMAT_NEAR_MISS,
  FORMAT_SAMPLES,
  numericBounds,
  type SampleContext,
  sampleValid,
} from "./sample.js";

export interface ValueCase {
  value: unknown;
  /** Human label, e.g. "minimum-1". */
  label: string;
  /** Schema keyword the case targets. */
  keyword: string;
  /** Validity expected by construction (the engine re-checks with Ajv). */
  expectValid: boolean;
}

const LONG = 1024;

function pushNum(out: ValueCase[], v: number, label: string, keyword: string, lo: number, hi: number): void {
  if (!Number.isFinite(v)) return;
  out.push({ value: v, label, keyword, expectValid: v >= lo && v <= hi });
}

/** Boundary values for a scalar/array schema (no object recursion). */
export function boundaryValues(schema: unknown, ctx: SampleContext): ValueCase[] {
  const s = normalize(schema, ctx.resolver);
  const t = primaryType(s);
  const out: ValueCase[] = [];
  if (t === "integer" || t === "number") {
    const integer = t === "integer";
    const { lo, hi } = numericBounds(s, integer);
    const step = 1;
    if (Number.isFinite(lo)) {
      const kw =
        typeof s.exclusiveMinimum === "number" || s.exclusiveMinimum === true
          ? "exclusiveMinimum"
          : "minimum";
      pushNum(out, lo - step, "min-1", kw, lo, hi);
      pushNum(out, lo, "min", kw, lo, hi);
      pushNum(out, lo + step, "min+1", kw, lo, hi);
    }
    if (Number.isFinite(hi)) {
      const kw =
        typeof s.exclusiveMaximum === "number" || s.exclusiveMaximum === true
          ? "exclusiveMaximum"
          : "maximum";
      pushNum(out, hi - step, "max-1", kw, lo, hi);
      pushNum(out, hi, "max", kw, lo, hi);
      pushNum(out, hi + step, "max+1", kw, lo, hi);
    }
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) {
      out.push({ value: 0, label: "zero", keyword: "type", expectValid: true });
      out.push({ value: -1, label: "negative", keyword: "type", expectValid: true });
    }
    if (integer) out.push({ value: 1.5, label: "fraction", keyword: "type", expectValid: false });
  } else if (t === "string") {
    const min = typeof s.minLength === "number" ? s.minLength : 0;
    const max = typeof s.maxLength === "number" ? s.maxLength : Infinity;
    const str = (n: number): string => "a".repeat(Math.max(0, n));
    if (typeof s.format === "string" && FORMAT_SAMPLES[s.format] !== undefined) {
      out.push({ value: FORMAT_SAMPLES[s.format], label: "format", keyword: "format", expectValid: true });
      const miss = FORMAT_NEAR_MISS[s.format];
      if (miss !== undefined)
        out.push({ value: miss, label: "format-near-miss", keyword: "format", expectValid: false });
    } else if (typeof s.pattern !== "string") {
      if (min > 0) {
        out.push({ value: str(min - 1), label: "minLength-1", keyword: "minLength", expectValid: false });
        out.push({ value: str(min), label: "minLength", keyword: "minLength", expectValid: true });
        out.push({
          value: str(min + 1),
          label: "minLength+1",
          keyword: "minLength",
          expectValid: min + 1 <= max,
        });
      } else out.push({ value: "", label: "empty", keyword: "minLength", expectValid: true });
      if (Number.isFinite(max)) {
        if (max - 1 > min + 1)
          out.push({ value: str(max - 1), label: "maxLength-1", keyword: "maxLength", expectValid: true });
        if (max > min + 1)
          out.push({ value: str(max), label: "maxLength", keyword: "maxLength", expectValid: true });
        out.push({ value: str(max + 1), label: "maxLength+1", keyword: "maxLength", expectValid: false });
      } else out.push({ value: str(LONG), label: "long", keyword: "maxLength", expectValid: true });
      if (max >= 4 && min <= 4)
        out.push({ value: "é😀ü✓", label: "unicode", keyword: "type", expectValid: true });
    }
  } else if (t === "array") {
    const min = typeof s.minItems === "number" ? s.minItems : 0;
    const max = typeof s.maxItems === "number" ? s.maxItems : Infinity;
    const item = sampleValid(s.items ?? {}, ctx, undefined, 1);
    const arr = (n: number): unknown[] => Array.from({ length: Math.max(0, n) }, () => structuredClone(item));
    out.push({ value: [], label: "empty", keyword: "minItems", expectValid: min === 0 });
    if (min > 0) {
      if (min - 1 > 0)
        out.push({ value: arr(min - 1), label: "minItems-1", keyword: "minItems", expectValid: false });
      out.push({ value: arr(min), label: "minItems", keyword: "minItems", expectValid: true });
      out.push({
        value: arr(min + 1),
        label: "minItems+1",
        keyword: "minItems",
        expectValid: min + 1 <= max,
      });
    }
    if (Number.isFinite(max) && max <= 1000) {
      out.push({ value: arr(max), label: "maxItems", keyword: "maxItems", expectValid: true });
      out.push({ value: arr(max + 1), label: "maxItems+1", keyword: "maxItems", expectValid: false });
    }
  }
  return out;
}

const WRONG_TYPE_VALUES: Record<SchemaType, unknown> = {
  string: "sw-not-a-number",
  integer: 7,
  number: 7.5,
  boolean: true,
  array: ["sw"],
  object: { sw: 1 },
  null: null,
};

/** Equivalence classes: valid representative, every wrong type, enum members + invalid, null. */
export function equivalenceValues(schema: unknown, ctx: SampleContext, name?: string): ValueCase[] {
  const s = normalize(schema, ctx.resolver);
  const out: ValueCase[] = [
    { value: sampleValid(s, ctx, name), label: "valid", keyword: "type", expectValid: true },
  ];
  const t = primaryType(s);
  if (Array.isArray(s.enum)) {
    for (const v of s.enum.slice(0, 20))
      out.push({ value: v, label: `enum:${String(v)}`, keyword: "enum", expectValid: true });
    out.push({
      value: typeof s.enum[0] === "number" ? -987654 : "sw-not-in-enum",
      label: "enum-invalid",
      keyword: "enum",
      expectValid: false,
    });
  }
  if (t) {
    for (const wt of ["string", "integer", "boolean", "array", "object"] as SchemaType[]) {
      if (wt === t || (t === "number" && wt === "integer")) continue;
      out.push({
        value: WRONG_TYPE_VALUES[wt],
        label: `wrong-type:${wt}`,
        keyword: "type",
        expectValid: false,
      });
    }
  }
  out.push({ value: null, label: "null", keyword: "type", expectValid: allowsNull(s) });
  return out;
}

export interface ObjectVariant {
  /** JSON pointer of the varied property ("" = root). */
  pointer: string;
  value: unknown;
  label: string;
  keyword: string;
  expectValid: boolean;
}

/**
 * Applies per-property cases to a valid base object (depth ≤ maxDepth, first array item only),
 * plus omission of each required property. Produces whole-body variants.
 */
export function objectVariants(
  schema: unknown,
  base: unknown,
  ctx: SampleContext,
  mode: "boundary" | "equivalence",
  maxDepth = 3,
): ObjectVariant[] {
  const out: ObjectVariant[] = [];
  const root = normalize(schema, ctx.resolver);
  if (primaryType(root) !== "object" && !isObject(root.properties)) {
    const cases = mode === "boundary" ? boundaryValues(root, ctx) : equivalenceValues(root, ctx);
    for (const c of cases) out.push({ pointer: "", ...c });
    return out;
  }
  // Iterative walk: (schema, pointer segments into base)
  const stack: { schema: JsonSchema; segs: (string | number)[]; depth: number }[] = [
    { schema: root, segs: [], depth: 0 },
  ];
  const setAt = (segs: (string | number)[], v: unknown, del = false): unknown => {
    const copy = structuredClone(base);
    if (segs.length === 0) return v;
    let cur: unknown = copy;
    for (let i = 0; i < segs.length - 1; i++) {
      cur = (cur as Record<string | number, unknown>)[segs[i] as string];
      if (cur === null || typeof cur !== "object") return undefined;
    }
    const last = segs[segs.length - 1] as string;
    if (del) delete (cur as Record<string, unknown>)[last];
    else (cur as Record<string, unknown>)[last] = v;
    return copy;
  };
  const ptr = (segs: (string | number)[]): string =>
    segs.map((x) => `/${escapePointerSegment(String(x))}`).join("");
  let guard = 0;
  while (stack.length > 0 && guard++ < 500) {
    const { schema: s, segs, depth } = stack.pop() as (typeof stack)[number];
    const props = isObject(s.properties) ? s.properties : {};
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [k, ps] of Object.entries(props)) {
      const childSegs = [...segs, k];
      const child = normalize(ps, ctx.resolver);
      if (child.readOnly === true) continue;
      const ct = primaryType(child);
      if (ct === "object" || (ct === undefined && isObject(child.properties))) {
        if (depth + 1 < maxDepth) stack.push({ schema: child, segs: childSegs, depth: depth + 1 });
      } else if (ct === "array") {
        const items = normalize(child.items ?? {}, ctx.resolver);
        if ((primaryType(items) === "object" || isObject(items.properties)) && depth + 1 < maxDepth) {
          stack.push({ schema: items, segs: [...childSegs, 0], depth: depth + 1 });
        }
      }
      if (ct !== "object") {
        const cases = mode === "boundary" ? boundaryValues(child, ctx) : equivalenceValues(child, ctx, k);
        for (const c of cases) {
          const v = setAt(childSegs, c.value);
          if (v !== undefined)
            out.push({
              pointer: ptr(childSegs),
              value: v,
              label: c.label,
              keyword: c.keyword,
              expectValid: c.expectValid,
            });
        }
      }
      if (mode === "equivalence" && req.has(k)) {
        const v = setAt(childSegs, undefined, true);
        if (v !== undefined)
          out.push({
            pointer: ptr(childSegs),
            value: v,
            label: "missing-required",
            keyword: "required",
            expectValid: false,
          });
      }
    }
  }
  return out;
}
