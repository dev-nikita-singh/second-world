/**
 * Follow-ups F3 (exact Little's Law), detailed phase timing, and the F5 DNS-pinning lookup hook.
 * Server runs in a child process so generator CPU/timing is not skewed by the fixture.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUndiciExecutor } from "../../../src/adapters/http/undici-executor.js";
import { createEngineContext } from "../../../src/core/context.js";
import { runPerformance } from "../../../src/engines/performance/index.js";
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

/** Lookup that resolves every host to 127.0.0.1 (like the guard's pinned lookup) and counts calls. */
function pinnedLookup(): LookupFunction & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((hostname: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    calls.push(hostname);
    const addr: LookupAddress = { address: "127.0.0.1", family: 4 };
    if (options.all) cb(null, [addr]);
    else cb(null, addr.address, addr.family);
  }) as unknown as LookupFunction & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("Little's Law self-check (F3 regression, sw-stress case)", () => {
  it("50 rps against a 20 ms endpoint: L ≈ λW, no generator-saturated verdict", async () => {
    for (const duration of ["1s", "3s"]) {
      const res = await runPerformance({
        target: srv.url,
        rate: 50,
        duration,
        scenarios: [{ name: "s", steps: [{ path: "/fixed/20" }] }],
      });
      const g = res.data?.generator;
      expect(g).toBeDefined();
      if (!g) return;
      expect(g.reasons.join(" ")).not.toMatch(/Little/);
      // λW ≈ 50/s × ~21 ms ≈ 1.05; exact integration lands right there (sampling gave 2.00 against that).
      // Compared with λ·W of THIS run: on a starved macOS runner the 20 ms endpoint answered in ~40 ms, so
      // the true concurrency was ~2 (seen: 2.08). The old fixed 1.3 bound failed a correct measurement.
      expect(g.meanInFlight).toBeGreaterThan(0.85);
      expect(g.meanInFlight).toBeLessThan(g.littlesLawExpected * 1.2 + 0.05);
      if (duration === "3s") expect(g.littlesLawMismatch).toBeLessThan(0.1);
    }
  });
});

describe("detailed phase timing", () => {
  it("reports DNS/TCP/connect per connection and wait/server/transfer per request", async () => {
    const port = new URL(srv.url).port;
    const res = await runPerformance(
      {
        target: `http://localhost:${port}`,
        allowHosts: ["localhost"],
        vus: 2,
        duration: "1s",
        timing: "detailed",
        scenarios: [{ name: "s", steps: [{ path: "/fixed/30" }] }],
      },
      {},
    );
    const d = res.data;
    expect(d?.phases).toBeDefined();
    const p = d?.phases;
    if (!p || !d) return;
    expect(p.connections).toBeGreaterThanOrEqual(1);
    expect(p.connections).toBeLessThanOrEqual(4);
    expect(p.connect.count).toBe(p.connections);
    expect(p.dns.count).toBe(p.connections); // hostname → a lookup happened
    expect(p.tcp.count).toBe(p.connections);
    expect(p.tls.count).toBe(0); // plain http
    expect(p.server.count).toBe(d.totals.requests);
    // server phase ≈ the 30 ms the endpoint holds the response
    expect(p.server.p50).toBeGreaterThanOrEqual(28);
    expect(p.server.p50).toBeLessThan(45);
    // wait + server + transfer ≈ raw latency
    expect(Math.abs(p.wait.mean + p.server.mean + p.transfer.mean - d.latency.raw.mean)).toBeLessThan(2);
    expect(res.limitations.map((l) => l.code)).not.toContain("timing-detailed-partial");
  });

  it("basic timing installs nothing and reports no phases", async () => {
    const res = await runPerformance({
      target: srv.url,
      iterations: 5,
      vus: 1,
      scenarios: [{ name: "s", steps: [{ path: "/fixed/1" }] }],
    });
    expect(res.data?.phases).toBeUndefined();
  });
});

describe("DNS pinning lookup hook (F5)", () => {
  it("executor connects through the supplied lookup", async () => {
    const lk = pinnedLookup();
    const port = new URL(srv.url).port;
    const ex = createUndiciExecutor({ lookup: lk, connections: 1 });
    try {
      // "pinned.test" does not exist in DNS: only the pinned lookup can make this work.
      const r = await ex.execute({ origin: `http://pinned.test:${port}`, method: "GET", path: "/fixed/1" });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(200);
      expect(lk.calls).toEqual(["pinned.test"]);
    } finally {
      await ex.close();
    }
  });

  it("a lookup refusal surfaces as error kind 'safety'", async () => {
    const deny = ((_h: string, _o: unknown, cb: (e: Error) => void) =>
      cb(
        Object.assign(new Error("blocked by guard"), { code: "SW_SAFETY_HOST_NOT_ALLOWED" }),
      )) as unknown as LookupFunction;
    const ex = createUndiciExecutor({ lookup: deny });
    try {
      const r = await ex.execute({ origin: "http://blocked.test:1", method: "GET", path: "/" });
      expect(r.error?.kind).toBe("safety");
    } finally {
      await ex.close();
    }
  });

  it("engine uses ctx.safety.lookup when the guard provides one", async () => {
    const lk = pinnedLookup();
    const ctx = createEngineContext({});
    // Simulate the F5 guard member on the default guard.
    Object.defineProperty(ctx.safety, "lookup", { value: lk });
    const port = new URL(srv.url).port;
    const res = await runPerformance(
      {
        target: `http://localhost:${port}`,
        iterations: 3,
        vus: 1,
        scenarios: [{ name: "s", steps: [{ path: "/fixed/1" }] }],
      },
      ctx,
    );
    expect(res.data?.totals.ok).toBe(3);
    expect(lk.calls).toContain("localhost");
    // sanity: the system resolver is untouched
    await new Promise<void>((resolve) => dnsLookup("localhost", () => resolve()));
  });
});
