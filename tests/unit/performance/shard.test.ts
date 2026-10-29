/**
 * worker_threads sharding helpers: split math, seed derivation, exact metrics merge, interleaved
 * open-model shards. See docs/03-engines/performance-lab.md §7.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRng } from "../../../src/core/rng.js";
import { PerfMetrics, type RequestSample } from "../../../src/engines/performance/metrics.js";
import { arrivalOffsets } from "../../../src/engines/performance/scheduler/open.js";
import { evaluateGeneratorHealth } from "../../../src/engines/performance/self-check.js";
import {
  deriveWorkerSeed,
  effectiveWorkers,
  MAX_AUTO_WORKERS,
  mergeSnapshots,
  planShards,
  resolveWorkers,
  snapshotMetrics,
  splitEven,
} from "../../../src/engines/performance/shard.js";
import { mergeHealth, resolveWorkerEntry } from "../../../src/engines/performance/sharded.js";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";

describe("worker count", () => {
  it('"auto" = min(availableParallelism − 1, 8), at least 1', () => {
    expect(resolveWorkers("auto", 16)).toBe(MAX_AUTO_WORKERS);
    expect(resolveWorkers("auto", 4)).toBe(3);
    expect(resolveWorkers("auto", 2)).toBe(1);
    expect(resolveWorkers("auto", 1)).toBe(1);
    expect(resolveWorkers(3, 2)).toBe(3);
    expect(resolveWorkers(1)).toBe(1);
    expect(resolveWorkers(undefined)).toBe(1);
  });

  it("never more workers than VUs / iterations", () => {
    expect(effectiveWorkers({ model: "closed", vus: 3 }, 8)).toBe(3);
    expect(effectiveWorkers({ model: "iterations", vus: 10, iterations: 2 }, 8)).toBe(2);
    expect(effectiveWorkers({ model: "open", rate: 1 }, 4)).toBe(4);
    expect(effectiveWorkers({ model: "closed", vus: 1 }, 4)).toBe(1);
  });
});

describe("splitEven", () => {
  it("sums to the total and parts differ by at most 1 (larger first)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 64 }), (total, n) => {
        const p = splitEven(total, n);
        expect(p).toHaveLength(n);
        expect(p.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
        for (let i = 1; i < p.length; i++) expect(p[i] as number).toBeLessThanOrEqual(p[i - 1] as number);
      }),
    );
    expect(splitEven(10, 3)).toEqual([4, 3, 3]);
  });
});

describe("planShards", () => {
  it("splits VUs, iterations, in-flight, connections, rate cap and budget", () => {
    const p = planShards({ model: "iterations", vus: 5, iterations: 11 }, 2, {
      maxInFlight: 101,
      connections: 5,
      rpsCap: 100,
      requestBudget: 1001,
      runSeed: 42,
    });
    expect(p.map((s) => s.vus)).toEqual([3, 2]);
    expect(p.map((s) => s.iterations)).toEqual([6, 5]);
    expect(p.map((s) => s.maxInFlight)).toEqual([51, 50]);
    expect(p.map((s) => s.connections)).toEqual([3, 2]);
    expect(p.map((s) => s.rpsCap)).toEqual([50, 50]);
    expect(p.map((s) => s.requestQuota)).toEqual([501, 500]);
    expect(p.map((s) => s.index)).toEqual([0, 1]);
  });

  it("open model keeps the global rate (phases split it); unbounded budget stays unbounded", () => {
    const p = planShards({ model: "open", rate: 1000 }, 4, {
      maxInFlight: 1100,
      connections: 1024,
      rpsCap: null,
      requestBudget: Number.POSITIVE_INFINITY,
      runSeed: 1,
    });
    expect(p.every((s) => s.vus === undefined && s.rpsCap === null)).toBe(true);
    expect(p.every((s) => s.requestQuota === Number.POSITIVE_INFINITY)).toBe(true);
    expect(p.reduce((a, s) => a + s.maxInFlight, 0)).toBe(1100);
  });
});

describe("seed derivation", () => {
  it("is deterministic, distinct per worker and per run seed", () => {
    expect(deriveWorkerSeed(7, 0)).toBe(deriveWorkerSeed(7, 0));
    const seeds = new Set(Array.from({ length: 16 }, (_, i) => deriveWorkerSeed(7, i)));
    expect(seeds.size).toBe(16);
    expect(deriveWorkerSeed(7, 1)).not.toBe(deriveWorkerSeed(8, 1));
    const a = planShards({ model: "open", rate: 10 }, 3, {
      maxInFlight: 64,
      connections: 64,
      rpsCap: null,
      requestBudget: 1e6,
      runSeed: 99,
    });
    expect(a.map((s) => s.seed)).toEqual([0, 1, 2].map((i) => deriveWorkerSeed(99, i)));
  });
});

describe("open-model shards interleave", () => {
  it("constant arrivals: the union of N shards is exactly the global schedule (with ramp-up)", () => {
    for (const [rate, ramp, n] of [
      [400, 0, 2],
      [1000, 500, 3],
      [7, 1000, 4],
    ] as const) {
      const global = [...arrivalOffsets({ rate, arrival: "constant", rampUpMs: ramp, totalMs: 3000 })];
      const shards = Array.from({ length: n }, (_, k) => [
        ...arrivalOffsets({
          rate,
          arrival: "constant",
          rampUpMs: ramp,
          totalMs: 3000,
          shard: { count: n, index: k },
        }),
      ]);
      const union = shards.flat().sort((a, b) => a - b);
      expect(union).toEqual(global);
      // offset phases: shard k's first arrival is the global arrival k
      for (let k = 0; k < n; k++) expect(shards[k]?.[0]).toBe(global[k]);
    }
  });

  it("poisson: each shard is a Poisson process at rate/N", () => {
    const n = 4;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const c = [
        ...arrivalOffsets({
          rate: 1000,
          arrival: "poisson",
          rampUpMs: 0,
          totalMs: 20_000,
          rng: createRng(deriveWorkerSeed(5, k)),
          shard: { count: n, index: k },
        }),
      ].length;
      expect(Math.abs(c - 5000)).toBeLessThan(5000 * 0.05);
      total += c;
    }
    expect(Math.abs(total - 20_000)).toBeLessThan(20_000 * 0.03);
  });
});

function sample(
  rng: ReturnType<typeof createRng>,
  t: number,
  endpoint: string,
  closed: boolean,
): RequestSample {
  const lat = 1 + rng.exponential(20);
  const ok = rng.next() > 0.1;
  return {
    endpoint,
    scenario: "s",
    method: "GET",
    path: endpoint.slice(4),
    startMs: t,
    intendedMs: closed ? t : t - rng.next() * 3,
    headersMs: t + lat / 2,
    endMs: t + lat,
    ...(closed ? { expectedIntervalMs: 5 } : {}),
    status: ok ? 200 : 500,
    ok,
    ...(ok ? {} : { errorKind: "status", message: "HTTP 500" }),
    bytesIn: 100,
    bytesOut: 10,
  };
}

describe("exact merge", () => {
  for (const closed of [false, true]) {
    it(`merged metrics equal one PerfMetrics of all values (${closed ? "closed, CO-corrected" : "open"})`, () => {
      const rng = createRng(3);
      const whole = new PerfMetrics({ startMs: 0, warmupEndMs: 200, random: () => 0.5 });
      const parts = [0, 1, 2].map(() => new PerfMetrics({ startMs: 0, warmupEndMs: 200, random: () => 0.5 }));
      // Completion order, as a real clock delivers them (series windows follow completion time).
      const all = Array.from({ length: 6000 }, (_, i) =>
        sample(rng, i * 0.7, i % 3 === 0 ? "GET /a" : "GET /b", closed),
      ).sort((a, b) => a.endMs - b.endMs);
      all.forEach((s, i) => {
        whole.record(s);
        parts[i % 3]?.record(s);
        if (i % 5 === 0) {
          whole.recordIteration("s", s.intendedMs, s.endMs, s.ok);
          parts[i % 3]?.recordIteration("s", s.intendedMs, s.endMs, s.ok);
        }
      });
      whole.series.closeAll();
      for (const p of parts) p.series.closeAll();
      // structured clone round trip, as over a MessagePort
      const snaps = parts.map((p) => structuredClone(snapshotMetrics(p)));
      const r1 = createRng(1);
      const merged = mergeSnapshots(snaps, { warmupMs: 200, random: () => r1.next() });
      const m = merged.metrics;
      expect(m.global.raw.encode()).toBe(whole.global.raw.encode());
      expect(m.global.corrected.encode()).toBe(whole.global.corrected.encode());
      // Bucket-exact: identical to one histogram of all values. Only `max` is reported as the
      // highest equivalent value of its bucket after decoding (within the HDR resolution, 10^-digits).
      const same = (a: LatencyHistogram, b: LatencyHistogram): void => {
        expect(a.encode()).toBe(b.encode());
        expect(a.summary()).toEqual(LatencyHistogram.decode(b.encode()).summary());
        const { max: ma, ...ra } = a.summary();
        const { max: mb, ...rb } = b.summary();
        expect(ra).toEqual(rb);
        expect(Math.abs(ma - mb)).toBeLessThanOrEqual(Math.max(1, 2 * mb * 10 ** -b.digits));
      };
      same(m.global.corrected, whole.global.corrected);
      same(m.global.raw, whole.global.raw);
      same(m.warmup.raw, whole.warmup.raw);
      for (const [k, e] of whole.endpoints) {
        const me = m.endpoints.get(k);
        if (!me) throw new Error(`missing ${k}`);
        same(me.latency.corrected, e.latency.corrected);
        same(me.ttfb, e.ttfb);
        expect(me?.requests).toBe(e.requests);
        expect(me?.failed).toBe(e.failed);
        expect([...(me?.status ?? [])].sort()).toEqual([...e.status].sort());
      }
      same(m.scenario("s").latency.corrected, whole.scenario("s").latency.corrected);
      expect(m.scenario("s").iterations).toBe(whole.scenario("s").iterations);
      for (const f of [
        "requests",
        "ok",
        "failed",
        "timeouts",
        "bytesIn",
        "bytesOut",
        "warmupRequests",
      ] as const) {
        expect(m[f]).toBe(whole[f]);
      }
      expect([...m.errors]).toEqual([...whole.errors]);
      expect(m.lastEndMs).toBeCloseTo(whole.lastEndMs, 9);
      // series windows (aligned on the shared t0) merge exactly too
      const ws = whole.series.closed();
      expect(merged.windows.map((w) => w.startMs)).toEqual(ws.map((w) => w.startMs));
      merged.windows.forEach((w, i) => {
        expect(w.ok + w.failed).toBe((ws[i]?.ok ?? 0) + (ws[i]?.failed ?? 0));
        const { max: wm, ...wr } = w.summary ?? { max: 0 };
        const { max: om, ...or } = ws[i]?.summary ?? { max: 0 };
        expect(wr).toEqual(or);
        expect(Math.abs(wm - om)).toBeLessThanOrEqual(Math.max(1, om * 1e-2));
      });
      expect(m.errorReservoir.size).toBe(50);
    });
  }
});

describe("merged self-check", () => {
  it("keeps per-worker health, sums rates and prefixes reasons with the worker", () => {
    const base = {
      model: "open" as const,
      eldP99Ms: 1,
      eldMaxMs: 2,
      cpuMs: 100,
      spinMs: 0,
      wallMs: 1000,
      lagP99Ms: 0.1,
      lagMaxMs: 1,
      intervalMs: 4,
      targetRate: 250,
      achievedRate: 250,
      dropped: 0,
      meanInFlight: 2,
      completed: 1000,
      measuredMs: 4000,
      throughput: 250,
      meanLatencyMs: 8,
      latencyFlat: true,
      maxOpenSockets: 4,
      connections: 10,
    };
    const a = evaluateGeneratorHealth(base);
    const b = evaluateGeneratorHealth({ ...base, eldP99Ms: 80, dropped: 3 });
    const m = mergeHealth([a, b]);
    expect(m.health.workers).toBe(2);
    expect(m.health.perWorker).toHaveLength(2);
    expect(m.health.targetRate).toBe(500);
    expect(m.health.achievedRate).toBe(500);
    expect(m.health.dropped).toBe(3);
    expect(m.health.eventLoopDelayP99Ms).toBe(80);
    expect(m.health.saturated).toBe(true);
    expect(m.health.reasons.every((r) => r.startsWith("worker 1: "))).toBe(true);
    expect(m.limitations[0]?.code).toBe("generator-saturated");
  });
});

describe("worker entry resolution", () => {
  it("finds worker.ts with the tsx loader under sources", () => {
    const e = resolveWorkerEntry();
    expect(e?.url.href.endsWith("/worker.ts")).toBe(true);
    expect(e?.execArgv?.[0]).toBe("--import");
  });
  it("returns null when no built worker entry exists", () => {
    expect(resolveWorkerEntry("file:///nonexistent/dir/chunk-abc.js")).toBeNull();
    expect(resolveWorkerEntry("")).toBeNull();
  });
});
