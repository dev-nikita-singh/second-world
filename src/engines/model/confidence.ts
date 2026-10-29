/**
 * Confidence combination — docs/03-engines/system-model.md §1.
 * Default per-source confidences follow the trust table. Evidence from the same source family is
 * not independent, so each family contributes its best value once; families combine with noisy-OR
 * `1 − Π(1 − cᵢ)`, then the (fuzzy-merge) multiplier is applied.
 */
import type { ModelEvidence, SourceKind } from "./types.js";

export const DEFAULT_CONFIDENCE: Record<SourceKind, number> = {
  trace: 0.95,
  metrics: 0.9,
  experiment: 0.9,
  performance: 0.9,
  openapi: 0.8,
  config: 0.8,
  static: 0.75,
  "static-heuristic": 0.5,
  finding: 0.75,
};

/** Family used for independence: static + static-heuristic are the same analysis. */
export function family(s: SourceKind): string {
  return s === "static-heuristic" ? "static" : s;
}

export function noisyOr(values: readonly number[]): number {
  let p = 1;
  for (const c of values) p *= 1 - Math.min(1, Math.max(0, c));
  return 1 - p;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

export interface CombineResult {
  confidence: number;
}

export function combineConfidence(evidence: readonly ModelEvidence[], multiplier = 1): CombineResult {
  const best = new Map<string, number>();
  for (const e of evidence) {
    const f = family(e.source);
    best.set(f, Math.max(best.get(f) ?? 0, e.confidence));
  }
  return { confidence: round(noisyOr([...best.values()]) * multiplier) };
}
