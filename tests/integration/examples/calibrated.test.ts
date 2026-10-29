import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type CalibratedServer, startCalibratedServer } from "../../fixtures/servers/calibrated.js";

let srv: CalibratedServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

async function timed(url: string, init?: RequestInit): Promise<{ status: number; ms: number; body: string }> {
  const t0 = process.hrtime.bigint();
  const r = await fetch(url, init);
  const body = await r.text();
  return { status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6, body };
}

function sorted(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

describe("calibrated server", () => {
  it("listens on 127.0.0.1 with a random port and serves /healthz", async () => {
    srv = await startCalibratedServer();
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(srv.port).toBeGreaterThan(0);
    const r = await timed(`${srv.url}/healthz`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });

  it("/fixed/50: server holds 50 ms precisely; client-observed p50 within ±3 ms (sequential)", async () => {
    srv = await startCalibratedServer();
    await timed(`${srv.url}/fixed/1`); // warm the connection
    const xs: number[] = [];
    const held: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await timed(`${srv.url}/fixed/50`);
      xs.push(r.ms);
      held.push((JSON.parse(r.body) as { heldMs: number }).heldMs);
    }
    const h = sorted(held);
    // Fixture precision (server side, hrtime): never early, p95 within +1 ms.
    expect(h[0]).toBeGreaterThanOrEqual(50);
    expect(h[28]).toBeLessThan(51);
    const s = sorted(xs);
    expect(s[0]).toBeGreaterThanOrEqual(49.5);
    // Plain fetch timing on Windows jitters by ~2 ms under background load (seen with Docker Desktop
    // running); this checks the fixture, the accuracy suite owns the engine's ±2 ms.
    expect(Math.abs((s[15] ?? 0) - 50)).toBeLessThan(3);
    // Client-observed tail includes the test process's own scheduling noise (other suites
    // run in parallel), so it only gets a generous budget here; the accuracy suite owns ±2 ms.
    expect(s[28]).toBeLessThan(60);
  });

  it("/fixed handles concurrency without serialising", async () => {
    srv = await startCalibratedServer();
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 50 }, () => timed(`${srv!.url}/fixed/100`)));
    const wall = performance.now() - t0;
    expect(wall).toBeLessThan(600);
    expect(srv.stats().inFlightMax).toBeGreaterThan(1);
    expect(srv.stats().inFlight).toBe(0);
  });

  it("/dist/uniform is deterministic for a seed and within range", async () => {
    const sample = async (seed: number): Promise<number[]> => {
      const s = await startCalibratedServer({ seed });
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        const r = await fetch(`${s.url}/dist/uniform?min=1&max=5`);
        out.push(((await r.json()) as { delayMs: number }).delayMs);
      }
      await s.close();
      return out;
    };
    const a = await sample(7);
    const b = await sample(7);
    const c = await sample(8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const x of a) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(5);
    }
  });

  it("/dist/lognormal median of sampled delays approximates the parameter", async () => {
    srv = await startCalibratedServer({ seed: 3 });
    const xs: number[] = [];
    // sigma tiny → fast; check the sampled delays (reported in body), not wall time.
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${srv.url}/dist/lognormal?median=2&sigma=0.5`);
      xs.push(((await r.json()) as { delayMs: number }).delayMs);
    }
    const s = sorted(xs);
    expect(s[100]).toBeGreaterThan(1.6);
    expect(s[100]).toBeLessThan(2.4);
  });

  it("/dist/bimodal produces both modes", async () => {
    srv = await startCalibratedServer({ seed: 1 });
    const xs = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const r = await fetch(`${srv.url}/dist/bimodal?a=1&b=3&p=0.5`);
      xs.add(((await r.json()) as { delayMs: number }).delayMs);
    }
    expect([...xs].sort()).toEqual([1, 3]);
  });

  it("/error/:pct fails exactly pct% by counter", async () => {
    srv = await startCalibratedServer();
    for (const pct of [10, 25, 33]) {
      let fails = 0;
      for (let i = 0; i < 100; i++) if ((await timed(`${srv.url}/error/${pct}`)).status === 500) fails++;
      expect(fails).toBe(pct);
    }
    expect(srv.stats().byStatus["500"]).toBe(68);
  });

  it("/stall holds requests until the stall ends; non-stall routes unaffected", async () => {
    srv = await startCalibratedServer();
    srv.stallFor(300);
    const stalled = timed(`${srv.url}/stall`);
    const free = await timed(`${srv.url}/fixed/0`);
    expect(free.ms).toBeLessThan(100);
    const s = await stalled;
    expect(s.status).toBe(200);
    expect(s.ms).toBeGreaterThanOrEqual(280);
    expect(s.ms).toBeLessThan(800);
  });

  it("setBehavior({stallUntilMs: 0}) releases held requests early; stallAllRoutes holds every route", async () => {
    srv = await startCalibratedServer();
    srv.setBehavior({ stallUntilMs: Date.now() + 10_000, stallAllRoutes: true });
    const p = timed(`${srv.url}/fixed/1`);
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.stats().inFlight).toBe(1);
    srv.setBehavior({ stallUntilMs: 0 });
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(2000);
  });

  it("/status/:code returns that code", async () => {
    srv = await startCalibratedServer();
    expect((await timed(`${srv.url}/status/418`)).status).toBe(418);
    expect((await timed(`${srv.url}/status/204`)).status).toBe(204);
    expect((await timed(`${srv.url}/status/503`)).status).toBe(503);
  });

  it("/echo returns the posted JSON", async () => {
    srv = await startCalibratedServer();
    const r = await fetch(`${srv.url}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1, b: ["x"] }),
    });
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ a: 1, b: ["x"] });
  });

  it("/slow-body streams over the requested time", async () => {
    srv = await startCalibratedServer();
    const t0 = performance.now();
    const r = await fetch(`${srv.url}/slow-body/200?chunks=4`);
    const ttfb = performance.now() - t0;
    const text = await r.text();
    const total = performance.now() - t0;
    expect(ttfb).toBeLessThan(100);
    expect(total).toBeGreaterThanOrEqual(190);
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
  });

  it("/reset-conn destroys the socket", async () => {
    srv = await startCalibratedServer();
    await expect(fetch(`${srv.url}/reset-conn`)).rejects.toThrow();
    // server still healthy afterwards
    expect((await timed(`${srv.url}/healthz`)).status).toBe(200);
  });

  it("keeps connections alive and stats track routes", async () => {
    srv = await startCalibratedServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const ports = new Set<number>();
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        http
          .get(`${srv!.url}/fixed/0`, { agent }, (res) => {
            ports.add(res.socket.localPort ?? -1);
            res.resume();
            res.on("end", resolve);
          })
          .on("error", reject);
      });
    }
    expect(ports.size).toBe(1);
    const st = srv.stats();
    expect(st.requests).toBe(3);
    expect(st.byRoute["/fixed"]).toBe(3);
    agent.destroy();
  });

  it("close() completes promptly with idle keep-alive sockets and in-flight stalled requests", async () => {
    srv = await startCalibratedServer();
    await fetch(`${srv.url}/healthz`).then((r) => r.text()); // leaves an idle keep-alive socket
    srv.stallFor(60_000);
    const pending = fetch(`${srv.url}/stall`).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    await srv.close();
    srv = undefined;
    expect(performance.now() - t0).toBeLessThan(1000);
    await pending;
  });

  it("/capacity/:n: flat latency up to n in flight, queueing beyond (capacity cliff)", async () => {
    srv = await startCalibratedServer();
    const burst = async (k: number): Promise<number[]> => {
      const rs = await Promise.all(
        Array.from({ length: k }, () => fetch(`${srv!.url}/capacity/4?ms=100`).then((r) => r.json() as Promise<{ queuedMs: number }>)),
      );
      return rs.map((r) => r.queuedMs).sort((a, b) => a - b);
    };
    const under = await burst(4);
    expect(under[3]).toBeLessThan(30); // nobody queued
    const over = await burst(12); // 3 waves of 4
    expect(over[3]).toBeLessThan(30);
    expect(over[4]).toBeGreaterThan(80);
    expect(over[11]).toBeGreaterThan(180);
    expect(srv.stats().inFlight).toBe(0);
  });

  it("/capacity/:n?maxQueue sheds load with 503", async () => {
    srv = await startCalibratedServer();
    const rs = await Promise.all(Array.from({ length: 6 }, () => fetch(`${srv!.url}/capacity/2?ms=80&maxQueue=2`).then((r) => r.status)));
    expect(rs.filter((s) => s === 200)).toHaveLength(4);
    expect(rs.filter((s) => s === 503)).toHaveLength(2);
  });

  it("close() releases queued /capacity requests", async () => {
    srv = await startCalibratedServer();
    const pending = Array.from({ length: 5 }, () => fetch(`${srv!.url}/capacity/1?ms=5000`).catch(() => "reset"));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    await srv.close();
    srv = undefined;
    await Promise.all(pending);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
