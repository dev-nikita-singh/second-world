import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { pendingGlobalCleanups } from "../../../src/adapters/faults/cleanup.js";
import { flapActive, selectByCounter } from "../../../src/adapters/faults/types.js";
import { type Listening, listenOnRandomPort } from "../../helpers/servers.js";

let upstream: Listening;
let upstreamHits = 0;
let proxy: BuiltinFaultProxy | undefined;

beforeEach(async () => {
  upstreamHits = 0;
  const server = http.createServer((req, res) => {
    upstreamHits++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body =
        req.url === "/big"
          ? "x".repeat(2000)
          : JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  upstream = await listenOnRandomPort(server);
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await upstream.close();
});

async function get(url: string, timeoutMs = 3000): Promise<{ status: number; body: string; ms: number }> {
  const t = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, body, ms: performance.now() - t };
}

describe("selection helpers", () => {
  it("selectByCounter picks exactly percent of every 100", () => {
    for (const p of [0, 1, 7, 25, 50, 99, 100]) {
      let n = 0;
      for (let i = 0; i < 100; i++) if (selectByCounter(i, p)) n++;
      expect(n).toBe(p);
    }
  });
  it("flapActive follows the on/off schedule", () => {
    expect(flapActive(0, 100, 50)).toBe(true);
    expect(flapActive(99, 100, 50)).toBe(true);
    expect(flapActive(100, 100, 50)).toBe(false);
    expect(flapActive(149, 100, 50)).toBe(false);
    expect(flapActive(150, 100, 50)).toBe(true);
    expect(flapActive(310, 100, 50)).toBe(true);
  });
});

describe("builtin proxy (http mode)", () => {
  it("forwards requests and counts them", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url, name: "echo" });
    const r = await get(`${proxy.url}/hello`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).path).toBe("/hello");
    const post = await fetch(`${proxy.url}/p`, { method: "POST", body: "abc" });
    expect(JSON.parse(await post.text()).body).toBe("abc");
    expect(proxy.stats().requests).toBe(2);
    expect(proxy.arrivals()).toHaveLength(2);
    expect(pendingGlobalCleanups().some((n) => n.includes("echo"))).toBe(true);
  });

  it("latency adds at least the configured delay; revert removes it (hot swap)", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    const base = await get(`${proxy.url}/a`);
    const f = await proxy.apply({ type: "latency", latencyMs: 150 });
    const slow = await get(`${proxy.url}/a`);
    expect(slow.ms).toBeGreaterThanOrEqual(148);
    await f.revert();
    const fast = await get(`${proxy.url}/a`);
    expect(fast.ms).toBeLessThan(base.ms + 100);
    expect(proxy.active()).toEqual([]);
  });

  it("reset closes the connection", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    await proxy.apply({ type: "reset" });
    await expect(get(`${proxy.url}/a`)).rejects.toThrow();
    expect(upstreamHits).toBe(0);
    expect(proxy.stats().injected.reset).toBe(1);
  });

  it("blackhole makes the client time out; revert forwards held requests", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    const f = await proxy.apply({ type: "blackhole" });
    await expect(get(`${proxy.url}/a`, 300)).rejects.toThrow(/timeout|aborted/i);
    const pending = get(`${proxy.url}/b`, 3000);
    await new Promise((r) => setTimeout(r, 100));
    expect(proxy.stats().held).toBeGreaterThanOrEqual(1);
    await f.revert();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.ms).toBeGreaterThanOrEqual(90);
  });

  it("status injection hits exactly percent of requests (counter-based)", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    await proxy.apply({ type: "http-status", status: 503, percent: 30 });
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await get(`${proxy.url}/x`)).status);
    expect(statuses.filter((s) => s === 503)).toHaveLength(6);
    expect(upstreamHits).toBe(14);
    expect(proxy.stats().responses["503"]).toBe(6);
  });

  it("slow body trickles the response", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    await proxy.apply({ type: "slow-body", chunkBytes: 500, delayMs: 60 });
    const r = await get(`${proxy.url}/big`);
    expect(r.body).toHaveLength(2000);
    expect(r.ms).toBeGreaterThanOrEqual(4 * 55);
  });

  it("bandwidth limits throughput", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    await proxy.apply({ type: "bandwidth", bytesPerSecond: 10_000 });
    const r = await get(`${proxy.url}/big`);
    expect(r.body).toHaveLength(2000);
    expect(r.ms).toBeGreaterThanOrEqual(150);
  });

  it("flapping toggles the fault on and off", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    await proxy.apply({ type: "http-status", status: 500, flapping: { onMs: 200, offMs: 200 } });
    const at = async (ms: number): Promise<number> => {
      await new Promise((r) => setTimeout(r, ms));
      return (await get(`${proxy?.url}/f`)).status;
    };
    expect(await at(0)).toBe(500);
    expect(await at(250)).toBe(200);
    expect(await at(200)).toBe(500);
  });

  it("TTL auto-reverts a fault", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    await proxy.apply({ type: "http-status", status: 500, ttlMs: 100 });
    expect((await get(`${proxy.url}/t`)).status).toBe(500);
    await new Promise((r) => setTimeout(r, 150));
    expect(proxy.active()).toEqual([]);
    expect((await get(`${proxy.url}/t`)).status).toBe(200);
  });

  it("abort signal reverts the fault", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url });
    const ac = new AbortController();
    await proxy.apply({ type: "http-status", status: 500 }, ac.signal);
    ac.abort();
    expect(proxy.active()).toEqual([]);
  });

  it("close destroys held sockets, stops listening and unregisters", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url, name: "closing" });
    await proxy.apply({ type: "blackhole" });
    const pending = get(`${proxy.url}/a`, 5000).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    const port = proxy.port;
    await proxy.close();
    expect(await pending).toBeInstanceOf(Error);
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1");
        s.on("connect", () => {
          s.destroy();
          resolve("connected");
        });
        s.on("error", reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(pendingGlobalCleanups().some((n) => n.includes("closing"))).toBe(false);
  });
});

describe("builtin proxy (tcp mode)", () => {
  it("forwards raw TCP with latency and resets connections", async () => {
    proxy = await startFaultProxy({ upstream: upstream.url, mode: "tcp" });
    const viaTcp = `http://127.0.0.1:${proxy.port}`;
    expect((await get(`${viaTcp}/ok`)).status).toBe(200);
    await proxy.apply({ type: "latency", latencyMs: 100 });
    const r = await get(`${viaTcp}/slow`);
    expect(r.ms).toBeGreaterThanOrEqual(190); // both directions
    await proxy.revert();
    await proxy.apply({ type: "reset" });
    // new connection required: undici would reuse a keep-alive socket
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect(proxy?.port ?? 0, "127.0.0.1");
        s.on("data", resolve);
        s.on("error", reject);
        s.on("close", () => reject(new Error("closed")));
        s.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
      }),
    ).rejects.toThrow();
    expect(proxy.stats().connections).toBeGreaterThanOrEqual(2);
  });
});
