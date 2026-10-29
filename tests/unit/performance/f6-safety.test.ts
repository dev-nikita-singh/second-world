/**
 * F6: the executor uses the Safety Guard's checkRedirect (manual redirect following) and
 * recheckDns (rate-limited, lazy, async). A rebind aborts a Performance Lab run with status "error".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUndiciExecutor,
  type ExecutorSafety,
  MAX_REDIRECTS,
} from "../../../src/adapters/http/undici-executor.js";
import { createEngineContext } from "../../../src/core/context.js";
import { createSafetyGuard, type ResolvedAddress } from "../../../src/core/safety/guard.js";
import { runPerformance } from "../../../src/engines/performance/index.js";

let server: http.Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(`${req.method} ${url}`);
    const m = /^\/r\/(\d+)$/.exec(url);
    if (m) {
      const n = Number(m[1]);
      if (n === 0) {
        res.end("done");
        return;
      }
      res.writeHead(302, { location: `/r/${n - 1}` }).end();
      return;
    }
    if (url === "/away") {
      res.writeHead(302, { location: "http://evil.example.com/steal" }).end();
      return;
    }
    if (url === "/see-other") {
      res.writeHead(303, { location: "/echo-method" }).end();
      return;
    }
    if (url === "/echo-method") {
      res.end(req.method);
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("redirects (F6)", () => {
  const guard = createSafetyGuard({}, { interactive: false });

  it("followRedirects false: a 3xx is just a response", async () => {
    const ex = createUndiciExecutor({ safety: guard });
    try {
      const r = await ex.execute({ origin: base, method: "GET", path: "/r/3" });
      expect(r.status).toBe(302);
      expect(r.error).toBeUndefined();
      expect(r.redirects).toBeUndefined();
    } finally {
      await ex.close();
    }
  });

  it("follows allowed redirects up to the hop limit", async () => {
    const ex = createUndiciExecutor({ safety: guard });
    try {
      const ok = await ex.execute({
        origin: base,
        method: "GET",
        path: "/r/5",
        followRedirects: true,
        readBody: true,
      });
      expect(ok.status).toBe(200);
      expect(ok.redirects).toBe(5);
      expect(ok.finalUrl).toBe(`${base}/r/0`);
      expect(ok.body?.toString()).toBe("done");
      const tooMany = await ex.execute({ origin: base, method: "GET", path: "/r/6", followRedirects: true });
      expect(tooMany.status).toBe(302);
      expect(tooMany.error?.kind).toBe("redirect-limit");
      expect(tooMany.redirects).toBe(MAX_REDIRECTS);
    } finally {
      await ex.close();
    }
  });

  it("303 switches to GET and drops the body", async () => {
    const ex = createUndiciExecutor({ safety: guard });
    try {
      const r = await ex.execute({
        origin: base,
        method: "POST",
        path: "/see-other",
        body: "x=1",
        headers: ["content-type", "text/plain"],
        followRedirects: true,
        readBody: true,
      });
      expect(r.status).toBe(200);
      expect(r.body?.toString()).toBe("GET");
    } finally {
      await ex.close();
    }
  });

  it("a redirect to a disallowed host is blocked (error kind safety), not followed", async () => {
    const ex = createUndiciExecutor({ safety: guard });
    try {
      const r = await ex.execute({ origin: base, method: "GET", path: "/away", followRedirects: true });
      expect(r.status).toBe(302);
      expect(r.error?.kind).toBe("safety");
      expect(r.error?.message).toMatch(/SW_SAFETY_PUBLIC_TARGET/);
      expect(r.redirects).toBe(0);
    } finally {
      await ex.close();
    }
  });

  it("engine: step followRedirects records the final response; a blocked hop is a failed request", async () => {
    const res = await runPerformance({
      target: base,
      iterations: 4,
      vus: 1,
      scenarios: [
        {
          name: "s",
          steps: [
            { path: "/r/2", followRedirects: true, expect: { status: 200 } },
            { path: "/away", followRedirects: true },
          ],
        },
      ],
    });
    const d = res.data;
    expect(d?.endpoints.find((e) => e.key === "GET /r/2")?.ok).toBe(4);
    const away = d?.endpoints.find((e) => e.key === "GET /away");
    expect(away?.failed).toBe(4);
    expect(away?.errors).toEqual({ safety: 4 });
  });
});

describe("DNS re-check (F6)", () => {
  it("is lazy and rate-limited per host, never for IP literals", async () => {
    let now = 0;
    const calls: string[] = [];
    const safety: ExecutorSafety = {
      recheckDns: async (h) => {
        calls.push(h);
      },
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never,
    };
    const ex = createUndiciExecutor({ safety, dnsRecheckIntervalMs: 1000, now: () => now });
    const port = new URL(base).port;
    try {
      for (const t of [0, 500, 999, 1000, 1500, 1999, 2000, 2100]) {
        now = t;
        await ex.execute({ origin: `http://app.internal:${port}`, method: "GET", path: "/" });
        await ex.execute({ origin: base, method: "GET", path: "/" }); // IP literal: never re-checked
      }
      // t=0 first sighting (pinned just now); re-checks at t=1000 and t=2000 only
      expect(calls).toEqual(["app.internal", "app.internal"]);
      expect(ex.dnsRechecks).toBe(2);
    } finally {
      await ex.close();
    }
  });

  it("a rebind detected mid-run by an injected resolver aborts the run with status error", async () => {
    let flipped = false;
    const resolver = async (_host: string): Promise<ResolvedAddress[]> =>
      flipped ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    const guard = createSafetyGuard(
      { allowHosts: ["127.0.0.1", "localhost", "app.internal"] },
      { interactive: false, resolver },
    );
    const ctx = createEngineContext({ safety: guard });
    const port = new URL(base).port;
    setTimeout(() => {
      flipped = true;
    }, 400);
    const t = performance.now();
    const res = await runPerformance(
      {
        target: `http://app.internal:${port}`,
        rate: 50,
        duration: "10s",
        gracefulStop: "200ms",
        scenarios: [{ name: "s", steps: [{ path: "/" }] }],
      },
      ctx,
      { dnsRecheckIntervalMs: 100 },
    );
    expect(performance.now() - t).toBeLessThan(3000);
    expect(res.status).toBe("error");
    expect(res.data?.window.stopReason).toBe("safety-abort");
    expect(res.data?.totals.ok).toBeGreaterThan(5); // ran fine before the rebind
    expect(res.limitations.map((l) => l.code)).toContain("dns-rebind");
    const f = res.findings.find((x) => x.ruleId === "PERF-DNS-REBIND");
    expect(f?.severity).toBe("critical");
    expect(f?.evidence[0]).toMatchObject({ kind: "note" });
    expect(guard.killSwitch.aborted).toBe(true);
  });
});
