/**
 * sw-qa repro: safety.maxRps must cap closed-model (VU) load, in the Performance Lab and in Stress.
 * Server in a child process so the generator measures without fixture CPU contention.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { runPerformance } from "../../../src/engines/performance/index.js";
import { runStress } from "../../../src/engines/stress/index.js";
import {
  type ChildCalibratedServer,
  startCalibratedServerInChild,
} from "../../fixtures/servers/calibrated-child.js";

let srv: ChildCalibratedServer;

beforeAll(async () => {
  srv = await startCalibratedServerInChild();
});
afterAll(async () => {
  await srv.close();
});

describe("safety.maxRps caps VU load", () => {
  it("perf: closed 20 VUs at maxRps=100 for 3 s → achieved ≤ 105 rps with PERF-THROTTLED-BY-SAFETY", async () => {
    const safety = createSafetyGuard({ maxRps: 100 }, { interactive: false });
    const res = await runPerformance(
      {
        target: srv.url,
        model: "closed",
        vus: 20,
        duration: "3s",
        scenarios: [{ name: "s", steps: [{ path: "/fixed/2" }] }],
      },
      { safety },
    );
    const d = res.data;
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.totals.rps).toBeLessThanOrEqual(105);
    expect(d.totals.rps).toBeGreaterThan(80);
    expect(res.limitations.map((l) => l.code)).toContain("PERF-THROTTLED-BY-SAFETY");
    // throttle wait is not latency: a 2 ms endpoint stays fast
    expect(d.latency.raw.p50).toBeLessThan(20);
  });

  it("stress: a 50-VU step with maxRps=200 stays capped", async () => {
    const safety = createSafetyGuard({ maxRps: 200 }, { interactive: false });
    const r = await runStress(
      {
        target: `${srv.url}/fixed/2`,
        loadType: "vus",
        stages: [50],
        hold: "2s",
        settle: "200ms",
      },
      { safety },
    );
    const stage = r.data?.stages[0];
    expect(stage).toBeDefined();
    expect(stage?.throughput).toBeLessThanOrEqual(210);
    expect(stage?.throughput).toBeGreaterThan(150);
  });
});
