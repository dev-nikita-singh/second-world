/**
 * Pairwise factors for JSON request bodies (docs/04-data-structures-and-algorithms.md §7.3,
 * docs/03-engines/api-bug-hunter.md §2 "Combinatorial (pairwise)").
 *
 * The body schema is walked iteratively (bounded depth, first array item only) and every
 * writable property becomes a factor whose values are VALID equivalence/boundary classes:
 * enum members, true/false, numeric min/min+1/max-1/max, string length boundaries and formats,
 * null when nullable, plus "absent" for optional properties. An optional nested object is a
 * presence factor (present/absent). Every factor below it gets an extra first value INACTIVE, and
 * the IPOG constraint makes INACTIVE hold exactly when the parent is not PRESENT, so a pair is
 * only counted as covered when both values are really sent.
 * Deterministic: no RNG; values come from the schema and the dictionary only.
 */

import type { PartialRow } from "../algorithms/ipog.js";
import {
  allowsNull,
  escapePointerSegment,
  isObject,
  type JsonSchema,
  normalize,
  primaryType,
} from "../json-schema.js";
import { boundaryValues } from "./boundary.js";
import { type SampleContext, sampleValid } from "./sample.js";

/** Marker value: the property is omitted. */
export const ABSENT: unique symbol = Symbol("absent");
/** Marker value: the optional object is present (its children are set by their own factors). */
export const PRESENT: unique symbol = Symbol("present");
/** Marker value: an ancestor object is absent, so this factor is not sent. */
export const INACTIVE: unique symbol = Symbol("inactive");

export interface BodyFactor {
  /** Path segments into the body (numbers = array indices). */
  segs: (string | number)[];
  pointer: string;
  /** Candidate values (ABSENT / PRESENT markers included). */
  values: unknown[];
  /** Index (into the factor list) of the nearest optional ancestor object's presence factor. */
  parent?: number;
  kind: "leaf" | "presence";
}

export interface BodyFactorOptions {
  maxDepth?: number;
  maxFactors?: number;
  maxValues?: number;
}

export interface BodyFactorSet {
  factors: BodyFactor[];
  /** Fully populated valid body (all optional properties present) the rows are applied to. */
  base: unknown;
  /** pointer → template value used to materialise a missing container. */
  templates: Map<string, unknown>;
}

const pointerOf = (segs: readonly (string | number)[]): string =>
  segs.map((x) => `/${escapePointerSegment(String(x))}`).join("");

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && JSON.stringify(a) === JSON.stringify(b);
}

/** Valid classes of a scalar schema (boundary + equivalence representatives), deduplicated. */
export function scalarClasses(
  s: JsonSchema,
  ctx: SampleContext,
  name: string | undefined,
  max: number,
): unknown[] {
  const vals: unknown[] = [];
  const t = primaryType(s);
  if (Array.isArray(s.enum)) vals.push(...s.enum);
  else if (t === "boolean") vals.push(true, false);
  else if (t === "integer" || t === "number" || t === "string") {
    vals.push(sampleValid(s, ctx, name));
    for (const c of boundaryValues(s, ctx)) if (c.expectValid) vals.push(c.value);
  } else vals.push(sampleValid(s, ctx, name));
  if (allowsNull(s) && !vals.includes(null)) vals.push(null);
  const uniq: unknown[] = [];
  for (const v of vals) if (!uniq.some((u) => sameValue(u, v))) uniq.push(v);
  return uniq.slice(0, max);
}

/** Factors of a JSON body schema. Returns no factors for a non-object body. */
export function bodyFactors(
  schema: unknown,
  ctx: SampleContext,
  opts: BodyFactorOptions = {},
): BodyFactorSet {
  const maxDepth = opts.maxDepth ?? 3;
  const maxFactors = opts.maxFactors ?? 12;
  const maxValues = opts.maxValues ?? 4;
  const root = normalize(schema, ctx.resolver);
  const full: SampleContext = { ...ctx, full: true };
  const base = sampleValid(root, full);
  const templates = new Map<string, unknown>();
  const factors: BodyFactor[] = [];
  if (!isObject(base) || !(primaryType(root) === "object" || isObject(root.properties)))
    return { factors, base, templates };
  templates.set("", base);
  // Breadth-first (queue) so shallow properties get factors before the cap is hit.
  const queue: { schema: JsonSchema; segs: (string | number)[]; depth: number; parent?: number }[] = [
    { schema: root, segs: [], depth: 0 },
  ];
  let guard = 0;
  for (let qi = 0; qi < queue.length && guard++ < 500; qi++) {
    const { schema: s, segs, depth, parent } = queue[qi] as (typeof queue)[number];
    const props = isObject(s.properties) ? s.properties : {};
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [k, ps] of Object.entries(props)) {
      if (factors.length >= maxFactors) break;
      const child = normalize(ps, ctx.resolver);
      if (child.readOnly === true) continue;
      const childSegs = [...segs, k];
      const optional = !req.has(k);
      const ct = primaryType(child);
      const withParent = (f: BodyFactor): BodyFactor =>
        parent === undefined ? f : { ...f, parent, values: [INACTIVE, ...f.values] };
      const isObj = ct === "object" || (ct === undefined && isObject(child.properties));
      const items = ct === "array" ? normalize(child.items ?? {}, ctx.resolver) : undefined;
      const objItems = items !== undefined && (primaryType(items) === "object" || isObject(items.properties));
      if ((isObj || objItems) && depth + 1 < maxDepth) {
        // Container: presence factor when optional, then descend.
        let p = parent;
        templates.set(pointerOf(childSegs), sampleValid(child, full, k, 1));
        if (optional) {
          factors.push(
            withParent({
              segs: childSegs,
              pointer: pointerOf(childSegs),
              values: [PRESENT, ABSENT],
              kind: "presence",
            }),
          );
          p = factors.length - 1;
        }
        if (isObj)
          queue.push({
            schema: child,
            segs: childSegs,
            depth: depth + 1,
            ...(p === undefined ? {} : { parent: p }),
          });
        else {
          const itemSegs = [...childSegs, 0];
          templates.set(pointerOf(itemSegs), sampleValid(items, full, undefined, 2));
          queue.push({
            schema: items as JsonSchema,
            segs: itemSegs,
            depth: depth + 1,
            ...(p === undefined ? {} : { parent: p }),
          });
        }
        continue;
      }
      if (isObj || ct === "array") {
        // Too deep / scalar array: only its presence varies.
        if (optional)
          factors.push(
            withParent({
              segs: childSegs,
              pointer: pointerOf(childSegs),
              values: [sampleValid(child, full, k, 1), ABSENT],
              kind: "leaf",
            }),
          );
        continue;
      }
      const values = scalarClasses(child, ctx, k, maxValues);
      if (optional) values.push(ABSENT);
      if (values.length < 2) continue;
      factors.push(withParent({ segs: childSegs, pointer: pointerOf(childSegs), values, kind: "leaf" }));
    }
  }
  return { factors, base, templates };
}

/**
 * IPOG constraint over body factors located at `offset` in the full row: a factor below an
 * optional object is INACTIVE exactly when some ancestor object is not PRESENT. Complete for
 * partial rows (returns false only when no completion exists), so IPOG's vertical growth never
 * creates a row that cannot be filled.
 */
export function bodyConstraint(factors: readonly BodyFactor[], offset = 0): (row: PartialRow) => boolean {
  const n = factors.length;
  const ancestors: number[][] = factors.map((f) => {
    const out: number[] = [];
    let p = f.parent;
    while (p !== undefined && out.length < 64) {
      out.push(p);
      p = (factors[p] as BodyFactor).parent;
    }
    return out;
  });
  return (row) => {
    const val = (i: number): unknown => {
      const v = row[offset + i];
      return v === undefined ? undefined : (factors[i] as BodyFactor).values[v];
    };
    const forcedPresent = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = val(i);
      if (v === undefined || v === INACTIVE) continue;
      if (v === PRESENT) forcedPresent[i] = 1;
      for (const a of ancestors[i] as number[]) forcedPresent[a] = 1;
    }
    for (let i = 0; i < n; i++) {
      const v = val(i);
      if (forcedPresent[i] && v !== undefined && v !== PRESENT) return false;
      if (v === INACTIVE && (ancestors[i] as number[]).every((a) => forcedPresent[a] === 1)) return false;
    }
    return true;
  };
}

/** True when the factor is actually sent in this row (every ancestor object is present). */
export function factorActive(
  factors: readonly BodyFactor[],
  row: readonly number[],
  offset = 0,
  i = 0,
): boolean {
  let p = (factors[i] as BodyFactor).parent;
  let hops = 0;
  while (p !== undefined && hops++ < 64) {
    const pf = factors[p] as BodyFactor;
    if (pf.values[row[offset + p] as number] !== PRESENT) return false;
    p = pf.parent;
  }
  return true;
}

/** Builds the body for one covering-array row (value indices of the body factors). */
export function applyBodyRow(set: BodyFactorSet, row: readonly number[], offset = 0): unknown {
  const body = structuredClone(set.base) as Record<string, unknown>;
  const ensureParent = (segs: readonly (string | number)[]): Record<string | number, unknown> | undefined => {
    let cur: unknown = body;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string | number;
      const container = cur as Record<string | number, unknown>;
      let next = container[seg];
      if (next === null || typeof next !== "object") {
        const tpl = set.templates.get(pointerOf(segs.slice(0, i + 1)));
        next = tpl === undefined ? (typeof segs[i + 1] === "number" ? [] : {}) : structuredClone(tpl);
        if (Array.isArray(next) && typeof segs[i + 1] === "number" && next.length === 0) {
          const item = set.templates.get(pointerOf(segs.slice(0, i + 2)));
          next.push(item === undefined ? {} : structuredClone(item));
        }
        container[seg] = next;
      }
      cur = next;
    }
    return cur as Record<string | number, unknown>;
  };
  set.factors.forEach((f, i) => {
    if (!factorActive(set.factors, row, offset, i)) return;
    const v = f.values[row[offset + i] as number];
    if (v === INACTIVE) return;
    const parent = ensureParent(f.segs);
    if (!parent) return;
    const last = f.segs[f.segs.length - 1] as string | number;
    if (v === ABSENT) delete parent[last];
    else if (v === PRESENT) {
      const cur = parent[last];
      if (cur === null || typeof cur !== "object") {
        const tpl = set.templates.get(f.pointer);
        parent[last] = tpl === undefined ? {} : structuredClone(tpl);
      }
    } else parent[last] = structuredClone(v);
  });
  return body;
}

/** Short printable form of a factor value for case labels. */
export function showValue(v: unknown): string {
  if (v === ABSENT) return "-";
  if (v === PRESENT) return "{…}";
  if (v === INACTIVE) return "n/a";
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 16 ? `${s.slice(0, 13)}…` : s;
}
