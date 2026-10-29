/**
 * Exponential backoff with full jitter — docs/04-data-structures-and-algorithms.md §3.6.
 * delay = random(0, min(cap, base · 2^attempt)). Randomness is injected for determinism.
 */
export interface BackoffOptions {
  /** Base delay in ms. */
  base: number;
  /** Maximum delay in ms. */
  cap: number;
  /** 0-based attempt number. */
  attempt: number;
  /** Uniform [0,1) source. */
  rng: () => number;
}

/** Upper bound of the jitter range for an attempt (no randomness). */
export function backoffCeiling(base: number, cap: number, attempt: number): number {
  const a = Math.max(0, Math.floor(attempt));
  const exp = a >= 1024 ? Number.POSITIVE_INFINITY : base * 2 ** a;
  return Math.max(0, Math.min(cap, exp));
}

/** Full-jitter delay in ms, uniform in [0, min(cap, base·2^attempt)). */
export function backoff(opts: BackoffOptions): number {
  return opts.rng() * backoffCeiling(opts.base, opts.cap, opts.attempt);
}
