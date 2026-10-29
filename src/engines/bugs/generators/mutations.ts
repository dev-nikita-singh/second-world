/**
 * Negative / robustness mutation operators (docs/03-engines/api-bug-hunter.md §2, §5).
 * Probes are SHAPE tests that check input is rejected cleanly: no real exploit payloads, bounded
 * sizes (oversized bodies stay within `maxBytes`, default 64 KiB).
 */
import { escapePointerSegment, isObject } from "../json-schema.js";

export type RawBody =
  | { kind: "json"; value: unknown }
  | { kind: "raw"; text: string; contentType: string }
  | { kind: "none" };

export interface Mutation {
  operator: string;
  /** JSON pointer of the mutated field ("" for whole-body mutations). */
  pointer: string;
  body: RawBody;
  /** Whether the result can still be schema-valid (decided by Ajv for json bodies). */
  structural: boolean;
}

/** Injection-SHAPED strings (inert): they check that input is validated/escaped, nothing more. */
export const INJECTION_SHAPES: readonly string[] = [
  "' OR '1'='1",
  "<script>sw()</script>",
  "../../sw/../etc",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: an inert template-injection SHAPE, intentionally a plain string
  "${sw}",
  "{{7*7}}",
  "sw\u0000nul",
  "‮sw-rtl",
  "%s%s%s%n",
];

function stringPointers(v: unknown, maxDepth = 4): { pointer: string; segs: (string | number)[] }[] {
  const out: { pointer: string; segs: (string | number)[] }[] = [];
  const stack: { v: unknown; segs: (string | number)[] }[] = [{ v, segs: [] }];
  while (stack.length > 0 && out.length < 32) {
    const { v: cur, segs } = stack.pop() as (typeof stack)[number];
    if (segs.length > maxDepth) continue;
    if (typeof cur === "string")
      out.push({ pointer: segs.map((s) => `/${escapePointerSegment(String(s))}`).join(""), segs });
    else if (Array.isArray(cur)) {
      if (cur.length > 0) stack.push({ v: cur[0], segs: [...segs, 0] });
    } else if (isObject(cur))
      for (const [k, x] of Object.entries(cur)) stack.push({ v: x, segs: [...segs, k] });
  }
  return out;
}

function setPath(base: unknown, segs: (string | number)[], v: unknown): unknown {
  const copy = structuredClone(base);
  let cur: unknown = copy;
  for (let i = 0; i < segs.length - 1; i++) cur = (cur as Record<string, unknown>)[segs[i] as string];
  (cur as Record<string, unknown>)[segs[segs.length - 1] as string] = v;
  return copy;
}

export function negativeMutations(
  valid: unknown,
  opts: { maxBytes?: number; mediaType?: string } = {},
): Mutation[] {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const json = JSON.stringify(valid) ?? "null";
  const out: Mutation[] = [
    {
      operator: "malformed-json",
      pointer: "",
      body: {
        kind: "raw",
        text: `${json.slice(0, Math.max(1, json.length - 1))},`,
        contentType: "application/json",
      },
      structural: true,
    },
    {
      operator: "truncated-json",
      pointer: "",
      body: { kind: "raw", text: '{"sw":', contentType: "application/json" },
      structural: true,
    },
    {
      operator: "wrong-content-type",
      pointer: "",
      body: { kind: "raw", text: json, contentType: "text/plain" },
      structural: true,
    },
    {
      operator: "empty-body",
      pointer: "",
      body: { kind: "raw", text: "", contentType: opts.mediaType ?? "application/json" },
      structural: true,
    },
    { operator: "json-null", pointer: "", body: { kind: "json", value: null }, structural: false },
    { operator: "json-array", pointer: "", body: { kind: "json", value: [valid] }, structural: false },
  ];
  if (isObject(valid)) {
    out.push({
      operator: "extra-field",
      pointer: "/__sw_extra",
      body: { kind: "json", value: { ...valid, __sw_extra: "sw" } },
      structural: false,
    });
  }
  const strings = stringPointers(valid);
  for (const sp of strings.slice(0, 4)) {
    const big = "A".repeat(Math.max(0, Math.min(maxBytes - json.length - 16, 16 * 1024)));
    out.push({
      operator: "oversized-string",
      pointer: sp.pointer,
      body: { kind: "json", value: setPath(valid, sp.segs, big) },
      structural: false,
    });
    for (const shape of INJECTION_SHAPES) {
      out.push({
        operator: "injection-shape",
        pointer: sp.pointer,
        body: { kind: "json", value: setPath(valid, sp.segs, shape) },
        structural: false,
      });
    }
  }
  return out;
}
