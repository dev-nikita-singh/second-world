/**
 * Value dictionary: user-configured values plus identifiers harvested from successful responses,
 * so generated requests reference resources that exist (e.g. `productId` from GET /products).
 * Bounded (max values per name).
 */
import { isObject } from "./json-schema.js";

const MAX_VALUES = 20;

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

export class Dictionary {
  private readonly values = new Map<string, unknown[]>();
  private readonly fixed = new Set<string>();

  constructor(configured: Record<string, readonly unknown[]> = {}) {
    for (const [k, v] of Object.entries(configured)) {
      this.values.set(k.toLowerCase(), [...v].slice(0, MAX_VALUES * 5));
      this.fixed.add(k.toLowerCase());
    }
  }

  add(name: string, v: unknown): void {
    if (v === null || v === undefined || (typeof v !== "string" && typeof v !== "number")) return;
    const k = name.toLowerCase();
    if (this.fixed.has(k)) return;
    const arr = this.values.get(k) ?? [];
    if (arr.includes(v)) return;
    arr.push(v);
    if (arr.length > MAX_VALUES) arr.shift();
    this.values.set(k, arr);
  }

  get(name: string): readonly unknown[] {
    return this.values.get(name.toLowerCase()) ?? [];
  }

  /** Candidate names for a parameter/property in the context of an operation path. */
  lookup(name: string, path?: string): readonly unknown[] {
    const direct = this.get(name);
    if (direct.length > 0) return direct;
    if (path && /^(id|uuid|key)$/i.test(name)) {
      // Path param `{id}` belongs to the segment before it: /products/{id} → productId
      const segs = path.split("/").filter((s) => s.length > 0);
      const idx = segs.indexOf(`{${name}}`);
      const owner = idx > 0 ? segs[idx - 1] : undefined;
      if (owner && !owner.startsWith("{")) return this.get(`${singular(owner)}Id`);
    }
    return [];
  }

  /** Harvests `id` fields of objects in a 2xx JSON response of `path` (top level, arrays, `items`/`data`). */
  harvest(path: string, body: unknown): void {
    const res = resourceOf(path);
    if (!res) return;
    const name = `${singular(res)}Id`;
    const visit = (o: unknown, depth: number): void => {
      if (depth > 2) return;
      if (Array.isArray(o)) {
        for (const x of o.slice(0, MAX_VALUES)) visit(x, depth + 1);
        return;
      }
      if (!isObject(o)) return;
      if (o.id !== undefined) this.add(name, o.id);
      for (const k of ["items", "data", "results", "content"])
        if (Array.isArray(o[k])) visit(o[k], depth + 1);
    };
    visit(body, 0);
  }

  snapshot(): Record<string, unknown[]> {
    return Object.fromEntries([...this.values.entries()].map(([k, v]) => [k, [...v]]));
  }
}
