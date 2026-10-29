/**
 * Universal Scalability Law fit (estimate only). See docs/04-data-structures-and-algorithms.md §6.5 and
 * docs/03-engines/stress-capacity-lab.md §3.4.
 *
 * X(N) = λN / (1 + σ(N−1) + κN(N−1)), λ, σ, κ ≥ 0. For fixed (σ, κ) the optimal λ is closed-form
 * (linear least squares), so we grid-search (σ, κ) and refine the grid around the best cell.
 * Refused when < 5 points or R² < 0.9.
 */
import type { UslEstimate } from "./types.js";

export interface UslPoint {
  n: number;
  x: number;
}

function shape(n: number, sigma: number, kappa: number): number {
  return n / (1 + sigma * (n - 1) + kappa * n * (n - 1));
}

function evalFit(pts: readonly UslPoint[], sigma: number, kappa: number): { lambda: number; sse: number } {
  let num = 0;
  let den = 0;
  for (const p of pts) {
    const f = shape(p.n, sigma, kappa);
    num += p.x * f;
    den += f * f;
  }
  const lambda = den > 0 ? Math.max(0, num / den) : 0;
  let sse = 0;
  for (const p of pts) {
    const e = p.x - lambda * shape(p.n, sigma, kappa);
    sse += e * e;
  }
  return { lambda, sse };
}

export function fitUsl(points: readonly UslPoint[], basis: UslEstimate["basis"], minR2 = 0.9): UslEstimate {
  const pts = points.filter((p) => Number.isFinite(p.n) && Number.isFinite(p.x) && p.n > 0);
  const refused = (reason: string, r2: number | null = null): UslEstimate => ({
    kind: "estimate",
    lambda: null,
    sigma: null,
    kappa: null,
    r2,
    peakN: null,
    peakThroughput: null,
    basis,
    points: pts.length,
    refused: reason,
  });
  if (pts.length < 5) return refused(`USL needs at least 5 valid stages (got ${pts.length})`);
  let mean = 0;
  for (const p of pts) mean += p.x;
  mean /= pts.length;
  let sst = 0;
  for (const p of pts) sst += (p.x - mean) ** 2;
  if (!(sst > 0)) return refused("throughput does not vary across stages");

  // σ ∈ [0, 1], κ ∈ {0} ∪ log-grid [1e-8, 1].
  let best = { sigma: 0, kappa: 0, ...evalFit(pts, 0, 0) };
  let sLo = 0;
  let sHi = 1;
  let kLo = -8;
  let kHi = 0;
  for (let round = 0; round < 5; round++) {
    const S = 40;
    for (let i = 0; i <= S; i++) {
      const sigma = sLo + ((sHi - sLo) * i) / S;
      for (let j = -1; j <= S; j++) {
        const kappa = j < 0 ? 0 : 10 ** (kLo + ((kHi - kLo) * j) / S);
        const r = evalFit(pts, sigma, kappa);
        if (r.sse < best.sse) best = { sigma, kappa, ...r };
      }
    }
    const sw = (sHi - sLo) / 8;
    sLo = Math.max(0, best.sigma - sw);
    sHi = Math.min(1, best.sigma + sw);
    if (best.kappa > 0) {
      const lk = Math.log10(best.kappa);
      const kw = (kHi - kLo) / 8;
      kLo = Math.max(-12, lk - kw);
      kHi = Math.min(0, lk + kw);
    }
  }
  const r2 = 1 - best.sse / sst;
  if (!(r2 >= minR2)) return refused(`USL fit quality too low (R² = ${r2.toFixed(3)} < ${minR2})`, r2);
  const peakN = best.kappa > 0 ? Math.sqrt(Math.max(0, 1 - best.sigma) / best.kappa) : null;
  const maxN = Math.max(...pts.map((p) => p.n));
  return {
    kind: "estimate",
    lambda: best.lambda,
    sigma: best.sigma,
    kappa: best.kappa,
    r2,
    peakN,
    peakThroughput: peakN !== null ? best.lambda * shape(peakN, best.sigma, best.kappa) : null,
    basis,
    points: pts.length,
    extrapolated: peakN === null || peakN > maxN,
  };
}

export function uslThroughput(n: number, lambda: number, sigma: number, kappa: number): number {
  return lambda * shape(n, sigma, kappa);
}
