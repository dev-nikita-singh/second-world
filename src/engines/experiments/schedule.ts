/**
 * Run schedules for valid comparisons. docs/03-engines/experiments.md §A.3:
 * interleave arms (ABAB… or randomised blocks) instead of AAAA BBBB to cancel drift
 * (thermal throttling, cache warmth, noisy neighbours).
 *
 * - "interleaved": block k runs every arm once, in the arm order rotated by k (AB BA AB BA… for two
 *   arms; a cyclic Latin square for more), so each arm occupies each position equally often over
 *   every `arms` consecutive blocks.
 * - "randomized-blocks": each block is an independent seeded permutation (Fisher–Yates).
 * - "sequential": all runs of arm 1, then arm 2 … (drift is NOT cancelled; reported as a warning).
 */
export type ScheduleOrder = "interleaved" | "randomized-blocks" | "sequential";

export interface ScheduledRun {
  /** Position in the schedule (0-based). */
  index: number;
  arm: string;
  /** Repetition number of this arm (0-based). */
  rep: number;
  /** Block number (0-based); every arm appears once per block (not for "sequential"). */
  block: number;
}

export function buildSchedule(
  arms: readonly string[],
  repetitions: number,
  order: ScheduleOrder,
  rand: () => number,
): ScheduledRun[] {
  const out: ScheduledRun[] = [];
  const k = arms.length;
  if (k === 0 || repetitions <= 0) return out;
  if (order === "sequential") {
    for (const arm of arms)
      for (let rep = 0; rep < repetitions; rep++) out.push({ index: out.length, arm, rep, block: rep });
    return out;
  }
  for (let block = 0; block < repetitions; block++) {
    let perm: number[];
    if (order === "interleaved") {
      perm = Array.from({ length: k }, (_, i) => (i + block) % k);
    } else {
      perm = Array.from({ length: k }, (_, i) => i);
      for (let i = k - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = perm[i] as number;
        perm[i] = perm[j] as number;
        perm[j] = t;
      }
    }
    for (const a of perm) out.push({ index: out.length, arm: arms[a] as string, rep: block, block });
  }
  return out;
}
