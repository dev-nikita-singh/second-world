/**
 * Seeded PRNG: xoshiro128** seeded via splitmix32. See docs/04-data-structures-and-algorithms.md §9.3.
 * Independent streams: fork(name) derives seed ⊕ fnv1a(name) mixed through splitmix32,
 * so results don't depend on scheduling order. Math.random is never used.
 */
import type { Rng } from "./types.js";

/** FNV-1a 32-bit over UTF-16 code units. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 step generator. */
export function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

class Xoshiro128ss implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    // Accept any finite number; fold to uint32 deterministically.
    const s = Number.isFinite(seed) ? normaliseSeed(seed) : 0;
    this.seed = s;
    const sm = splitmix32(s);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1; // all-zero state is invalid
  }

  /** Raw 32-bit unsigned output. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.b, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.b << 9) >>> 0;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = rotl(this.d >>> 0, 11);
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    return result;
  }

  next(): number {
    // 53-bit resolution from two draws: uniform in [0, 1)
    const hi = this.nextU32() >>> 5; // 27 bits
    const lo = this.nextU32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) throw new RangeError("int(min, max) requires integers");
    if (max < min) throw new RangeError("int(min, max) requires min <= max");
    const span = max - min + 1;
    if (span <= 0x100000000) {
      // rejection sampling for an unbiased result
      const limit = Math.floor(0x100000000 / span) * span;
      let x = this.nextU32();
      while (x >= limit) x = this.nextU32();
      return min + (x % span);
    }
    return min + Math.floor(this.next() * span);
  }

  exponential(mean: number): number {
    if (!(mean > 0)) throw new RangeError("exponential(mean) requires mean > 0");
    // inverse CDF; 1 - u ∈ (0, 1] so log never sees 0
    return -Math.log(1 - this.next()) * mean;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick() on empty array");
    return items[this.int(0, items.length - 1)] as T;
  }

  fork(streamName: string): Rng {
    const mix = splitmix32((this.seed ^ fnv1a32(streamName)) >>> 0)();
    return new Xoshiro128ss(mix);
  }
}

function normaliseSeed(seed: number): number {
  if (Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) return seed >>> 0;
  // fold larger/negative/fractional numbers through their string form
  return fnv1a32(String(seed));
}

/** Creates a deterministic RNG. Same seed → same sequence on every platform. */
export function createRng(seed: number): Rng & { nextU32(): number } {
  return new Xoshiro128ss(seed);
}
