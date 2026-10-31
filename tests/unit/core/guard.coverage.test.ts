/**
 * Coverage + adversarial tests for the Safety Guard (docs/11-safety-security-privacy.md §1–3).
 * Owner: sw-coverage (Wave 5). Targets branches the main safety tests leave uncovered:
 * classification edges, allow-list matching, audit chain recovery, approvals, budgets,
 * DNS pinning error paths and redirect escapes.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { SafetyError, TargetError } from "../../../src/core/errors.js";
import {
  classifyHost,
  createSafetyGuard,
  hostMatches,
  type ResolvedAddress,
  verifyAuditLog,
} from "../../../src/core/safety/guard.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sw-guard-cov-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dns(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolver = async (host: string): Promise<ResolvedAddress[]> => {
    calls.push(host);
    const l = table[host];
    if (!l) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return l.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { calls, resolver, table };
}

type LookupCb = (e: (Error & { code?: string }) | null, a: unknown, f?: number) => void;
function lookupP(g: ReturnType<typeof createSafetyGuard>, host: string, opts?: unknown) {
  return new Promise<{ address: unknown; family?: number }>((resolve, reject) => {
    const cb: LookupCb = (err, address, family) => (err ? reject(err) : resolve({ address, family }));
    const fn = g.lookup as unknown as (h: string, o: unknown, c?: LookupCb) => void;
    if (opts === undefined) fn(host, cb);
    else fn(host, opts, cb);
  });
}

const octet = fc.integer({ min: 0, max: 255 });

describe("classifyHost — properties", () => {
  it("127/8 is loopback, RFC1918 + link-local + CGNAT are private", () => {
    fc.assert(
      fc.property(octet, octet, octet, (a, b, c) => {
        expect(classifyHost(`127.${a}.${b}.${c}`)).toBe("loopback");
        expect(classifyHost(`10.${a}.${b}.${c}`)).toBe("private");
        expect(classifyHost(`192.168.${b}.${c}`)).toBe("private");
        expect(classifyHost(`169.254.${b}.${c}`)).toBe("private");
        expect(classifyHost(`172.${16 + (a % 16)}.${b}.${c}`)).toBe("private");
        expect(classifyHost(`100.${64 + (a % 64)}.${b}.${c}`)).toBe("private");
      }),
    );
  });

  it("addresses just outside the private ranges are public", () => {
    for (const h of [
      "172.15.255.255",
      "172.32.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "11.0.0.0",
      "192.169.0.1",
      "8.8.8.8",
    ]) {
      expect(classifyHost(h), h).toBe("public");
    }
  });

  it("the dotted IPv4-mapped IPv6 form classifies like the IPv4 address", () => {
    fc.assert(
      fc.property(octet, octet, octet, (a, b, c) => {
        expect(classifyHost(`::ffff:10.${a}.${b}.${c}`)).toBe("private");
        expect(classifyHost(`[::ffff:127.${a}.${b}.${c}]`)).toBe("loopback");
      }),
    );
  });

  // Regression (sw-coverage bug report, fixed by main): WHATWG URL normalises [::ffff:127.0.0.1] to [::ffff:7f00:1]; classifyHost only
  // recognises the dotted mapped form (src/core/safety/guard.ts:177), so URL hostnames of mapped
  // loopback/private addresses classify as "public" (fails closed, but blocks/mislabels valid targets
  // and makes DNS answers in hex-mapped form look public).
  it("URL-normalised (hex) IPv4-mapped IPv6 hostnames classify like the IPv4 address", () => {
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    expect(classifyHost(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe("loopback");
    expect(classifyHost("::ffff:a00:1")).toBe("private");
  });

  it("names, IPv6 ranges and invalid input", () => {
    expect(classifyHost("")).toBe("invalid");
    expect(classifyHost("bad host")).toBe("invalid");
    expect(classifyHost("evil$.com")).toBe("invalid");
    expect(classifyHost("LOCALHOST.")).toBe("loopback");
    expect(classifyHost("api.localhost")).toBe("loopback");
    expect(classifyHost("localhost.evil.com")).toBe("public");
    expect(classifyHost("0.0.0.0")).toBe("loopback");
    expect(classifyHost("::")).toBe("loopback");
    expect(classifyHost("[::1]")).toBe("loopback");
    expect(classifyHost("fd12:3456::1")).toBe("private");
    expect(classifyHost("fe80::1%eth0")).toBe("private");
    expect(classifyHost("2001:db8::1")).toBe("public");
    expect(classifyHost("host.docker.internal")).toBe("private");
    expect(classifyHost("printer.lan")).toBe("private");
    expect(classifyHost("nas.home.arpa")).toBe("private");
    expect(classifyHost("intranet")).toBe("private");
    expect(classifyHost("example.com")).toBe("public");
  });

  it("numeric / hex host encodings are normalised by URL before classification", () => {
    // SSRF classics: decimal, hex and short forms of 127.0.0.1 / 10.0.0.1
    expect(classifyHost(new URL("http://2130706433/").hostname)).toBe("loopback");
    expect(classifyHost(new URL("http://0x7f.1/").hostname)).toBe("loopback");
    expect(classifyHost(new URL("http://167772161/").hostname)).toBe("private");
    expect(classifyHost(new URL("http://0xa000001/").hostname)).toBe("private");
  });
});

describe("hostMatches", () => {
  it("wildcards match subdomains but never the apex or look-alike suffixes", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), (label) => {
        expect(hostMatches("*.staging.x", `${label}.staging.x`)).toBe(true);
        expect(hostMatches("*.staging.x", `${label}staging.x`)).toBe(false);
        expect(hostMatches("*.staging.x", `${label}.staging.x.evil.com`)).toBe(false);
      }),
    );
    expect(hostMatches("*.staging.x", "staging.x")).toBe(false);
    expect(hostMatches("*", "anything.example")).toBe(true);
  });

  it("host:port requires a port and the exact port", () => {
    expect(hostMatches("api.internal:8080", "api.internal", "8080")).toBe(true);
    expect(hostMatches("api.internal:8080", "api.internal", "8081")).toBe(false);
    expect(hostMatches("api.internal:8080", "api.internal")).toBe(false);
    expect(hostMatches("API.Internal", "api.internal.", "80")).toBe(true);
    expect(hostMatches("[::1]", "[::1]")).toBe(true);
    expect(hostMatches("::1", "::1", "80")).toBe(true);
  });

  it("CIDR: membership property, invalid bases and prefix lengths", () => {
    fc.assert(
      fc.property(octet, octet, octet, octet, (a, b, c, d) => {
        expect(hostMatches("10.0.0.0/8", `10.${b}.${c}.${d}`)).toBe(true);
        expect(hostMatches("10.0.0.0/8", `${a === 10 ? 11 : a}.${b}.${c}.${d}`)).toBe(false);
        expect(hostMatches("0.0.0.0/0", `${a}.${b}.${c}.${d}`)).toBe(true);
        expect(hostMatches(`${a}.${b}.${c}.${d}/32`, `${a}.${b}.${c}.${d}`)).toBe(true);
      }),
    );
    expect(hostMatches("10.0.0.0/33", "10.0.0.1")).toBe(false);
    expect(hostMatches("999.0.0.0/8", "10.0.0.1")).toBe(false);
    expect(hostMatches("10.0.0.0/8", "ten.example")).toBe(false);
    expect(hostMatches("10.0.0.0/8", "10.0.0")).toBe(false);
    expect(hostMatches("10.0.0.0/8", "10.0.0.256")).toBe(false);
    expect(hostMatches("10.0.0.0/8", "10.0.x.1")).toBe(false);
  });
});

describe("audit chain", () => {
  it("continues the hash chain of an existing log file across guard instances", () => {
    const file = join(tmp(), "nested", "audit.log");
    const g1 = createSafetyGuard({}, { interactive: false, auditFile: file });
    g1.audit({ action: "one" });
    g1.audit({ action: "two" });
    const g2 = createSafetyGuard({}, { interactive: false, auditFile: file });
    g2.audit({ action: "three" });
    expect(g2.auditEntries()[0]?.seq).toBe(3);
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 3 });
  });

  it("detects tampering and garbage lines; empty logs are valid", () => {
    const d = tmp();
    const file = join(d, "audit.log");
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "a", detail: { n: 1 } });
    g.audit({ action: "b" });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${lines[0]?.replace('"n":1', '"n":2')}\n${lines[1]}\n`);
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 1 });
    writeFileSync(file, `${lines[0]}\nnot json\n`);
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 2, entries: 2 });
    const empty = join(d, "empty.log");
    writeFileSync(empty, "\n");
    expect(verifyAuditLog(empty)).toEqual({ ok: true, entries: 0 });
  });

  it("a corrupt last line restarts the chain at genesis instead of crashing", () => {
    const file = join(tmp(), "audit.log");
    writeFileSync(file, "{broken\n");
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "x" });
    expect(g.auditEntries()[0]?.seq).toBe(1);
    expect(g.auditEntries()[0]?.prevHash).toBe("0".repeat(64));
  });

  it("an unwritable audit path never crashes the run (entry kept in memory)", () => {
    const d = tmp();
    const g = createSafetyGuard({}, { interactive: false, auditFile: d /* a directory */ });
    expect(() => g.audit({ action: "x" })).not.toThrow();
    expect(g.auditEntries()).toHaveLength(1);
  });

  it("records the CI job and redacts secrets in targets and details", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "o/r");
    vi.stubEnv("GITHUB_RUN_ID", "42");
    const file = join(tmp(), "audit.log");
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    expect(() => g.assertTarget("http://admin:hunter2pass@evil.example.com/x")).toThrow(SafetyError);
    g.audit({ action: "custom", detail: { password: "p4ssw0rd!", header: "Bearer abcdefghijklmnop" } });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("hunter2pass");
    expect(text).not.toContain("p4ssw0rd!");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(g.auditEntries()[0]?.ci).toBe("github:o/r#42");
  });

  it("gitlab and generic CI markers", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "1");
    vi.stubEnv("CI_PROJECT_PATH", "g/p");
    vi.stubEnv("CI_JOB_ID", "7");
    const g = createSafetyGuard();
    g.audit({ action: "x" });
    expect(g.auditEntries()[0]?.ci).toBe("gitlab:g/p#7");
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("CI", "true");
    const g2 = createSafetyGuard();
    g2.audit({ action: "x" });
    expect(g2.auditEntries()[0]?.ci).toBe("ci");
  });

  it("keeps at most 1000 entries in memory", () => {
    const g = createSafetyGuard();
    for (let i = 0; i < 1005; i++) g.audit({ action: `a${i}` });
    expect(g.auditEntries()).toHaveLength(1000);
    expect(g.auditEntries()[0]?.action).toBe("a5");
  });
});

describe("target checks", () => {
  it("rejects invalid URLs, non-http protocols and invalid hosts", () => {
    const g = createSafetyGuard();
    expect(g.checkTarget("::nope" as unknown as URL)).toMatchObject({
      allowed: false,
      code: "SW_SAFETY_INVALID_URL",
    });
    for (const u of [
      "file:///etc/passwd",
      "ftp://127.0.0.1/",
      "gopher://127.0.0.1:70/",
      "javascript:alert(1)",
      "data:text/plain,x",
    ]) {
      expect(g.checkTarget(new URL(u)), u).toMatchObject({ allowed: false, code: "SW_SAFETY_PROTOCOL" });
    }
    expect(() => g.assertTarget("not a url")).toThrow(/Invalid URL/);
    expect(g.checkTarget(new URL("ws://127.0.0.1:1/"))).toEqual({ allowed: true });
  });

  it("kill switch blocks every target; kill is idempotent and parent signals propagate", () => {
    const g = createSafetyGuard();
    g.kill(new Error("stop"));
    g.kill("again");
    expect(g.checkTarget(new URL("http://127.0.0.1/"))).toMatchObject({ code: "SW_SAFETY_KILLED" });
    expect(g.auditEntries().filter((e) => e.action === "kill-switch")).toHaveLength(1);
    expect(() => g.reserve({})).toThrow(/Kill switch/);
    const parent = new AbortController();
    const g2 = createSafetyGuard({}, { interactive: false, signal: parent.signal });
    parent.abort();
    expect(g2.killSwitch.aborted).toBe(true);
    const g3 = createSafetyGuard();
    g3.kill();
    expect(g3.killSwitch.reason).toBeInstanceOf(SafetyError);
  });

  it("production environment requires explicit approval even for loopback", async () => {
    const g = createSafetyGuard({ environment: "production" });
    expect(g.checkTarget(new URL("http://127.0.0.1/"))).toMatchObject({ code: "SW_SAFETY_PRODUCTION" });
    await expect(g.preflight("http://127.0.0.1/")).rejects.toMatchObject({
      code: "SW_SAFETY_APPROVAL_REQUIRED",
    });
    // approveDisruptive in config does NOT approve production targets
    const g2 = createSafetyGuard({ environment: "production", approveDisruptive: true });
    await expect(g2.requireApproval("production-target", "")).rejects.toBeInstanceOf(SafetyError);
    const g3 = createSafetyGuard({ environment: "production" }, { interactive: false, approve: true });
    await g3.preflight("http://127.0.0.1/");
    const g4 = createSafetyGuard(
      { environment: "production" },
      { interactive: true, confirm: async () => true },
    );
    await g4.preflight("http://127.0.0.1/");
    expect(g4.checkTarget(new URL("http://127.0.0.1/"))).toEqual({ allowed: true });
  });

  it("public targets: listed without allowPublic, approval required, interactive confirm and decline", async () => {
    const r = dns({ "api.example.com": ["93.184.216.34"] });
    const g = createSafetyGuard(
      { allowHosts: ["api.example.com"] },
      { interactive: false, resolver: r.resolver },
    );
    expect(g.checkTarget(new URL("https://api.example.com/"))).toMatchObject({
      code: "SW_SAFETY_PUBLIC_TARGET",
    });
    const g2 = createSafetyGuard(
      { allowHosts: ["api.example.com"], allowPublic: true },
      { interactive: false, resolver: r.resolver },
    );
    await expect(g2.preflight("https://api.example.com/")).rejects.toMatchObject({
      code: "SW_SAFETY_APPROVAL_REQUIRED",
    });
    const asked: string[] = [];
    const g3 = createSafetyGuard(
      { allowHosts: ["api.example.com"], allowPublic: true },
      { interactive: true, resolver: r.resolver, confirm: async (m) => (asked.push(m), true) },
    );
    await g3.preflight("https://api.example.com/");
    expect(asked[0]).toMatch(/PUBLIC host api\.example\.com/);
    expect(g3.checkTarget(new URL("https://API.example.com/x"))).toEqual({ allowed: true });
    expect(g3.pins()[0]?.cls).toBe("public");
    const g4 = createSafetyGuard(
      { allowHosts: ["api.example.com"], allowPublic: true },
      { interactive: true, resolver: r.resolver, confirm: async () => false },
    );
    await expect(g4.preflight("https://api.example.com/")).rejects.toMatchObject({
      code: "SW_SAFETY_APPROVAL_REQUIRED",
    });
  });

  it("private hosts not listed get a wildcard hint", () => {
    const g = createSafetyGuard();
    const d = g.checkTarget(new URL("http://db.svc.internal/"));
    expect(d).toMatchObject({ allowed: false, code: "SW_SAFETY_HOST_NOT_ALLOWED" });
    expect((d as { hint?: string }).hint).toContain("*.svc.internal");
    expect((g.checkTarget(new URL("http://intranet/")) as { hint?: string }).hint).toContain('"intranet"');
  });
});

describe("approvals", () => {
  it("non-interactive without approval throws and audits; config approves disruptive actions once", async () => {
    const g = createSafetyGuard();
    await expect(g.requireApproval("fault-injection", "latency 200ms")).rejects.toThrow(/latency 200ms/);
    expect(g.auditEntries().at(-1)?.action).toBe("approval.missing");
    const g2 = createSafetyGuard({ approveDisruptive: true });
    await g2.requireApproval("fault-injection", "");
    await g2.requireApproval("fault-injection", "");
    expect(g2.auditEntries().filter((e) => e.action === "approval.granted")).toHaveLength(1);
    expect(g2.auditEntries()[0]?.detail).toMatchObject({ source: "config" });
  });

  it("interactive prompt: declined throws SW_SAFETY_DECLINED, accepted is cached", async () => {
    let n = 0;
    const no = createSafetyGuard({}, { interactive: true, confirm: async () => (n++, false) });
    await expect(no.requireApproval("fault-injection", "")).rejects.toMatchObject({
      code: "SW_SAFETY_DECLINED",
    });
    const yes = createSafetyGuard({}, { interactive: true, confirm: async () => (n++, true) });
    await yes.requireApproval("fault-injection", "d");
    await yes.requireApproval("fault-injection", "d");
    expect(n).toBe(2);
    expect(yes.auditEntries().at(-1)?.detail).toMatchObject({ source: "interactive" });
  });

  it("interactive without a TTY or confirm hook cannot prompt", async () => {
    const g = createSafetyGuard({}, { interactive: true });
    await expect(g.requireApproval("fault-injection", "")).rejects.toMatchObject({
      code: "SW_SAFETY_APPROVAL_REQUIRED",
    });
  });
});

describe("budgets", () => {
  it("rejects every over-limit dimension in one error", () => {
    const g = createSafetyGuard({ maxRps: 10, maxConcurrency: 2, maxRequests: 5, maxDurationMs: 1000 });
    try {
      g.reserve({ maxRps: 11, maxConcurrency: 3, maxRequests: 6, maxDurationMs: 1001 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SafetyError);
      expect((e as SafetyError).details?.over).toHaveLength(4);
    }
    expect(g.auditEntries().at(-1)?.action).toBe("budget.rejected");
  });

  it("request counts are capped per lease and globally; release is idempotent", () => {
    const clock = createFakeClock();
    const g = createSafetyGuard({ maxRequests: 5 }, { interactive: false, clock });
    const a = g.reserve({ maxRequests: 4 });
    const b = g.reserve({ maxRequests: 4 });
    expect(a.take(3)).toBe(true);
    expect(a.take(2)).toBe(false);
    expect(b.remaining).toBe(2);
    expect(b.take(2)).toBe(true);
    expect(b.take()).toBe(false);
    expect(a.remaining).toBe(0);
    a.release();
    a.release();
    expect(a.take()).toBe(false);
    expect(a.signal.aborted).toBe(true);
    expect(g.auditEntries().filter((e) => e.action === "budget.released")).toHaveLength(1);
  });

  it("maxDuration elapsing on the injected clock aborts the lease", () => {
    const clock = createFakeClock();
    const g = createSafetyGuard({ maxDurationMs: 1000 }, { interactive: false, clock });
    const l = g.reserve({ maxDurationMs: 500 });
    expect(l.take()).toBe(true);
    clock.advance(501);
    expect(l.take()).toBe(false);
    expect(l.signal.aborted).toBe(true);
    expect(l.signal.reason).toBeInstanceOf(SafetyError);
  });

  it("without a clock the duration timer is armed and cleared on release", () => {
    const g = createSafetyGuard({ maxDurationMs: 60_000 });
    const l = g.reserve({ maxDurationMs: 10_000 });
    l.release();
    expect(l.signal.aborted).toBe(true);
  });

  it("throttle: no limiter when rate is not positive; limiter respects the lease signal", async () => {
    const clock = createFakeClock();
    const g = createSafetyGuard({}, { interactive: false, clock });
    const free = g.reserve({ maxRps: 0 });
    expect(await free.throttle()).toBe(false);
    const l = g.reserve({ maxRps: 10 });
    expect(await l.throttle()).toBe(false); // burst 1 → first token immediate
    const ac = new AbortController();
    ac.abort(new Error("cancel"));
    await expect(l.throttle(ac.signal)).rejects.toThrow("cancel");
  });
});

describe("DNS pinning error paths", () => {
  it("empty resolution → TargetError; concurrent pins share one resolution", async () => {
    const r = dns({ "a.internal": [], "b.internal": ["10.0.0.2"] });
    const g = createSafetyGuard({ allowHosts: ["*.internal"] }, { interactive: false, resolver: r.resolver });
    await expect(g.pinHost("http://a.internal")).rejects.toBeInstanceOf(TargetError);
    const [p1, p2] = await Promise.all([
      g.pinHost("http://b.internal"),
      g.pinHost(new URL("http://B.internal")),
    ]);
    expect(p1).toBe(p2);
    expect(r.calls.filter((h) => h === "b.internal")).toHaveLength(1);
    expect(await g.pinHost("http://[::1]:80/")).toBeNull();
    await expect(g.pinHost("::bad")).rejects.toMatchObject({ code: "SW_SAFETY_INVALID_URL" });
  });

  it("private name whose addresses are all CIDR-listed may resolve to public IPs", async () => {
    const r = dns({ myservice: ["8.8.8.8"] });
    const g = createSafetyGuard(
      { allowHosts: ["myservice", "8.8.8.0/24"], allowPublic: true },
      { interactive: false, approve: true, resolver: r.resolver },
    );
    const pin = await g.pinHost("http://myservice/");
    expect(pin?.cls).toBe("public");
  });

  it("DNS rebinding of a listed private name to a public IP is blocked at pin time with an audit entry", async () => {
    const r = dns({ "app.internal": ["10.0.0.1", "93.184.216.34"] });
    const g = createSafetyGuard(
      { allowHosts: ["app.internal"] },
      { interactive: false, resolver: r.resolver },
    );
    await expect(g.preflight("http://app.internal/")).rejects.toMatchObject({ code: "SW_SAFETY_DNS_CLASS" });
    expect(
      g.auditEntries().some((e) => e.action === "safety.blocked" && e.detail?.code === "SW_SAFETY_DNS_CLASS"),
    ).toBe(true);
    expect(g.pins()).toHaveLength(0);
  });

  it("lookup: two-arg form, string family, family mismatch, resolver failure, IP literal with all", async () => {
    const r = dns({ "v4.internal": ["10.0.0.9"] });
    const g = createSafetyGuard({ allowHosts: ["*.internal"] }, { interactive: false, resolver: r.resolver });
    expect(await lookupP(g, "v4.internal")).toEqual({ address: "10.0.0.9", family: 4 });
    expect(await lookupP(g, "v4.internal", { family: "IPv4" })).toEqual({ address: "10.0.0.9", family: 4 });
    await expect(lookupP(g, "v4.internal", { family: "IPv6" })).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(lookupP(g, "v4.internal", { family: 6, all: true })).rejects.toThrow(
      /no IPv6 address pinned/,
    );
    await expect(lookupP(g, "missing.internal")).rejects.toMatchObject({ code: "SW_TARGET_DNS" });
    expect(await lookupP(g, "10.1.1.1", { all: true })).toEqual({
      address: [{ address: "10.1.1.1", family: 4 }],
      family: undefined,
    });
    await expect(lookupP(g, "pub.example.org", { all: true })).rejects.toMatchObject({
      code: "SW_SAFETY_PUBLIC_TARGET",
    });
  });

  it("recheckDns: unknown host is a no-op; transient resolver failure keeps the pin", async () => {
    const r = dns({ "x.internal": ["10.0.0.1"] });
    const g = createSafetyGuard({ allowHosts: ["x.internal"] }, { interactive: false, resolver: r.resolver });
    await g.recheckDns("never-pinned.internal");
    await g.pinHost("http://x.internal");
    delete r.table["x.internal"];
    await g.recheckDns("X.internal");
    expect(g.killSwitch.aborted).toBe(false);
    // public → private rebinding on a public name pinned with approval
    const r2 = dns({ "pub.example.com": ["93.184.216.34"] });
    const g2 = createSafetyGuard(
      { allowHosts: ["pub.example.com"], allowPublic: true },
      { interactive: false, approve: true, resolver: r2.resolver },
    );
    await g2.preflight("https://pub.example.com");
    r2.table["pub.example.com"] = ["169.254.169.254"];
    await expect(g2.recheckDns("pub.example.com")).rejects.toMatchObject({ code: "SW_SAFETY_DNS_REBIND" });
    expect(g2.killSwitch.aborted).toBe(true);
    // a second rebind after the kill does not re-abort
    await expect(g2.recheckDns("pub.example.com")).rejects.toMatchObject({ code: "SW_SAFETY_DNS_REBIND" });
  });
});

describe("redirect escapes", () => {
  const g = createSafetyGuard({ allowHosts: ["api.internal"] });
  const from = "http://127.0.0.1:3000/login";

  it.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/", "SW_SAFETY_HOST_NOT_ALLOWED"],
    ["decimal-encoded private IP", "http://167772161/", "SW_SAFETY_HOST_NOT_ALLOWED"],
    ["protocol-relative public host", "//evil.example.com/x", "SW_SAFETY_PUBLIC_TARGET"],
    ["file scheme", "file:///etc/passwd", "SW_SAFETY_PROTOCOL"],
    ["localhost look-alike", "http://localhost.evil.com/", "SW_SAFETY_PUBLIC_TARGET"],
    ["unlisted private DNS name", "http://db.internal/", "SW_SAFETY_HOST_NOT_ALLOWED"],
  ])("blocks a redirect to %s", (_n, location, code) => {
    const d = g.checkRedirect(from, location);
    expect(d).toMatchObject({ allowed: false, code });
    expect((d as { reason?: string }).reason).toMatch(/^Redirect to .* blocked: /);
  });

  it("allows relative and listed redirects; never audits redirect credentials", () => {
    expect(g.checkRedirect(new URL(from), "../x?y=1")).toEqual({ allowed: true });
    expect(g.checkRedirect(from, "http://api.internal/next")).toEqual({ allowed: true });
    const d = g.checkRedirect(from, "http://user:t0psecretpw@169.254.169.254/");
    expect(d.allowed).toBe(false);
    expect(JSON.stringify(g.auditEntries())).not.toContain("t0psecretpw");
    expect((d as { reason?: string }).reason).not.toContain("t0psecretpw");
  });
});

describe("misc", () => {
  it("config merges defaults, ignoring undefined overrides", () => {
    const g = createSafetyGuard({ maxRps: undefined, allowHosts: ["x.internal"] });
    expect(g.config.maxRps).toBe(2000);
    expect(g.classify("x.internal")).toBe("private");
    expect(g.checkTarget(new URL("http://localhost:1/"))).toEqual({ allowed: true });
  });

  it("appendFileSync failure after the directory exists is swallowed", () => {
    const d = tmp();
    const file = join(d, "a.log");
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "ok" });
    appendFileSync(file, "");
    rmSync(d, { recursive: true, force: true });
    expect(() => g.audit({ action: "after-delete" })).not.toThrow();
  });
});
