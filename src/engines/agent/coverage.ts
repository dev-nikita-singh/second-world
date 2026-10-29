/**
 * Coverage tracking and novelty. docs/03-engines/adversarial-test-agent.md §3,
 * docs/04-data-structures-and-algorithms.md §2.5 (bitset), §2.6 (Bloom filter).
 *
 * Coverage keys are interned to bit indices of a growable Bitset:
 *   `status|<op>|<code>`        operation × status code (documented ones form the denominator)
 *   `branch|<op>|<code>|<shape>` schema branch = top-level JSON shape of the response
 *   `param|<op>|<name>`         parameter / body property exercised
 *   `trans|<opA>|<opB>|<code>`  state transition opA → opB within one scenario
 * Coverage % = observed documented (operation, status) pairs / documented pairs.
 */
import { Bitset } from "../../shared/ds/bitset.js";
import { sha256 } from "../../shared/util/hash.js";

export type CoverageKind = "status" | "branch" | "param" | "trans";

export class CoverageTracker {
  private bits = new Bitset(256);
  private readonly index = new Map<string, number>();
  private readonly documented = new Set<number>();
  private readonly perKind: Record<CoverageKind, number> = { status: 0, branch: 0, param: 0, trans: 0 };

  private bit(key: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.index.size;
      this.index.set(key, i);
      if (i >= this.bits.length) {
        const next = new Bitset(this.bits.length * 2);
        for (const b of this.bits.toArray()) next.set(b);
        this.bits = next;
      }
    }
    return i;
  }

  /** Registers a documented (operation, status) pair (coverage denominator). */
  addDocumented(op: string, status: string | number): void {
    this.documented.add(this.bit(`status|${op}|${status}`));
  }

  /** Marks a key; returns true when the bit is new. */
  mark(kind: CoverageKind, ...parts: (string | number)[]): boolean {
    // Intern first: interning may grow (replace) `this.bits`.
    const i = this.bit(`${kind}|${parts.join("|")}`);
    const isNew = this.bits.testAndSet(i);
    if (isNew) this.perKind[kind]++;
    return isNew;
  }

  has(kind: CoverageKind, ...parts: (string | number)[]): boolean {
    const i = this.index.get(`${kind}|${parts.join("|")}`);
    return i !== undefined && this.bits.test(i);
  }

  get bitsSet(): number {
    return this.bits.count();
  }

  counts(): Record<CoverageKind, number> {
    return { ...this.perKind };
  }

  /** Documented (operation, status) pairs observed / documented. */
  documentedRatio(): { observed: number; total: number; ratio: number } {
    let observed = 0;
    for (const i of this.documented) if (this.bits.test(i)) observed++;
    const total = this.documented.size;
    return { observed, total, ratio: total === 0 ? 0 : observed / total };
  }

  /** Documented statuses of `op` not observed yet. */
  gaps(op: string, statuses: readonly string[]): string[] {
    return statuses.filter((s) => !this.has("status", op, s));
  }
}

/** Shape of a JSON response for branch coverage (type + sorted top-level keys). */
export function responseShape(json: unknown): string {
  if (json === undefined) return "none";
  if (json === null) return "null";
  if (Array.isArray(json))
    return `array:${json.length === 0 ? "empty" : responseShape(json[0]).slice(0, 12)}`;
  if (typeof json === "object") return `object:${sha256(Object.keys(json).sort().join(",")).slice(0, 8)}`;
  return typeof json;
}

/** Bloom filter (double hashing from one SHA-256). False positive ⇒ a scenario is skipped, never a wrong result. */
export class BloomFilter {
  private readonly words: Uint32Array;
  readonly m: number;
  constructor(
    m: number,
    readonly k: number,
  ) {
    this.m = Math.max(64, Math.ceil(m));
    this.words = new Uint32Array(Math.ceil(this.m / 32));
  }

  static forCapacity(n: number, fpRate = 0.001): BloomFilter {
    const m = Math.ceil((-n * Math.log(fpRate)) / Math.LN2 ** 2);
    const k = Math.max(1, Math.round((m / n) * Math.LN2));
    return new BloomFilter(m, k);
  }

  private positions(key: string): number[] {
    const h = sha256(key);
    const h1 = Number.parseInt(h.slice(0, 8), 16);
    const h2 = Number.parseInt(h.slice(8, 16), 16) | 1;
    const out: number[] = [];
    for (let i = 0; i < this.k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % this.m);
    return out;
  }

  add(key: string): void {
    for (const p of this.positions(key))
      this.words[p >>> 5] = ((this.words[p >>> 5] as number) | (1 << (p & 31))) >>> 0;
  }

  has(key: string): boolean {
    return this.positions(key).every((p) => (((this.words[p >>> 5] as number) >>> (p & 31)) & 1) === 1);
  }
}

/** Novelty set of scenario fingerprints: exact Set by default, Bloom filter for very long runs. */
export class NoveltySet {
  private readonly set = new Set<string>();
  private readonly bloom?: BloomFilter;
  constructor(mode: "set" | "bloom" = "set", capacity = 1_000_000) {
    if (mode === "bloom") this.bloom = BloomFilter.forCapacity(capacity);
  }

  /** Adds; returns false when (probably) seen before. */
  add(fp: string): boolean {
    if (this.bloom) {
      if (this.bloom.has(fp)) return false;
      this.bloom.add(fp);
      return true;
    }
    if (this.set.has(fp)) return false;
    this.set.add(fp);
    return true;
  }
}
