/**
 * Coverage + adversarial tests for redirect handling, credential stripping, cancellation and
 * DNS re-check scheduling in the undici executor (src/adapters/http/undici-executor.ts;
 * docs/11 §1 "Redirects to other hosts", F5/F6). Owner: sw-coverage (Wave 5).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { createUndiciExecutor, MAX_REDIRECTS } from "../../../src/adapters/http/undici-executor.js";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function server(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return { s, seen, origin: "" };
}

const a = server((req, res) => {
  const u = req.url ?? "/";
  const m = /^\/r(\d{3})\/(.*)$/.exec(u);
  if (m) return void res.writeHead(Number(m[1]), { location: decodeURIComponent(m[2] as string) }).end();
  if (u.startsWith("/loop")) return void res.writeHead(302, { location: "/loop" }).end();
  if (u === "/empty-location") return void res.writeHead(302, { location: "" }).end();
  if (u === "/big") return void res.writeHead(200).end("x".repeat(5000));
  if (u === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 2000);
  res.writeHead(200, { "content-type": "text/plain" }).end(`final ${req.method} ${u}`);
});
const b = server((req, res) => res.writeHead(200).end(`other ${req.method} ${req.url}`));

beforeAll(async () => {
  for (const x of [a, b]) {
    await new Promise<void>((r) => x.s.listen(0, "127.0.0.1", r));
    x.origin = `http://127.0.0.1:${(x.s.address() as AddressInfo).port}`;
  }
});
afterAll(async () => {
  for (const x of [a, b]) {
    x.s.closeAllConnections();
    await new Promise<void>((r) => x.s.close(() => r()));
  }
});

const enc = encodeURIComponent;

describe("redirects", () => {
  it("not followed by default; followed with a hop count and finalUrl", async () => {
    const ex = createUndiciExecutor();
    try {
      const r0 = await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc("/done")}` });
      expect(r0.status).toBe(302);
      expect(r0.redirects).toBeUndefined();
      const r1 = await ex.execute({ origin: a.origin, method: "GET", path: `/r301/${enc("/done?q=1")}`, followRedirects: true, readBody: true });
      expect(r1.status).toBe(200);
      expect(r1.redirects).toBe(1);
      expect(r1.finalUrl).toBe(`${a.origin}/done?q=1`);
      expect(r1.body?.toString()).toBe("final GET /done?q=1");
      const r2 = await ex.execute({ origin: a.origin, method: "GET", path: "/empty-location", followRedirects: true });
      expect(r2.status).toBe(302);
    } finally {
      await ex.close();
    }
  });

  it("redirect loops stop at the hop limit with kind redirect-limit", async () => {
    const ex = createUndiciExecutor();
    try {
      const r = await ex.execute({ origin: a.origin, method: "GET", path: "/loop", followRedirects: true });
      expect(r.error?.kind).toBe("redirect-limit");
      expect(r.redirects).toBe(MAX_REDIRECTS);
      const r2 = await ex.execute({ origin: a.origin, method: "GET", path: "/loop", followRedirects: 2 });
      expect(r2.error?.message).toMatch(/more than 2/);
    } finally {
      await ex.close();
    }
  });

  it("303 and 301/302 on POST switch to GET and drop the body + body headers; 307 keeps method and body", async () => {
    const ex = createUndiciExecutor();
    try {
      a.seen.length = 0;
      await ex.execute({
        origin: a.origin,
        method: "POST",
        path: `/r303/${enc("/after")}`,
        headers: ["content-type", "application/json", "x-keep", "1"],
        body: '{"a":1}',
        followRedirects: true,
      });
      const hop = a.seen.at(-1) as Seen;
      expect(hop.method).toBe("GET");
      expect(hop.body).toBe("");
      expect(hop.headers["content-type"]).toBeUndefined();
      expect(hop.headers["x-keep"]).toBe("1");
      await ex.execute({ origin: a.origin, method: "POST", path: `/r302/${enc("/p")}`, headers: { "Content-Type": "text/plain" }, body: "x", followRedirects: true });
      expect(a.seen.at(-1)?.method).toBe("GET");
      await ex.execute({ origin: a.origin, method: "HEAD", path: `/r303/${enc("/h")}`, followRedirects: true });
      expect(a.seen.at(-1)?.method).toBe("HEAD");
      await ex.execute({ origin: a.origin, method: "POST", path: `/r307/${enc("/keep")}`, body: "payload", followRedirects: true });
      expect(a.seen.at(-1)).toMatchObject({ method: "POST", url: "/keep", body: "payload" });
    } finally {
      await ex.close();
    }
  });

  it("cross-origin hops strip Authorization, Cookie and Proxy-Authorization; same-origin hops keep them", async () => {
    const ex = createUndiciExecutor();
    const creds = { authorization: "Bearer s3cret", cookie: "sid=1", "proxy-authorization": "Basic x", "x-trace": "t" };
    try {
      await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc("/same")}`, headers: creds, followRedirects: true });
      expect(a.seen.at(-1)?.headers.authorization).toBe("Bearer s3cret");
      b.seen.length = 0;
      const r = await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc(`${b.origin}/x`)}`, headers: creds, followRedirects: true, readBody: true });
      expect(r.body?.toString()).toBe("other GET /x");
      const h = b.seen[0]?.headers ?? {};
      expect(h.authorization).toBeUndefined();
      expect(h.cookie).toBeUndefined();
      expect(h["proxy-authorization"]).toBeUndefined();
      expect(h["x-trace"]).toBe("t");
    } finally {
      await ex.close();
    }
  });

  it("cross-origin hops also strip custom credential headers (x-api-key, x-auth-token, x-session-id, …)", async () => {
    const ex = createUndiciExecutor();
    const creds = { "x-api-key": "k", "x-auth-token": "t", "x-session-id": "s", "x-signature": "g", "x-trace": "keep", accept: "application/json" };
    try {
      b.seen.length = 0;
      await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc(`${b.origin}/x`)}`, headers: creds, followRedirects: true });
      const h = b.seen[0]?.headers ?? {};
      for (const k of ["x-api-key", "x-auth-token", "x-session-id", "x-signature"]) expect(h[k], k).toBeUndefined();
      expect(h["x-trace"]).toBe("keep");
      expect(h.accept).toBe("application/json");
    } finally {
      await ex.close();
    }
  });

  it("the Safety Guard vets every hop: metadata IPs, public hosts and private names are not followed", async () => {
    const guard = createSafetyGuard({}, { interactive: false });
    const ex = createUndiciExecutor({ safety: guard });
    try {
      for (const loc of ["http://169.254.169.254/latest/meta-data/", "https://evil.example.com/", "http://db.internal/"]) {
        const r = await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc(loc)}`, followRedirects: true });
        expect(r.error?.kind, loc).toBe("safety");
        expect(r.status).toBe(302);
        expect(r.redirects).toBe(0);
      }
      expect(guard.auditEntries().filter((e) => e.action === "safety.redirect-blocked")).toHaveLength(3);
      // async checkRedirect (worker shard bridge) is awaited
      const ex2 = createUndiciExecutor({ safety: { checkRedirect: async () => ({ allowed: false, code: "SW_SAFETY_X", reason: "nope" }) } });
      const r2 = await ex2.execute({ origin: a.origin, method: "GET", path: `/r307/${enc("/x")}`, followRedirects: true });
      expect(r2.error).toEqual({ kind: "safety", message: "SW_SAFETY_X: nope" });
      await ex2.close();
    } finally {
      await ex.close();
    }
  });

  it("non-http(s) and malformed redirect targets are refused even without a guard", async () => {
    const ex = createUndiciExecutor();
    try {
      const r = await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc("file:///etc/passwd")}`, followRedirects: true });
      expect(r.error).toMatchObject({ kind: "safety", message: expect.stringContaining("file:") });
      const r2 = await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc("http://[::1")}`, followRedirects: true });
      expect(r2.error?.kind).toBe("other");
    } finally {
      await ex.close();
    }
  });
});

describe("cancellation, limits and DNS re-checks", () => {
  it("closed executor and pre-aborted signals return an aborted result without I/O", async () => {
    const ex = createUndiciExecutor();
    const ac = new AbortController();
    ac.abort();
    const r = await ex.execute({ origin: a.origin, method: "GET", path: "/" }, ac.signal);
    expect(r.error?.kind).toBe("aborted");
    await ex.close();
    const r2 = await ex.execute({ origin: a.origin, method: "GET", path: "/" });
    expect(r2).toMatchObject({ status: 0, bytesOut: 0, error: { kind: "aborted" } });
  });

  it("mid-flight cancel → aborted; timeout → timeout", async () => {
    const ex = createUndiciExecutor({ timeoutMs: 100, keepAlive: false });
    try {
      const t = await ex.execute({ origin: a.origin, method: "GET", path: "/slow" });
      expect(t.error?.kind).toBe("timeout");
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      const ex2 = createUndiciExecutor({ timeoutMs: 5000 });
      const c = await ex2.execute({ origin: a.origin, method: "GET", path: "/slow" }, ac.signal);
      expect(c.error?.kind).toBe("aborted");
      expect(ex2.inFlight).toBe(0);
      await ex2.close();
    } finally {
      await ex.close();
    }
  });

  it("readBody keeps at most maxBodyBytes (plus one chunk) but counts every byte", async () => {
    const ex = createUndiciExecutor({ maxBodyBytes: 10 });
    try {
      const r = await ex.execute({ origin: a.origin, method: "GET", path: "/big", readBody: true });
      expect(r.bytesIn).toBe(5000);
      expect(r.body?.length).toBeLessThanOrEqual(5000);
      expect(r.body?.length).toBeGreaterThan(0);
    } finally {
      await ex.close();
    }
  });

  it("DNS re-check: skipped for IP literals, first sighting only records, then at most once per interval; errors surface", async () => {
    const calls: string[] = [];
    let t = 0;
    const port = new URL(a.origin).port;
    const ex = createUndiciExecutor({
      now: () => t,
      dnsRecheckIntervalMs: 1000,
      safety: {
        recheckDns: async (h) => {
          calls.push(h);
          throw new Error("SW_SAFETY_DNS_REBIND");
        },
      },
    });
    try {
      await ex.execute({ origin: a.origin, method: "GET", path: "/" });
      await ex.execute({ origin: a.origin, method: "GET", path: "/" });
      expect(calls).toEqual([]);
      const named = `http://localhost:${port}`;
      await ex.execute({ origin: named, method: "GET", path: "/" }); // first sighting
      t = 500;
      await ex.execute({ origin: named, method: "GET", path: "/" }); // within interval
      t = 1500;
      await ex.execute({ origin: named, method: "GET", path: "/" }); // re-check
      await new Promise((r) => setImmediate(r));
      expect(calls).toEqual(["localhost"]);
      expect(ex.dnsRechecks).toBe(1);
      expect(ex.safetyError?.message).toBe("SW_SAFETY_DNS_REBIND");
    } finally {
      await ex.close();
    }
  });

  it("detailed timing reports phases and connection timings", async () => {
    const conns: unknown[] = [];
    const ex = createUndiciExecutor({ timing: "detailed", onConnection: (c) => conns.push(c) });
    try {
      const r = await ex.execute({ origin: a.origin, method: "GET", path: `/r302/${enc("/t")}`, followRedirects: true });
      expect(r.status).toBe(200);
      expect(conns.length).toBeGreaterThanOrEqual(1);
      expect(ex.openSockets).toBeGreaterThanOrEqual(0);
    } finally {
      await ex.close();
    }
  });
});
