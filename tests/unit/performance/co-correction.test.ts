import { describe, expect, it } from "vitest";
import { PerfMetrics, type RequestSample } from "../../../src/engines/performance/metrics.js";

function sample(over: Partial<RequestSample>): RequestSample {
  return {
    endpoint: "GET /x",
    scenario: "s",
    method: "GET",
    path: "/x",
    startMs: 0,
    intendedMs: 0,
    headersMs: 0,
    endMs: 1,
    status: 200,
    ok: true,
    bytesIn: 10,
    bytesOut: 0,
    ...over,
  };
}

describe("coordinated-omission correction", () => {
  it("closed model: a 2 s stall at 100 rps gives corrected p99 >= 1 s while raw p99 stays small", () => {
    const m = new PerfMetrics({ startMs: 0, warmupEndMs: 0, random: () => 0.5 });
    // 3 s of 1 ms responses at 100 rps from one VU (expected interval 10 ms)
    let t = 0;
    for (let i = 0; i < 300; i++) {
      m.record(sample({ startMs: t, intendedMs: t, headersMs: t + 1, endMs: t + 1, expectedIntervalMs: 10 }));
      t += 10;
    }
    // one request hits a 2 s stall: the closed loop sends nothing else meanwhile
    m.record(
      sample({ startMs: t, intendedMs: t, headersMs: t + 2000, endMs: t + 2000, expectedIntervalMs: 10 }),
    );
    const raw = m.global.raw;
    const cor = m.global.corrected;
    expect(raw.count).toBe(301);
    expect(raw.percentile(99) / 1000).toBeLessThan(2);
    // 2000/10 = 200 samples (2000, 1990, ... 10 ms)
    expect(cor.count).toBe(301 + 199);
    expect(cor.percentile(99) / 1000).toBeGreaterThanOrEqual(1000);
    expect(cor.max / 1000).toBeGreaterThanOrEqual(1999);
  });

  it("open model: latency measured from the intended start includes queueing delay", () => {
    const m = new PerfMetrics({ startMs: 0, warmupEndMs: 0, random: () => 0.5 });
    // sent 500 ms late (generator queue), served in 5 ms
    m.record(sample({ intendedMs: 1000, startMs: 1500, headersMs: 1505, endMs: 1505 }));
    expect(Math.abs(m.global.raw.max / 1000 - 5)).toBeLessThan(0.05);
    expect(Math.abs(m.global.corrected.max / 1000 - 505)).toBeLessThan(1);
  });

  it("warm-up samples are excluded from the measured metrics", () => {
    const m = new PerfMetrics({ startMs: 0, warmupEndMs: 1000, random: () => 0.5 });
    m.record(sample({ intendedMs: 500, startMs: 500, endMs: 600 }));
    m.record(
      sample({ intendedMs: 1500, startMs: 1500, endMs: 1510, ok: false, status: 500, errorKind: "status" }),
    );
    expect(m.warmupRequests).toBe(1);
    expect(m.requests).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.errors.get("status")).toBe(1);
    expect(m.status.get(500)).toBe(1);
    expect(m.endpoints.get("GET /x")?.failed).toBe(1);
    expect(m.errorReservoir.items).toHaveLength(1);
  });
});
