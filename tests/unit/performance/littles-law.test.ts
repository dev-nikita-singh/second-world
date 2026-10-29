import { describe, expect, it } from "vitest";
import {
  evaluateGeneratorHealth,
  InFlightIntegrator,
  LITTLES_LAW_MIN_REQUESTS,
} from "../../../src/engines/performance/self-check.js";

/** Feeds constant arrivals with a fixed service time through the integrator (event-ordered). */
function simulate(rate: number, serviceMs: number, windowMs: number, offsetMs = 0): InFlightIntegrator {
  const integ = new InFlightIntegrator(0, windowMs);
  const events: { t: number; d: 1 | -1 }[] = [];
  for (let t = offsetMs; t < windowMs; t += 1000 / rate) {
    events.push({ t, d: 1 }, { t: t + serviceMs, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  for (const e of events) {
    if (e.d === 1) integ.start(e.t);
    else integ.end(e.t);
  }
  return integ;
}

describe("Little's Law: exact time-weighted in-flight (F3 regression)", () => {
  it("sw-stress case: 50 rps × 20 ms over 1 s gives L = 1.0 (a 100 ms sampler aliased to 2.0)", () => {
    // Arrivals every 20 ms with 20 ms service: in-flight is exactly 1 at all times. A sampler
    // ticking every 100 ms that lands on arrival/departure boundaries can read 2 every time.
    for (const offset of [0, 3, 7.5, 19.9]) {
      const L = simulate(50, 20, 1000, offset).mean(1000);
      expect(L).toBeGreaterThan(0.97);
      expect(L).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });

  it("matches λ·W for other rates and service times", () => {
    for (const [rate, svc] of [
      [100, 5],
      [200, 37],
      [10, 250],
    ] as const) {
      const L = simulate(rate, svc, 10_000).mean(10_000);
      expect(Math.abs(L - (rate * svc) / 1000) / ((rate * svc) / 1000)).toBeLessThan(0.03);
    }
  });

  it("clips to the window and to an early stop", () => {
    const integ = new InFlightIntegrator(100, 1100);
    integ.start(0); // before the window
    integ.end(600); // in flight 100..600 inside window → area 500
    integ.start(900);
    integ.setWindowEnd(1000); // stopped early
    integ.end(1500); // only 900..1000 counts
    expect(integ.mean(2000)).toBeCloseTo(600 / 900, 9);
    expect(integ.max).toBe(1);
  });

  it("the rule needs enough evidence before it may fire", () => {
    const base = {
      model: "open" as const,
      eldP99Ms: 1,
      eldMaxMs: 1,
      cpuMs: 10,
      spinMs: 0,
      wallMs: 1000,
      lagP99Ms: 0,
      lagMaxMs: 0,
      intervalMs: 20,
      dropped: 0,
      throughput: 50,
      meanLatencyMs: 20.6,
      latencyFlat: true,
      maxOpenSockets: 2,
      connections: 64,
    };
    // The exact sw-stress numbers (L=2.00 vs λW=1.03) on a 1 s / 50 request stage: no verdict.
    const small = evaluateGeneratorHealth({ ...base, meanInFlight: 2, completed: 50, measuredMs: 1000 });
    expect(small.health.saturated).toBe(false);
    expect(small.health.littlesLawMismatch).toBe(0);
    // Same mismatch with enough evidence: the rule still fires.
    const big = evaluateGeneratorHealth({
      ...base,
      meanInFlight: 2,
      completed: LITTLES_LAW_MIN_REQUESTS * 3,
      measuredMs: 6000,
    });
    expect(big.health.saturated).toBe(true);
    expect(big.health.reasons.join(" ")).toMatch(/Little/);
  });
});
