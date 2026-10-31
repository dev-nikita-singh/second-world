/**
 * Value dictionary: user-configured values plus identifiers harvested from successful responses,
 * so generated requests reference resources that exist (e.g. `productId` from GET /products).
 * Values for the path parameters the contract uses (`slug`, `username`, `articleId`, ...) are
 * harvested too, from wrapped single objects (`{ article: { slug } }`) and wrapped arrays
 * (`{ articles: [...] }`); those fill path parameters of that name only (a harvested `username`
 * must not land in a registration body → 409). Configured values fill parameters and body
 * properties of that name. Bounded (max values per name, max nodes visited per response).
 * docs/03-engines/api-bug-hunter.md (values).
 */
import { isObject } from "./json-schema.js";

const MAX_VALUES = 20;
/** JSON nodes visited per harvested response. */
const MAX_NODES = 500;
/** Generic item-id parameter names: mapped to `<resource>Id` instead of harvested by name. */
const GENERIC_ID = /^(id|uuid|key)$/i;
/** Wrapper keys whose content is treated as the response's own resources. */
const WRAPPERS = new Set(["items", "data", "results", "content"]);

export function singular(word: string): string {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us)$/i.test(word)) return word;
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** "/products/{id}" → "products"; "/users/{u}/orders" → "orders". */
export function resourceOf(path: string): string | undefined {
  const segs = path.split("/").filter((s) => s.length > 0 && !s.startsWith("{"));
  return segs[segs.length - 1];
}

const PATH_PARAMS = new WeakMap<object, string[]>();

/** Path-parameter names used by a contract's operations (cached per contract). */
export function pathParamNames(contract: {
  operations: readonly { params: readonly { in: string; name: string }[] }[];
}): string[] {
  let names = PATH_PARAMS.get(contract);
  if (!names) {
    const set = new Set<string>();
    for (const op of contract.operations) for (const p of op.params) if (p.in === "path") set.add(p.name);
    names = [...set];
    PATH_PARAMS.set(contract, names);
  }
  return names;
}

export class Dictionary {
  private readonly values = new Map<string, unknown[]>();
  /** Harvested values of contract path-parameter names; used for `{name}` path params only. */
  private readonly pathValues = new Map<string, unknown[]>();
  private readonly fixed = new Set<string>();

  constructor(configured: Record<string, readonly unknown[]> = {}) {
    for (const [k, v] of Object.entries(configured)) {
      this.values.set(k.toLowerCase(), [...v].slice(0, MAX_VALUES * 5));
      this.fixed.add(k.toLowerCase());
    }
  }

  add(name: string, v: unknown): void {
    this.put(this.values, name, v);
  }

  private put(map: Map<string, unknown[]>, name: string, v: unknown): void {
    if (v === null || v === undefined || (typeof v !== "string" && typeof v !== "number")) return;
    if (typeof v === "string" && (v.length === 0 || v.length > 200)) return;
    const k = name.toLowerCase();
    if (this.fixed.has(k)) return;
    const arr = map.get(k) ?? [];
    if (arr.includes(v)) return;
    arr.push(v);
    if (arr.length > MAX_VALUES) arr.shift();
    map.set(k, arr);
  }

  get(name: string): readonly unknown[] {
    return this.values.get(name.toLowerCase()) ?? [];
  }

  /** Candidate names for a parameter/property in the context of an operation path. */
  lookup(name: string, path?: string): readonly unknown[] {
    const direct = this.get(name);
    if (direct.length > 0) return direct;
    if (path?.includes(`{${name}}`)) {
      const harvested = this.pathValues.get(name.toLowerCase());
      if (harvested && harvested.length > 0) return harvested;
    }
    if (path && GENERIC_ID.test(name)) {
      // Path param `{id}` belongs to the segment before it: /products/{id} → productId
      const segs = path.split("/").filter((s) => s.length > 0);
      const idx = segs.indexOf(`{${name}}`);
      const owner = idx > 0 ? segs[idx - 1] : undefined;
      if (owner && !owner.startsWith("{")) return this.get(`${singular(owner)}Id`);
    }
    return [];
  }

  /**
   * Harvests a 2xx JSON response of `path`: `id` fields of the response's own resources (top
   * level, arrays, `items`/`data`/`results`/`content`, or a key named after the resource such as
   * `article`/`articles`) → `<resource>Id`; and any field named like one of `pathParams` (the
   * contract's path-parameter names, generic `id`/`uuid`/`key` excluded) at depth ≤ 3 → that name.
   * Iterative, at most MAX_NODES nodes and MAX_VALUES array items per array.
   */
  harvest(path: string, body: unknown, pathParams: readonly string[] = []): void {
    const res = resourceOf(path);
    const resName = res ? singular(res).toLowerCase() : undefined;
    const idName = res ? `${singular(res)}Id` : undefined;
    const named = new Set(pathParams.filter((p) => !GENERIC_ID.test(p)));
    // [node, depth, is one of the response's own resources]
    const stack: [unknown, number, boolean][] = [[body, 0, true]];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_NODES) {
      const [o, depth, own] = stack.pop() as [unknown, number, boolean];
      visited++;
      if (depth > 3) continue;
      if (Array.isArray(o)) {
        for (const x of o.slice(0, MAX_VALUES).reverse()) stack.push([x, depth + 1, own]);
        continue;
      }
      if (!isObject(o)) continue;
      if (own && idName && o.id !== undefined) this.add(idName, o.id);
      for (const n of named) if (n in o) this.put(this.pathValues, n, o[n]);
      for (const [k, v] of Object.entries(o).reverse()) {
        if (v === null || typeof v !== "object") continue;
        const wraps =
          own && (WRAPPERS.has(k) || (resName !== undefined && singular(k).toLowerCase() === resName));
        if (wraps || named.size > 0) stack.push([v, depth + 1, wraps]);
      }
    }
  }

  snapshot(): Record<string, unknown[]> {
    const out = Object.fromEntries([...this.values.entries()].map(([k, v]) => [k, [...v]]));
    for (const [k, v] of this.pathValues) if (!(k in out)) out[k] = [...v];
    return out;
  }
}
