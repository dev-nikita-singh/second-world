/**
 * Reproducibility classification from replay outcomes.
 * docs/03-engines/api-bug-hunter.md §3 step 4, docs/04-data-structures-and-algorithms.md §6.6.
 *
 *  n/n failures       → reproduced-defect (deterministic)
 *  1..n-1 of n        → reproduced-defect, flaky, rate + Wilson 95 % interval
 *  0/n                → observation (not reproducible)
 * Inconclusive runs (transport errors, budget) are not counted in n.
 */

import type { Classification } from "../../core/evidence/schemas.js";
import { wilson } from "../../shared/stats/proportion.js";

export interface ReplayOutcome {
  failures: number;
  runs: number;
}

export interface ReplayClassification {
  classification: Extract<Classification, "reproduced-defect" | "observation">;
  flaky: boolean;
  failures: number;
  runs: number;
  rate: number;
  wilson: { lower: number; upper: number };
  /** Confidence for the finding: deterministic 0.95, flaky scaled by the Wilson lower bound. */
  confidence: number;
}

export function classifyReplays(o: ReplayOutcome): ReplayClassification {
  const { failures, runs } = o;
  if (runs <= 0) {
    return {
      classification: "observation",
      flaky: false,
      failures: 0,
      runs: 0,
      rate: 0,
      wilson: { lower: 0, upper: 1 },
      confidence: 0.3,
    };
  }
  const w = wilson(failures, runs);
  const rate = failures / runs;
  if (failures === 0) {
    return {
      classification: "observation",
      flaky: false,
      failures,
      runs,
      rate,
      wilson: { lower: w.lower, upper: w.upper },
      confidence: 0.3,
    };
  }
  if (failures === runs) {
    return {
      classification: "reproduced-defect",
      flaky: false,
      failures,
      runs,
      rate,
      wilson: { lower: w.lower, upper: w.upper },
      confidence: 0.95,
    };
  }
  return {
    classification: "reproduced-defect",
    flaky: true,
    failures,
    runs,
    rate,
    wilson: { lower: w.lower, upper: w.upper },
    confidence: Math.max(0.5, Math.min(0.9, 0.5 + w.lower)),
  };
}
