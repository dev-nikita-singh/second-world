/**
 * Iterations model: a fixed amount of work shared by N VUs, then stop.
 * See docs/03-engines/performance-lab.md §2. Built on the closed-loop scheduler with a shared counter.
 */
import { type ClosedSchedulerOptions, type ClosedSchedulerResult, runClosed } from "./closed.js";

export interface IterationsSchedulerOptions extends Omit<ClosedSchedulerOptions, "claim"> {
  iterations: number;
}

export async function runIterations(opts: IterationsSchedulerOptions): Promise<ClosedSchedulerResult> {
  let left = opts.iterations;
  return runClosed({
    ...opts,
    vus: Math.min(opts.vus, opts.iterations),
    claim: () => {
      if (left <= 0) return false;
      left--;
      return true;
    },
  });
}
