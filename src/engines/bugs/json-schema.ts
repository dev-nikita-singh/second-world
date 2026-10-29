/**
 * JSON Schema helpers shared by the generators: lazy `$ref` resolution against the bundled
 * contract (no circular object graphs), `allOf` merging, type inference.
 * docs/04-data-structures-and-algorithms.md §7.1–7.2.
 */

export type JsonSchema = Record<string, unknown>;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** RFC 6901 pointer lookup ("#/a/b" or "/a/b"); percent-decoding for URI fragments. */
export function getPointer(root: unknown, pointer: string): unknown {
  let p = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (p === "") return root;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep raw
  }
  let cur: unknown = root;
  for (const raw of p.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isObject(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

export function escapePointerSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

export interface SchemaResolver {
  /** Follows `$ref` chains (local refs only) and returns the target schema (or {} when unresolvable). */
  resolve(schema: unknown): JsonSchema;
}

export function createResolver(root: unknown): SchemaResolver {
  return {
    resolve(schema: unknown): JsonSchema {
      let cur: unknown = schema;
      for (let i = 0; i < 32; i++) {
        if (cur === true || cur === undefined) return {};
        if (cur === false) return { not: {} };
        if (!isObject(cur)) return {};
        const ref = cur.$ref;
        if (typeof ref !== "string" || !ref.startsWith("#")) return cur;
        const target = getPointer(root, ref);
        if (target === undefined) return {};
        // OpenAPI 3.1 allows siblings next to $ref: merge them over the target.
        const { $ref: _r, ...siblings } = cur;
        cur = Object.keys(siblings).length > 0 && isObject(target) ? { ...target, ...siblings } : target;
      }
      return {};
    },
  };
}

/** Shallow-merges an `allOf` list (properties, required, numeric bounds) into one schema. */
export function mergeAllOf(schema: JsonSchema, r: SchemaResolver): JsonSchema {
  const parts = schema.allOf;
  if (!Array.isArray(parts)) return schema;
  const { allOf: _a, ...rest } = schema;
  let out: JsonSchema = { ...rest };
  const queue: unknown[] = [...parts];
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const p = r.resolve(queue.shift());
    if (Array.isArray(p.allOf)) {
      const { allOf: inner, ...pr } = p;
      queue.push(...(inner as unknown[]));
      out = mergeTwo(out, pr);
    } else out = mergeTwo(out, p);
  }
  return out;
}

function mergeTwo(a: JsonSchema, b: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...a, ...b };
  if (isObject(a.properties) || isObject(b.properties)) {
    out.properties = {
      ...(isObject(a.properties) ? a.properties : {}),
      ...(isObject(b.properties) ? b.properties : {}),
    };
  }
  if (Array.isArray(a.required) || Array.isArray(b.required)) {
    out.required = [...new Set([...((a.required as string[]) ?? []), ...((b.required as string[]) ?? [])])];
  }
  if (a.type !== undefined && b.type === undefined) out.type = a.type;
  for (const k of ["minimum", "exclusiveMinimum", "minLength", "minItems"] as const) {
    if (typeof a[k] === "number" && typeof b[k] === "number")
      out[k] = Math.max(a[k] as number, b[k] as number);
  }
  for (const k of ["maximum", "exclusiveMaximum", "maxLength", "maxItems"] as const) {
    if (typeof a[k] === "number" && typeof b[k] === "number")
      out[k] = Math.min(a[k] as number, b[k] as number);
  }
  return out;
}

/** Resolve + merge allOf. */
export function normalize(schema: unknown, r: SchemaResolver): JsonSchema {
  const s = r.resolve(schema);
  return Array.isArray(s.allOf) ? mergeAllOf(s, r) : s;
}

export type SchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** Declared types (excluding "null"), or inferred from keywords. */
export function schemaTypes(s: JsonSchema): SchemaType[] {
  const t = s.type;
  if (typeof t === "string") return [t as SchemaType];
  if (Array.isArray(t)) return t.filter((x): x is SchemaType => typeof x === "string");
  if (s.const !== undefined) return [jsonType(s.const)];
  if (Array.isArray(s.enum) && s.enum.length > 0) return [...new Set(s.enum.map(jsonType))];
  if (isObject(s.properties) || Array.isArray(s.required)) return ["object"];
  if (s.items !== undefined || s.prefixItems !== undefined) return ["array"];
  if (typeof s.minimum === "number" || typeof s.maximum === "number") return ["number"];
  if (
    typeof s.minLength === "number" ||
    typeof s.maxLength === "number" ||
    typeof s.pattern === "string" ||
    typeof s.format === "string"
  ) {
    return ["string"];
  }
  return [];
}

export function primaryType(s: JsonSchema): SchemaType | undefined {
  return schemaTypes(s).find((t) => t !== "null");
}

export function allowsNull(s: JsonSchema): boolean {
  return (
    schemaTypes(s).includes("null") || s.nullable === true || (Array.isArray(s.enum) && s.enum.includes(null))
  );
}

export function jsonType(v: unknown): SchemaType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  return "object";
}

/** Infer a draft JSON Schema from an observed value (discovery mode). Bounded depth and samples. */
export function inferSchema(v: unknown, depth = 0): JsonSchema {
  if (depth > 8) return {};
  const t = jsonType(v);
  if (t === "object") {
    const o = v as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    for (const k of Object.keys(o).slice(0, 100)) properties[k] = inferSchema(o[k], depth + 1);
    return { type: "object", properties, required: Object.keys(properties) };
  }
  if (t === "array") {
    const a = v as unknown[];
    if (a.length === 0) return { type: "array" };
    let items = inferSchema(a[0], depth + 1);
    for (const x of a.slice(1, 20)) items = mergeInferred(items, inferSchema(x, depth + 1));
    return { type: "array", items };
  }
  return { type: t === "integer" ? "integer" : t };
}

/** Union of two inferred schemas (required = intersection, types widened). */
export function mergeInferred(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (a.type === "object" && b.type === "object") {
    const pa = (a.properties ?? {}) as Record<string, JsonSchema>;
    const pb = (b.properties ?? {}) as Record<string, JsonSchema>;
    const properties: Record<string, JsonSchema> = { ...pa };
    for (const [k, v] of Object.entries(pb))
      properties[k] = pa[k] ? mergeInferred(pa[k] as JsonSchema, v) : v;
    const ra = new Set((a.required as string[]) ?? []);
    const required = ((b.required as string[]) ?? []).filter((k) => ra.has(k));
    return { type: "object", properties, required };
  }
  if (a.type === "array" && b.type === "array") {
    if (!a.items) return b;
    if (!b.items) return a;
    return { type: "array", items: mergeInferred(a.items as JsonSchema, b.items as JsonSchema) };
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if ((a.type === "integer" && b.type === "number") || (a.type === "number" && b.type === "integer"))
    return { type: "number" };
  const types = new Set<string>();
  for (const s of [a, b]) {
    if (Array.isArray(s.type)) for (const t of s.type) types.add(String(t));
    else if (typeof s.type === "string") types.add(s.type);
  }
  return types.size > 0 ? { type: [...types].sort() } : {};
}
