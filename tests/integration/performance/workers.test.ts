/**
 * worker_threads sharding (docs/03-engines/performance-lab.md §7) against the calibrated server
 * (127.0.0.1, port 0, in a child process so the fixture does not compete with the generator).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineContext } from "../../../src/core/context.js";
import { createSafetyGuard, type ResolvedAddress } from "../../../src/core/safety/guard.js";
import { runPerformance } from "../../../src/engines/performance/index.js";
import { liveWorkerCount } from "../../../src/engines/performance/sharded.js";
import { LatencyHistogram } from "../../../src/shared/stats/hdr.js";
import {
  type ChildCalibratedServer,
  startCalibratedServerInChild,
} from "../../fixtures/servers/calibrated-child.js";

let srv: ChildCalibratedServer;
let redirects: http.Server;
let rbase = "";
let hits = 0;
/** Resolves once the local server has seen `n` more requests (the workers are really running). */
async function afterHits(n: number): Promise<void> {
  const target = hits + n;
  while (hits < target) await new Promise((r) => setTimeout(r, 10));
}

beforeAll(async () => {
  srv = await startCalibratedServerInChild();
  redirects = http.createServer((req, res) => {
    hits++;
    if (req.url === "/slow") {
      setTimeout(() => res.end("ok"), 10);
      return;
    }
    if (req.url === "/away") res.writeHead(302, { location: "http://evil.example.com/steal" }).end();
    else if (req.url === "/hop") res.writeHead(302, { location: "/ok" }).end();
    else res.end("ok");
  });
  await new Promise<void>((r) => redirects.listen(0, "127.0.0.1", () => r()));
  rbase = `http://127.0.0.1:${(redirects.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await srv.close();
  redirects.closeAllConnections();
  await new Promise<void>((r) => redirects.close(() => r()));
});

describe("performance lab: worker_threads sharding", () => {
  it("open model, 2 workers: holds 400 rps within 5% and merges histograms exactly", async () => {
    const res = await runPerformance({
      target: srv.url,
      rate: 400,
      duration: "3s",
      workers: 2,
      seed: 7,
      scenarios: [{ name: "fast", steps: [{ path: "/fixed/5" }] }],
    });
    const d = res.data;
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.config.workers).toBe(2);
    expect(d.generator.workers).toBe(2);
    expect(d.generator.perWorker).toHaveLength(2);
    expect(res.limitations.map((l) => l.code)).not.toContain("workers-not-supported");
    expect(Math.abs(d.totals.rps - 400)).toBeLessThanOrEqual(20);
    expect(Math.abs((d.totals.achievedRate as number) - 400)).toBeLessThanOrEqual(20);
    expect(Math.abs(d.totals.requests - 1200)).toBeLessThanOrEqual(60);
    expect(d.totals.failed).toBe(0);
    // merged global histogram holds every request of both workers
    expect(LatencyHistogram.decode(d.histograms.global.raw).count).toBe(d.totals.requests);
    expect(d.series.reduce((a, p) => a + p.requests, 0)).toBe(d.totals.requests);
    // per-worker achieved rates are each about half
    for (const w of d.generator.perWorker ?? [])
      expect(Math.abs((w.achievedRate ?? 0) - 200)).toBeLessThanOrEqual(15);
    expect(liveWorkerCount()).toBe(0);
  });

  it("closed model: 10 VUs split over 2 workers", async () => {
    const res = await runPerformance({
      target: srv.url,
      model: "closed",
      vus: 10,
      duration: "2s",
      workers: 2,
      scenarios: [{ name: "s", steps: [{ path: "/fixed/20" }] }],
    });
    const d = res.data;
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.config.workers).toBe(2);
    expect(d.config.vus).toBe(10);
    expect(d.totals.failed).toBe(0);
    // 10 VUs × (1 / ~20 ms) ≈ 500 rps; allow generous slack for Windows timers.
    expect(d.totals.rps).toBeGreaterThan(300);
    expect(d.totals.rps).toBeLessThan(560);
    expect(Math.abs(d.latency.raw.p50 - 20)).toBeLessThanOrEqual(10);
    expect(d.scenarios[0]?.iterations).toBe(d.totals.iterations);
    expect(liveWorkerCount()).toBe(0);
  });

  it("iterations model: exactly N iterations across workers", async () => {
    const res = await runPerformance({
      target: srv.url,
      model: "iterations",
      iterations: 101,
      vus: 4,
      workers: 2,
      scenarios: [{ name: "s", steps: [{ path: "/fixed/1" }] }],
    });
    expect(res.data?.totals.requests).toBe(101);
    expect(res.data?.totals.iterations).toBe(101);
    expect(res.data?.config.workers).toBe(2);
  });

  it("cancel mid-run stops every worker promptly with no leaked threads", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const t0 = performance.now();
    const res = await runPerformance(
      {
        target: srv.url,
        rate: 200,
        duration: "20s",
        gracefulStop: "10s",
        workers: 2,
        scenarios: [{ name: "slow", steps: [{ path: "/fixed/300" }] }],
      },
      { signal: ac.signal },
    );
    clearTimeout(t);
    const elapsed = performance.now() - t0;
    expect(res.status).toBe("cancelled");
    expect(res.data?.window.stopReason).toBe("cancelled");
    expect(elapsed).toBeLessThan(5000);
    expect(liveWorkerCount()).toBe(0);
  });

  it("safety.maxRps across 2 workers: total rps ≤ cap × 1.05", async () => {
    const safety = createSafetyGuard({ maxRps: 100 }, { interactive: false });
    const res = await runPerformance(
      {
        target: srv.url,
        model: "closed",
        vus: 20,
        duration: "3s",
        workers: 2,
        scenarios: [{ name: "s", steps: [{ path: "/fixed/2" }] }],
      },
      { safety },
    );
    const d = res.data;
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.config.workers).toBe(2);
    expect(d.totals.rps).toBeLessThanOrEqual(105);
    expect(d.totals.rps).toBeGreaterThan(80);
    expect(res.limitations.map((l) => l.code)).toContain("PERF-THROTTLED-BY-SAFETY");
  });

  it("workers resolve names only through the main thread's Safety Guard (pinned addresses)", async () => {
    let resolutions = 0;
    const safety = createSafetyGuard(
      {},
      {
        interactive: false,
        resolver: async () => {
          resolutions++;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      },
    );
    const port = new URL(srv.url).port;
    const res = await runPerformance(
      {
        target: `http://localhost:${port}`,
        rate: 50,
        duration: "1s",
        workers: 2,
        scenarios: [{ name: "s", steps: [{ path: "/fixed/1" }] }],
      },
      { safety },
    );
    expect(res.data?.totals.failed).toBe(0);
    expect(res.data?.totals.requests).toBeGreaterThan(40);
    // one resolution, pinned once, served to both workers' connections
    expect(resolutions).toBe(1);
    expect(safety.pins().map((p) => p.addresses[0]?.address)).toEqual(["127.0.0.1"]);
  });

  it("redirect hops are vetted by the main thread's guard (blocked hop = safety error)", async () => {
    const res = await runPerformance({
      target: rbase,
      model: "iterations",
      iterations: 20,
      vus: 4,
      workers: 2,
      scenarios: [
        {
          name: "s",
          steps: [
            { path: "/hop", followRedirects: true, expect: { status: 200 } },
            { path: "/away", followRedirects: true },
          ],
        },
      ],
    });
    const d = res.data;
    expect(d?.config.workers).toBe(2);
    expect(d?.endpoints.find((e) => e.key === "GET /hop")?.ok).toBe(20);
    expect(d?.endpoints.find((e) => e.key === "GET /away")?.errors).toEqual({ safety: 20 });
  });

  it("the kill switch stops all workers promptly", async () => {
    const guard = createSafetyGuard({}, { interactive: false });
    let killedAt = 0;
    void afterHits(30).then(() => {
      killedAt = performance.now();
      guard.kill(new Error("operator kill"));
    });
    const res = await runPerformance(
      {
        target: rbase,
        model: "closed",
        vus: 8,
        duration: "20s",
        workers: 2,
        scenarios: [{ name: "s", steps: [{ path: "/slow" }] }],
      },
      { safety: guard },
    );
    expect(killedAt).toBeGreaterThan(0);
    expect(performance.now() - killedAt).toBeLessThan(2500);
    expect(res.status).toBe("cancelled");
    expect(res.data?.totals.requests).toBeGreaterThan(0);
    expect(liveWorkerCount()).toBe(0);
  });

  it("a DNS rebind seen by a worker's re-check aborts every worker (status error)", async () => {
    let flipped = false;
    const resolver = async (_host: string): Promise<ResolvedAddress[]> =>
      flipped ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    const guard = createSafetyGuard(
      { allowHosts: ["127.0.0.1", "localhost", "app.internal"] },
      { interactive: false, resolver },
    );
    const ctx = createEngineContext({ safety: guard });
    const port = new URL(rbase).port;
    let flippedAt = 0;
    void afterHits(20).then(() => {
      flipped = true;
      flippedAt = performance.now();
    });
    const res = await runPerformance(
      {
        target: `http://app.internal:${port}`,
        rate: 50,
        duration: "10s",
        gracefulStop: "200ms",
        workers: 2,
        scenarios: [{ name: "s", steps: [{ path: "/" }] }],
      },
      ctx,
      { dnsRecheckIntervalMs: 100 },
    );
    expect(flippedAt).toBeGreaterThan(0);
    expect(performance.now() - flippedAt).toBeLessThan(2500);
    expect(res.status).toBe("error");
    expect(res.data?.window.stopReason).toBe("safety-abort");
    expect(res.data?.totals.ok).toBeGreaterThan(5);
    expect(res.limitations.map((l) => l.code)).toContain("dns-rebind");
    expect(res.findings.some((f) => f.ruleId === "PERF-DNS-REBIND")).toBe(true);
    expect(liveWorkerCount()).toBe(0);
  });
});
