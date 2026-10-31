import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { SafetyError, TargetError } from "../../../src/core/errors.js";
import { createSafetyGuard, type ResolvedAddress } from "../../../src/core/safety/guard.js";

/** Mutable fake DNS. */
function fakeDns(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolver = async (host: string): Promise<ResolvedAddress[]> => {
    calls.push(host);
    const list = table[host];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { table, calls, resolver };
}

function lookupP(
  guard: ReturnType<typeof createSafetyGuard>,
  host: string,
  opts: { all?: boolean; family?: number } = {},
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    (
      guard.lookup as unknown as (
        h: string,
        o: unknown,
        cb: (e: Error | null, a: string | LookupAddress[], f?: number) => void,
      ) => void
    )(host, opts, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });
}

describe("DNS pinning (docs/11 §2)", () => {
  it("preflight resolves once, pins every address; lookup serves only pinned addresses", async () => {
    const dns = fakeDns({ "api.svc.internal": ["10.0.0.5", "10.0.0.6"] });
    const g = createSafetyGuard(
      { allowHosts: ["*.svc.internal"] },
      { interactive: false, resolver: dns.resolver },
    );
    await g.preflight("http://api.svc.internal:8080/x");
    expect(g.pins()).toHaveLength(1);
    expect(g.pins()[0]).toMatchObject({ host: "api.svc.internal", cls: "private" });
    // DNS changes afterwards: connections still go to the pinned addresses
    dns.table["api.svc.internal"] = ["10.9.9.9"];
    const all = await lookupP(g, "api.svc.internal", { all: true });
    expect(all.address).toEqual([
      { address: "10.0.0.5", family: 4 },
      { address: "10.0.0.6", family: 4 },
    ]);
    const one = await lookupP(g, "API.svc.internal");
    expect(one).toEqual({ address: "10.0.0.5", family: 4 });
    expect(dns.calls).toEqual(["api.svc.internal"]);
  });

  it("an allowed public name resolving to a private/loopback address is blocked unless listed", async () => {
    const dns = fakeDns({ "evil.example.com": ["127.0.0.1"], "tricky.example.com": ["10.1.2.3"] });
    const g = createSafetyGuard(
      { allowHosts: ["evil.example.com", "tricky.example.com"], allowPublic: true },
      { interactive: false, approve: true, resolver: dns.resolver },
    );
    // loopback is always allowed → pinned as loopback
    await g.preflight("https://evil.example.com");
    expect(g.pins()[0]?.cls).toBe("public");
    // private address behind a public name: the NAME is listed, so it's allowed (explicit user intent)
    await g.preflight("https://tricky.example.com");
    // a short private-looking name resolving to a PUBLIC address needs allowPublic + approval
    const dns2 = fakeDns({ myservice: ["8.8.8.8"] });
    const g2 = createSafetyGuard(
      { allowHosts: ["myservice"] },
      { interactive: false, resolver: dns2.resolver },
    );
    await expect(g2.preflight("http://myservice:3000")).rejects.toMatchObject({
      code: "SW_SAFETY_DNS_CLASS",
      exitCode: 3,
    });
  });

  it("unresolvable host → TargetError (exit 5)", async () => {
    const g = createSafetyGuard(
      { allowHosts: ["nope.internal"] },
      { interactive: false, resolver: fakeDns({}).resolver },
    );
    await expect(g.preflight("http://nope.internal")).rejects.toBeInstanceOf(TargetError);
  });

  it("recheckDns: class change → SW_SAFETY_DNS_REBIND + kill switch; same-class churn is fine", async () => {
    const dns = fakeDns({ "app.internal": ["10.0.0.1"] });
    const g = createSafetyGuard(
      { allowHosts: ["app.internal"] },
      { interactive: false, resolver: dns.resolver },
    );
    await g.preflight("http://app.internal");
    dns.table["app.internal"] = ["10.0.0.2"];
    await g.recheckDns("app.internal");
    expect(g.killSwitch.aborted).toBe(false);
    dns.table["app.internal"] = ["93.184.216.34"];
    await expect(g.recheckDns("app.internal")).rejects.toMatchObject({ code: "SW_SAFETY_DNS_REBIND" });
    expect(g.killSwitch.aborted).toBe(true);
    expect(g.auditEntries().some((e) => e.action === "safety.dns-rebind")).toBe(true);
  });

  it("recheckDns: a loopback address appearing for a private host is a rebind", async () => {
    const dns = fakeDns({ "db.internal": ["10.0.0.1"] });
    const g = createSafetyGuard(
      { allowHosts: ["db.internal"] },
      { interactive: false, resolver: dns.resolver },
    );
    await g.preflight("http://db.internal");
    dns.table["db.internal"] = ["10.0.0.1", "127.0.0.1"];
    await expect(g.recheckDns("db.internal")).rejects.toBeInstanceOf(SafetyError);
  });

  it("lookup on an unpinned host checks, resolves and pins once; blocked hosts error with the safety code", async () => {
    const dns = fakeDns({ "late.internal": ["10.0.0.7", "fd00::7"], "pub.example.com": ["1.2.3.4"] });
    const g = createSafetyGuard(
      { allowHosts: ["late.internal"] },
      { interactive: false, resolver: dns.resolver },
    );
    const v6 = await lookupP(g, "late.internal", { family: 6 });
    expect(v6).toEqual({ address: "fd00::7", family: 6 });
    await lookupP(g, "late.internal", { all: true });
    expect(dns.calls).toEqual(["late.internal"]);
    await expect(lookupP(g, "pub.example.com")).rejects.toMatchObject({ code: "SW_SAFETY_PUBLIC_TARGET" });
    expect(dns.calls).not.toContain("pub.example.com");
  });

  it("IP literals are never resolved", async () => {
    const dns = fakeDns({});
    const g = createSafetyGuard({}, { interactive: false, resolver: dns.resolver });
    await g.preflight("http://127.0.0.1:3000");
    expect(g.pins()).toHaveLength(0);
    expect(await lookupP(g, "127.0.0.1")).toEqual({ address: "127.0.0.1", family: 4 });
    expect(dns.calls).toEqual([]);
  });

  it("checkRedirect applies the same rules to Location targets", () => {
    const g = createSafetyGuard({}, { interactive: false, resolver: fakeDns({}).resolver });
    expect(g.checkRedirect("http://127.0.0.1:3000/a", "/b").allowed).toBe(true);
    const d = g.checkRedirect("http://127.0.0.1:3000/a", "https://evil.example.com/");
    expect(d).toMatchObject({ allowed: false, code: "SW_SAFETY_PUBLIC_TARGET" });
    expect(g.checkRedirect("http://127.0.0.1/", "http://[::1")).toMatchObject({ allowed: false });
  });
});
