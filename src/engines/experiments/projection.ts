/**
 * Projections beyond the tested range: ALWAYS labelled `kind: "estimate"` (docs/03-engines/experiments.md §A.1).
 *
 * - Queueing (M/M/1, open model): from the measured arrival rate λ and mean response time R,
 *   service time S = R / (1 + λR) (since R = S/(1−λS)). At λ′: ρ′ = λ′S, R′ = S/(1−ρ′) and, with an
 *   exponential response-time distribution, p95′ = −ln(0.05)·R′. ρ′ ≥ 1 → "saturated" (unbounded queue).
 *   Assumptions: one bottleneck server, Poisson arrivals, exponential service — a coarse estimate.
 * - USL (docs/04 §6.5): fit λ, σ, κ to measured (N, X) points (stress curves), project X(N).
 *   Refused with < 5 points or R² < 0.9 (fitUsl).
 */
import { fitUsl, uslThroughput } from "../stress/usl.js";

export interface QueueingProjection {
  kind: "estimate";
  method: "mm1";
  arm: string;
  rate: number;
  /** Measured basis. */
  basis: { rate: number; meanMs: number; serviceMs: number; utilisation: number };
  utilisation: number;
  saturated: boolean;
  meanMs: number | null;
  p95Ms: number | null;
  assumptions: string;
}

export interface UslProjection {
  kind: "estimate";
  method: "usl";
  concurrency: number;
  throughput: number | null;
  fit: {
    lambda: number | null;
    sigma: number | null;
    kappa: number | null;
    r2: number | null;
    peakN: number | null;
  };
  extrapolated: boolean;
  refused?: string;
}

export type Projection = QueueingProjection | UslProjection;

const LN20 = Math.log(20);

export function projectMm1(
  arm: string,
  measuredRate: number,
  meanMs: number,
  rates: readonly number[],
): QueueingProjection[] {
  const R = meanMs / 1000;
  if (!(measuredRate > 0) || !(R > 0)) return [];
  const S = R / (1 + measuredRate * R);
  const basis = { rate: measuredRate, meanMs, serviceMs: S * 1000, utilisation: measuredRate * S };
  return rates.map((rate) => {
    const rho = rate * S;
    const saturated = rho >= 1;
    const Rp = saturated ? null : S / (1 - rho);
    return {
      kind: "estimate" as const,
      method: "mm1" as const,
      arm,
      rate,
      basis,
      utilisation: rho,
      saturated,
      meanMs: Rp === null ? null : Rp * 1000,
      p95Ms: Rp === null ? null : Rp * LN20 * 1000,
      assumptions:
        "M/M/1: single bottleneck, Poisson arrivals, exponential service time; service time inferred from the measured mean latency",
    };
  });
}

export function projectUsl(
  points: readonly { n: number; x: number }[],
  concurrency: readonly number[],
): UslProjection[] {
  if (concurrency.length === 0) return [];
  const est = fitUsl(points, "vus");
  const maxN = points.reduce((m, p) => Math.max(m, p.n), 0);
  const fit = { lambda: est.lambda, sigma: est.sigma, kappa: est.kappa, r2: est.r2, peakN: est.peakN };
  return concurrency.map((n) => {
    const ok = est.lambda !== null && est.sigma !== null && est.kappa !== null && !est.refused;
    return {
      kind: "estimate" as const,
      method: "usl" as const,
      concurrency: n,
      throughput: ok
        ? uslThroughput(n, est.lambda as number, est.sigma as number, est.kappa as number)
        : null,
      fit,
      extrapolated: n > maxN,
      ...(est.refused ? { refused: est.refused } : {}),
    };
  });
}
