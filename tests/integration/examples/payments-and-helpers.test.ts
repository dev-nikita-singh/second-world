import http from "node:http";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { api } from "../../helpers/http.js";
import { listenOnRandomPort, waitForReady } from "../../helpers/servers.js";
import { makeTmpDir, withTmpDir } from "../../helpers/tmp.js";

describe("payments-fake", () => {
  it("captures charges, injects deterministic failures, latency and hangs", async () => {
    const p = await startPaymentsFake();
    try {
      const ok = await api(p.url, "POST", "/charges", { body: { orderId: "o1", amount: 5 } });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ orderId: "o1", amount: 5, status: "captured" });

      p.setBehavior({ failPct: 20 });
      let fails = 0;
      for (let i = 0; i < 50; i++) if ((await api(p.url, "POST", "/charges", { body: { orderId: "x" } })).status === 503) fails++;
      expect(fails).toBe(10);

      p.reset();
      p.setBehavior({ latencyMs: 80 });
      expect((await api(p.url, "POST", "/charges", { body: {} })).ms).toBeGreaterThanOrEqual(75);

      // HTTP control endpoint
      await api(p.url, "POST", "/__control", { body: { latencyMs: 0, hang: true } });
      const hung = api(p.url, "POST", "/charges", { body: { orderId: "h" }, timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 50));
      await api(p.url, "POST", "/__control", { body: { hang: false } });
      expect((await hung).status).toBe(503);
      const ctl = await api(p.url, "GET", "/__control");
      expect(ctl.body.stats.attemptsByOrder.h).toBe(1);
    } finally {
      await p.close();
    }
  });

  it("close() returns while a charge is hanging", async () => {
    const p = await startPaymentsFake({ hang: true });
    const pending = fetch(`${p.url}/charges`, { method: "POST", body: "{}" }).catch(() => "reset");
    await new Promise((r) => setTimeout(r, 30));
    await p.close();
    await pending;
  });
});

describe("test helpers", () => {
  it("listenOnRandomPort + waitForReady + close with idle keep-alive sockets", async () => {
    const srv = http.createServer((_q, s) => s.end("ok"));
    const l = await listenOnRandomPort(srv);
    await waitForReady(`${l.url}/`);
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((res) => http.get(`${l.url}/`, { agent }, (r) => r.resume().on("end", () => res())));
    const t0 = performance.now();
    await l.close();
    await l.close(); // idempotent
    expect(performance.now() - t0).toBeLessThan(1000);
    agent.destroy();
  });

  it("waitForReady times out on a dead port", async () => {
    const srv = http.createServer();
    const l = await listenOnRandomPort(srv);
    await l.close();
    await expect(waitForReady(`${l.url}/`, 300)).rejects.toThrow(/not ready/);
  });

  it("tmp dirs are created and removed", async () => {
    const d = await makeTmpDir();
    expect(existsSync(d.path)).toBe(true);
    await d.cleanup();
    expect(existsSync(d.path)).toBe(false);
    let seen = "";
    await withTmpDir(async (t) => {
      seen = t.path;
      expect(existsSync(seen)).toBe(true);
    });
    expect(existsSync(seen)).toBe(false);
  });
});
