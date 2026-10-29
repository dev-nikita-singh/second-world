/**
 * Area selection = multi-armed bandit. docs/04-data-structures-and-algorithms.md §8.1.
 *
 * Arms are "operation × technique" keys. UCB1 (default): untried arms first (in the order
 * given), then argmax(mean + c·√(2 ln t / n)). Thompson: Beta(1+s, 1+f) sample per arm with
 * a seeded Rng (Marsaglia–Tsang gamma), argmax. Reward ∈ [0, 1] (1 = new finding or new
 * coverage). O(arms) per decision; ties resolved by order → deterministic.
 */
import type { Rng } from "../../core/types.js";

export interface ArmStats {
  pulls: number;
  reward: number;
  mean: number;
}

export interface Bandit {
  readonly kind: "ucb1" | "thompson";
  /** Picks one of `arms` (non-empty). */
  select(arms: readonly string[]): string;
  update(arm: string, reward: number): void;
  stats(): Record<string, ArmStats>;
}

abstract class BaseBandit {
  protected readonly n = new Map<string, number>();
  protected readonly r = new Map<string, number>();
  protected t = 0;

  update(arm: string, reward: number): void {
    const x = Math.max(0, Math.min(1, Number.isFinite(reward) ? reward : 0));
    this.n.set(arm, (this.n.get(arm) ?? 0) + 1);
    this.r.set(arm, (this.r.get(arm) ?? 0) + x);
    this.t++;
  }

  stats(): Record<string, ArmStats> {
    const out: Record<string, ArmStats> = {};
    for (const [a, n] of this.n) {
      const reward = this.r.get(a) ?? 0;
      out[a] = { pulls: n, reward, mean: n === 0 ? 0 : reward / n };
    }
    return out;
  }
}

export class Ucb1Bandit extends BaseBandit implements Bandit {
  readonly kind = "ucb1" as const;
  constructor(private readonly c = 1) {
    super();
  }

  select(arms: readonly string[]): string {
    if (arms.length === 0) throw new RangeError("no arms to select from");
    for (const a of arms) if ((this.n.get(a) ?? 0) === 0) return a;
    let best = arms[0] as string;
    let bestV = Number.NEGATIVE_INFINITY;
    const lnT = Math.log(Math.max(1, this.t));
    for (const a of arms) {
      const n = this.n.get(a) ?? 1;
      const v = (this.r.get(a) ?? 0) / n + this.c * Math.sqrt((2 * lnT) / n);
      if (v > bestV) {
        bestV = v;
        best = a;
      }
    }
    return best;
  }
}

/** Standard normal via Box–Muller from the seeded rng. */
function normal(rng: Rng): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(k, 1) — Marsaglia & Tsang (k ≥ 1; boost for k < 1). */
export function sampleGamma(k: number, rng: Rng): number {
  if (k < 1) {
    let u = 0;
    while (u <= Number.EPSILON) u = rng.next();
    return sampleGamma(k + 1, rng) * u ** (1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    const x = normal(rng);
    const v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 * v0 * v0;
    const u = rng.next();
    if (
      u < 1 - 0.0331 * x ** 4 ||
      Math.log(Math.max(u, Number.MIN_VALUE)) < 0.5 * x * x + d * (1 - v + Math.log(v))
    )
      return d * v;
  }
  return d;
}

export function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x + y === 0 ? 0.5 : x / (x + y);
}

export class ThompsonBandit extends BaseBandit implements Bandit {
  readonly kind = "thompson" as const;
  constructor(private readonly rng: Rng) {
    super();
  }

  select(arms: readonly string[]): string {
    if (arms.length === 0) throw new RangeError("no arms to select from");
    let best = arms[0] as string;
    let bestV = Number.NEGATIVE_INFINITY;
    for (const a of arms) {
      const n = this.n.get(a) ?? 0;
      const s = this.r.get(a) ?? 0;
      const v = sampleBeta(1 + s, 1 + (n - s), this.rng);
      if (v > bestV) {
        bestV = v;
        best = a;
      }
    }
    return best;
  }
}

export function createBandit(kind: "ucb1" | "thompson", rng: Rng, c = 1): Bandit {
  return kind === "thompson" ? new ThompsonBandit(rng) : new Ucb1Bandit(c);
}
