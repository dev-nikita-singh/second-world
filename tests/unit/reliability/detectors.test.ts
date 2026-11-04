import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import {
  amplification,
  assessIsolation,
  assessTimeout,
  deriveBounds,
  detectCircuitBreaker,
  detectSynchronizedRetries,
  lagHistogram,
  phaseStats,
  type ReqRecord,
  recoveryTime,
  type WindowStat,
  windowize,
} from "../../../src/engines/reliability/detectors.js";

/** Poisson arrivals at `rate`/s over [0, durMs). */
function poisson(rate: number, durMs: number, seed = 1): number[] {
  const rng = createRng(seed);
  const out: number[] = [];
  let t = 0;
  for (;;) {
    t += rng.exponential(1000 / rate);
    if (t >= durMs) return out;
    out.push(t);
  }
}

/** Each original call is followed by `retries` retries after delay(k). */
function withRetries(base: number[], retries: number, delay: (k: number) => number): number[] {
  const out: number[] = [];
  for (const t of base) {
    let at = t;
    out.push(at);
    for (let k = 0; k < retries; k++) {
      at += delay(k);
      out.push(at);
    }
  }
  return out.sort((a, b) => a - b);
}

function win(partial: Partial<WindowStat>): WindowStat {
  return {
    tMs: 0,
    requests: 10,
    errors: 0,
    timeouts: 0,
    errorRate: 0,
    p50: 10,
    p95: 20,
    proxy: 10,
    ...partial,
  };
}

describe("synchronised retries (missing jitter)", () => {
  it("detects constant-delay retries at the retry lag", () => {
    const base = poisson(20, 10_000, 2);
    const times = withRetries(base, 3, () => 52);
    const r = detectSynchronizedRetries(times, poisson(20, 5000, 3));
    expect(r.detected).toBe(true);
    expect(r.lagMs).toBeGreaterThanOrEqual(45);
    expect(r.lagMs).toBeLessThanOrEqual(60);
  });

  it("does not flag full-jitter backoff", () => {
    const rng = createRng(7);
    const base = poisson(20, 10_000, 4);
    const times = withRetries(base, 3, (k) => rng.next() * Math.min(1000, 50 * 2 ** (k + 1)));
    const r = detectSynchronizedRetries(times, poisson(20, 5000, 5));
    expect(r.detected).toBe(false);
  });

  it("does not flag plain Poisson traffic", () => {
    const r = detectSynchronizedRetries(poisson(60, 10_000, 9));
    expect(r.detected).toBe(false);
  });

  it("does not flag a lattice of peaks (timer-tick quantisation / periodic workload)", () => {
    const periodic = Array.from({ length: 400 }, (_, i) => i * 50);
    expect(detectSynchronizedRetries(periodic).detected).toBe(false);
    // Windows-like 15.6 ms timer lattice on jittered retries
    const rng = createRng(11);
    const base = poisson(20, 10_000, 12);
    const quant = withRetries(base, 3, (k) => rng.next() * Math.min(800, 50 * 2 ** (k + 1))).map(
      (t) => Math.ceil(t / 15.625) * 15.625,
    );
    expect(detectSynchronizedRetries(quant, poisson(20, 5000, 13)).detected).toBe(false);
  });

  it("ignores a lag peak that the steady-state control shows too (workload, not retries)", () => {
    const base = poisson(20, 10_000, 2);
    const ctl = withRetries(poisson(20, 5000, 3), 1, () => 52);
    const r = detectSynchronizedRetries(
      withRetries(base, 1, () => 52),
      ctl,
    );
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/steady-state/);
  });

  it("detects sharp constant-delay retries in a busy background (precise timers, 10 ms window)", () => {
    // Linux/macOS: setTimeout(80) retries land within ~2 ms, i.e. in one 5 ms bin. A 20 ms window adds
    // three bins of background to that peak (z ≈ 4.5 here: missed before wave 9).
    const rng = createRng(102);
    const chains = withRetries(poisson(10, 4000, 2), 3, () => 81 + rng.next() * 2);
    const times = [...chains, ...poisson(40, 4000, 52)].sort((a, b) => a - b);
    const r = detectSynchronizedRetries(times, poisson(10, 2000, 11));
    expect(r.detected, JSON.stringify(r)).toBe(true);
    expect(r.lagMs).toBeGreaterThanOrEqual(75);
    expect(r.lagMs).toBeLessThanOrEqual(90);
  });

  it("the 10 ms window does not turn a slightly jittered 60 ms lattice into a finding", () => {
    const rng = createRng(21);
    const lattice = Array.from({ length: 330 }, (_, i) => i * 60 + (rng.next() - 0.5));
    expect(detectSynchronizedRetries(lattice).detected).toBe(false);
  });

  it("lag histogram counts pairs inside the lag range", () => {
    const h = lagHistogram([0, 20, 40, 2000], { binMs: 10, minLagMs: 10, maxLagMs: 100 });
    expect(h.pairs).toBe(3); // 20, 20, 40
    expect(h.counts[1]).toBe(2);
    expect(h.counts[3]).toBe(1);
  });
});

describe("circuit breaker detection", () => {
  it("detects an open breaker: dependency calls drop and failures are fast", () => {
    const ws = [
      win({ requests: 10, proxy: 6, errors: 10, errorRate: 1, p50: 100 }),
      win({ requests: 10, proxy: 1, errors: 10, errorRate: 1, p50: 2 }),
      win({ requests: 10, proxy: 0, errors: 10, errorRate: 1, p50: 1 }),
      win({ requests: 10, proxy: 1, errors: 10, errorRate: 1, p50: 1 }),
      win({ requests: 10, proxy: 0, errors: 10, errorRate: 1, p50: 1 }),
    ];
    const r = detectCircuitBreaker(ws, 1, [3000, 4000, 5000]);
    expect(r.verdict).toBe("breaker-detected");
    expect(r.probeIntervalMs).toBe(1000);
    expect(r.lateP50).toBeLessThan(r.earlyP50 ?? 0);
  });

  it("reports no breaker when every request keeps calling the failing dependency", () => {
    const ws = Array.from({ length: 6 }, () =>
      win({ requests: 10, proxy: 40, errors: 10, errorRate: 1, p50: 160 }),
    );
    const r = detectCircuitBreaker(ws, 1);
    expect(r.verdict).toBe("no-breaker");
    expect(r.lateRatio).toBe(4);
  });

  it("judges client errors only on requests answered before the revert (in-flight ones are censored)", () => {
    // 5 s fault, no breaker: every request answered during the fault timed out (1 s client timeout);
    // the ones started in the last second were still in flight at the revert and then succeeded.
    const all = [
      ...Array.from({ length: 4 }, () =>
        win({ requests: 20, proxy: 2000, errors: 20, errorRate: 1, p50: 1000 }),
      ),
      win({ requests: 24, proxy: 2000, errors: 0, errorRate: 0, p50: 300 }),
      win({ requests: 0, proxy: 0, p50: Number.NaN, p95: Number.NaN }),
    ];
    // Unfiltered, the late half (windows 3-5) is 20/44 = 45% errors: below the no-breaker bar.
    expect(detectCircuitBreaker(all, 1).verdict).toBe("inconclusive");
    const decided = all.map((w, i) =>
      i >= 4 ? win({ requests: 0, proxy: w.proxy, p50: Number.NaN, p95: Number.NaN }) : w,
    );
    const r = detectCircuitBreaker(all, 1, [], { decided });
    expect(r.verdict).toBe("no-breaker");
    expect(r.lateErrorRate).toBe(1);
    expect(r.lateRatio).toBeCloseTo(4000 / 44, 6);
  });

  it("is inconclusive when nothing late in the fault was answered before the revert", () => {
    const all = Array.from({ length: 5 }, () => win({ requests: 10, proxy: 10, errors: 0, p50: 2000 }));
    const decided = all.map((w, i) => (i >= 1 ? win({ requests: 0, proxy: w.proxy }) : w));
    expect(detectCircuitBreaker(all, 1, [], { decided }).verdict).toBe("inconclusive");
  });

  it("is inconclusive when the fault does not cause failures or is too short", () => {
    expect(detectCircuitBreaker([win({}), win({})], 1).verdict).toBe("inconclusive");
    const ok = Array.from({ length: 5 }, () => win({ proxy: 10 }));
    expect(detectCircuitBreaker(ok, 1).verdict).toBe("inconclusive");
  });
});

describe("timeout correctness", () => {
  const rec = (start: number, end: number, status = 502, error?: string): ReqRecord => ({
    route: "r",
    start,
    end,
    status,
    ...(error ? { error } : {}),
  });
  it("flags requests whose latency tracks the black-hole (no timeout)", () => {
    const rs = [rec(0, 10_010, 201), rec(1000, 10_005, 201), rec(2000, 10_020, 201), rec(3000, 10_003, 201)];
    const r = assessTimeout(rs, 0, 10_000, { budgetMs: 5000 });
    expect(r.verdict).toBe("no-timeout");
    expect(r.completedDuringFault).toBe(0);
    expect(r.windowTooShort).toBe(false);
  });
  it("client-side timeouts count as stuck", () => {
    const rs = [rec(0, 5000, 0, "timeout"), rec(1000, 6000, 0, "timeout"), rec(2000, 7000, 0, "timeout")];
    expect(assessTimeout(rs, 0, 10_000, { budgetMs: 5000 }).verdict).toBe("no-timeout");
  });
  it("short window: client timeout below the budget → inconclusive, never no-timeout", () => {
    // shop-fastify: 1 s client timeout, app budget 4 × 2 s; nothing answered within 1 s
    const rs = Array.from({ length: 20 }, (_, i) => rec(i * 200, i * 200 + 1000, 0, "timeout"));
    const r = assessTimeout(rs, 0, 5000);
    expect(r.verdict).toBe("inconclusive");
    expect(r.windowTooShort).toBe(true);
    expect(r.longestWaitMs).toBe(1000);
    expect(r.budgetMs).toBe(30_000);
    expect(r.reason).toMatch(/longest observed wait was 1000 ms < the outbound timeout budget 30000 ms/);
  });
  it("short window: fault shorter than the budget → inconclusive", () => {
    const rs = [rec(0, 5010, 201), rec(1000, 5005, 201), rec(2000, 5020, 201), rec(3000, 5003, 201)];
    const r = assessTimeout(rs, 0, 5000, { budgetMs: 8000 });
    expect(r.verdict).toBe("inconclusive");
    expect(r.windowTooShort).toBe(true);
  });
  it("long window with true black-hole tracking (≥ 3 waits above the budget) → still no-timeout", () => {
    const rs = Array.from({ length: 10 }, (_, i) => rec(i * 1000, 40_010 + i, 201));
    const r = assessTimeout(rs, 0, 40_000);
    expect(r.verdict).toBe("no-timeout");
    expect(r.longestWaitMs).toBeGreaterThanOrEqual(40_000);
    // only 2 requests waited ≥ 39 s: not enough
    expect(assessTimeout(rs, 0, 40_000, { budgetMs: 39_000 }).verdict).toBe("inconclusive");
  });
  it("recognises an outbound timeout and estimates it", () => {
    const rs = [rec(0, 2050), rec(500, 2560), rec(1000, 3040), rec(8000, 10_010), rec(8500, 10_020)];
    const r = assessTimeout(rs, 0, 10_000);
    expect(r.verdict).toBe("timeout");
    expect(r.effectiveTimeoutMs).toBeGreaterThan(2000);
    expect(r.effectiveTimeoutMs).toBeLessThan(2100);
  });
});

describe("recovery time", () => {
  const bounds = { p95Ms: 100, errorRate: 0.05 };
  it("is the start of the first of 3 consecutive in-bounds windows", () => {
    const ws = [
      win({ errorRate: 0.5, p95: 500 }),
      win({ errorRate: 0, p95: 300 }),
      win({ errorRate: 0, p95: 50 }),
      win({ requests: 0, p95: Number.NaN }),
      win({ errorRate: 0, p95: 60 }),
      win({ errorRate: 0, p95: 40 }),
    ];
    const r = recoveryTime(ws, bounds);
    expect(r.recovered).toBe(true);
    expect(r.recoveryMs).toBe(2000);
  });
  it("is 0 when the first windows are already healthy, null when never", () => {
    expect(recoveryTime([win({}), win({}), win({})], bounds).recoveryMs).toBe(0);
    const never = recoveryTime([win({}), win({ errorRate: 1 }), win({}), win({})], bounds);
    expect(never.recovered).toBe(false);
    expect(never.recoveryMs).toBeNull();
  });
  it("is degraded at the end only when the last 2 windows with traffic are out of bounds", () => {
    // Backlog drain right after the revert, then healthy: not confirmed in a 3 s phase, not degraded.
    const settling = recoveryTime([win({ p95: 120 }), win({}), win({})], bounds);
    expect(settling.recovered).toBe(false);
    expect(settling.degradedAtEnd).toBe(false);
    // Stuck: still failing at the end of the phase.
    const stuck = recoveryTime([win({}), win({ errorRate: 0.5 }), win({ p95: 400 })], bounds);
    expect(stuck.recovered).toBe(false);
    expect(stuck.degradedAtEnd).toBe(true);
    // One slow last window (e.g. a starved generator) is not enough; empty windows are skipped.
    expect(recoveryTime([win({}), win({}), win({ p95: 400 })], bounds).degradedAtEnd).toBe(false);
    expect(
      recoveryTime([win({ p95: 400 }), win({ errorRate: 1 }), win({ requests: 0 })], bounds).degradedAtEnd,
    ).toBe(true);
    expect(recoveryTime([win({}), win({}), win({})], bounds).degradedAtEnd).toBe(false);
  });
  it("derives bounds from steady state", () => {
    const s = phaseStats([{ route: "r", start: 0, end: 20, status: 200 }], 0, 1000);
    expect(deriveBounds(s)).toEqual({ p95Ms: 70, errorRate: 0.05 });
    expect(deriveBounds(s, { p95Ms: 300 }).p95Ms).toBe(300);
  });
});

describe("phase stats, windows, amplification, isolation", () => {
  const records: ReqRecord[] = [];
  for (let i = 0; i < 20; i++)
    records.push({
      route: i % 2 ? "a" : "b",
      start: i * 100,
      end: i * 100 + 10,
      status: i >= 10 && i % 2 ? 503 : 200,
    });
  it("phase stats + windows", () => {
    const s = phaseStats(records, 1000, 2000);
    expect(s.requests).toBe(10);
    expect(s.errors).toBe(5);
    expect(s.errorRate).toBe(0.5);
    expect(s.p50).toBe(10);
    const ws = windowize(records, [0, 50, 1500], 0, 2000);
    expect(ws).toHaveLength(2);
    expect(ws[0]?.proxy).toBe(2);
    expect(ws[1]?.errors).toBe(5);
  });
  it("amplification = dependency calls per client request, normalised by steady state", () => {
    const arrivals = [
      ...Array.from({ length: 10 }, (_, i) => i * 100),
      ...Array.from({ length: 40 }, (_, i) => 1000 + i * 25),
    ];
    const a = amplification(arrivals, records, { from: 0, to: 1000 }, { from: 1000, to: 2000 });
    expect(a.steadyRatio).toBe(1);
    expect(a.faultRatio).toBe(4);
    expect(a.factor).toBe(4);
    expect(a.storm).toBe(true);
  });
  it("isolation failure only for unrelated routes that degrade", () => {
    const iso = assessIsolation(
      [{ name: "a", dependsOn: ["payments"] }, { name: "b", dependsOn: [] }, { name: "c" }],
      "payments",
      () => phaseStats(records, 0, 1000),
      (r) => phaseStats(records, 1000, 2000, r === "b" ? "a" : r),
    );
    expect(iso.find((x) => x.route === "a")?.isolationFailure).toBe(false);
    expect(iso.find((x) => x.route === "a")?.degraded).toBe(true);
    expect(iso.find((x) => x.route === "b")?.isolationFailure).toBe(true);
    expect(iso.find((x) => x.route === "c")?.related).toBeNull();
  });
});
