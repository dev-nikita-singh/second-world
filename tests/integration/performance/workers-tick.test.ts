/**
 * Live perf.tick percentiles with 2 workers are exact (merged interval histograms), not the max of
 * the per-worker values (sw-fixes, wave 5). Template `seq` is strided across shards (worker 0 gets odd,
 * worker 1 even values), so the server makes only worker 1's traffic slow: seq % 30 === 2 →
 * 1/15 ≈ 6.7 % of worker 1's requests (its own p95 is slow) but 1/30 ≈ 3.3 % of the union (union p95 fast,
 * union p99 slow).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/events.js";
import { runPerformance } from "../../../src/engines/performance/index.js";

const SLOW_MS = 120;
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n"));
    if (n % 30 === 2) setTimeout(() => res.end("slow"), SLOW_MS);
    else res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("perf.tick with 2 workers", () => {
  it("p95 is the union's (fast) although worker 1's own p95 is slow; p99 is slow", async () => {
    const events = createEventBus();
    const ticks: Array<{ phase: string; p95: number; p99: number; workers?: number }> = [];
    events.on("perf.tick", (p) => ticks.push(p as (typeof ticks)[number]));
    const res = await runPerformance(
      {
        target: base,
        rate: 300,
        duration: "4s",
        workers: 2,
        seed: 3,
        scenarios: [{ name: "s", steps: [{ path: "/s?n={{seq}}" }] }],
      },
      { events },
    );
    expect(res.data?.config.workers).toBe(2);
    const measured = ticks.filter((t) => t.phase === "measure" && t.p99 > 0);
    expect(measured.length).toBeGreaterThanOrEqual(2);
    for (const t of measured) expect(t.workers).toBe(2);
    // Most windows: union p95 fast, p99 slow (the max-of-workers approximation gave p95 ≥ SLOW_MS).
    const fastP95 = measured.filter((t) => t.p95 < SLOW_MS / 2).length;
    const slowP99 = measured.filter((t) => t.p99 >= SLOW_MS * 0.9).length;
    expect(fastP95 / measured.length).toBeGreaterThanOrEqual(0.5);
    expect(slowP99 / measured.length).toBeGreaterThanOrEqual(0.5);
  }, 30_000);
});
