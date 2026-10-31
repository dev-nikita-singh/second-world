import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { createEngineContext } from "../../../src/core/context.js";
import { SafetyError } from "../../../src/core/errors.js";
import { Gcra } from "../../../src/core/safety/gcra.js";
import {
  classifyHost,
  createSafetyGuard,
  hostMatches,
  verifyAuditLog,
} from "../../../src/core/safety/guard.js";

describe("GCRA", () => {
  it("smooth rate: one cell per interval", () => {
    const g = new Gcra({ rate: 10 });
    expect(g.tryTake(0).ok).toBe(true);
    const d = g.tryTake(0);
    expect(d.ok).toBe(false);
    expect(d.retryAfterMs).toBeCloseTo(100, 6);
    expect(g.tryTake(100).ok).toBe(true);
  });
  it("burst allows back-to-back cells then throttles", () => {
    const g = new Gcra({ rate: 10, burst: 5 });
    let ok = 0;
    for (let i = 0; i < 10; i++) if (g.tryTake(0).ok) ok++;
    expect(ok).toBe(5);
    expect(g.tryTake(0, 6).retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });
  it("property: never exceeds burst + rate*window over any window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.double({ min: 0, max: 50, noNaN: true }), { minLength: 1, maxLength: 300 }),
        (rate, burst, gaps) => {
          const g = new Gcra({ rate, burst });
          const accepted: number[] = [];
          let t = 0;
          for (const gap of gaps) {
            t += gap;
            if (g.tryTake(t).ok) accepted.push(t);
          }
          // for every window [accepted[i], accepted[i] + W]
          for (const W of [1, 10, 100, 1000]) {
            let j = 0;
            for (let i = 0; i < accepted.length; i++) {
              while (j < accepted.length && (accepted[j] as number) <= (accepted[i] as number) + W) j++;
              const inWindow = j - i;
              expect(inWindow).toBeLessThanOrEqual(burst + Math.floor((W * rate) / 1000) + 1);
            }
          }
        },
      ),
    );
  });
  it("take() waits on a fake clock", async () => {
    const clock = createFakeClock();
    const g = new Gcra({ rate: 1 });
    await g.take(clock);
    const p = g.take(clock);
    let done = false;
    p.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(1000);
    await p;
    expect(done).toBe(true);
  });
});

describe("classification & host matching", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.5.6.7", "loopback"],
    ["localhost", "loopback"],
    ["api.localhost", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.20.0.1", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "private"],
    ["fd00::1", "private"],
    ["fe80::1", "private"],
    ["host.docker.internal", "private"],
    ["db.internal", "private"],
    ["printer.local", "private"],
    ["myservice", "private"],
    ["8.8.8.8", "public"],
    ["example.com", "public"],
    ["2001:4860::8888", "public"],
    ["bad host!", "invalid"],
  ])("%s → %s", (h, c) => expect(classifyHost(h)).toBe(c));

  it("wildcards, ports, CIDR", () => {
    expect(hostMatches("*.staging.x", "a.staging.x")).toBe(true);
    expect(hostMatches("*.staging.x", "a.b.staging.x")).toBe(true);
    expect(hostMatches("*.staging.x", "staging.x")).toBe(false);
    expect(hostMatches("*.staging.x", "evilstaging.x")).toBe(false);
    expect(hostMatches("API.Example.com", "api.example.com")).toBe(true);
    expect(hostMatches("10.0.0.0/8", "10.9.9.9")).toBe(true);
    expect(hostMatches("10.0.0.0/8", "11.0.0.1")).toBe(false);
    expect(hostMatches("db.internal:5432", "db.internal", "5432")).toBe(true);
    expect(hostMatches("db.internal:5432", "db.internal", "80")).toBe(false);
    expect(hostMatches("::1", "[::1]")).toBe(true);
  });
});

describe("SafetyGuard.checkTarget", () => {
  it("loopback allowed by default; private needs allowHosts", () => {
    const g = createSafetyGuard({}, { interactive: false });
    expect(g.checkTarget(new URL("http://127.0.0.1:3000"))).toEqual({ allowed: true });
    expect(g.checkTarget(new URL("http://localhost:1"))).toEqual({ allowed: true });
    const d = g.checkTarget(new URL("http://10.0.0.5"));
    expect(d.allowed).toBe(false);
    const g2 = createSafetyGuard({ allowHosts: ["*.svc.internal", "10.0.0.0/8"] }, { interactive: false });
    expect(g2.checkTarget(new URL("http://10.0.0.5")).allowed).toBe(true);
    expect(g2.checkTarget(new URL("http://api.svc.internal")).allowed).toBe(true);
  });
  it("public: blocked unless allowHosts + allowPublic + approve", () => {
    const u = new URL("https://api.example.com");
    expect(createSafetyGuard({}, { interactive: false }).checkTarget(u)).toMatchObject({
      allowed: false,
      code: "SW_SAFETY_PUBLIC_TARGET",
    });
    expect(
      createSafetyGuard({ allowHosts: ["api.example.com"] }, { interactive: false }).checkTarget(u),
    ).toMatchObject({
      allowed: false,
      code: "SW_SAFETY_PUBLIC_TARGET",
    });
    expect(
      createSafetyGuard(
        { allowHosts: ["api.example.com"], allowPublic: true },
        { interactive: false },
      ).checkTarget(u),
    ).toMatchObject({ allowed: false, code: "SW_SAFETY_APPROVAL_REQUIRED" });
    expect(
      createSafetyGuard(
        { allowHosts: ["api.example.com"], allowPublic: true },
        { interactive: false, approve: true },
      ).checkTarget(u),
    ).toEqual({ allowed: true });
  });
  it("rejects non-http protocols and assertTarget throws SafetyError (exit 3)", () => {
    const g = createSafetyGuard({}, { interactive: false });
    expect(g.checkTarget(new URL("file:///etc/passwd")).allowed).toBe(false);
    try {
      g.assertTarget("https://example.com");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SafetyError);
      expect((e as SafetyError).exitCode).toBe(3);
      expect((e as SafetyError).hint).toBeTruthy();
    }
  });
  it("preflight prompts interactively for public hosts", async () => {
    const asked: string[] = [];
    const g = createSafetyGuard(
      { allowHosts: ["example.com"], allowPublic: true },
      { interactive: true, confirm: async (m) => (asked.push(m), true) },
    );
    await g.preflight("https://example.com");
    expect(asked).toHaveLength(1);
    expect(g.checkTarget(new URL("https://example.com/x")).allowed).toBe(true);
    const g2 = createSafetyGuard(
      { allowHosts: ["example.com"], allowPublic: true },
      { interactive: true, confirm: async () => false },
    );
    await expect(g2.preflight("https://example.com")).rejects.toBeInstanceOf(SafetyError);
  });
  it("production environment requires approval", async () => {
    const g = createSafetyGuard({ environment: "production" }, { interactive: false });
    expect(g.checkTarget(new URL("http://127.0.0.1")).allowed).toBe(false);
    await expect(g.preflight("http://127.0.0.1")).rejects.toMatchObject({
      code: "SW_SAFETY_APPROVAL_REQUIRED",
    });
    const g2 = createSafetyGuard({ environment: "production" }, { interactive: false, approve: true });
    await g2.preflight("http://127.0.0.1");
  });
});

describe("approvals", () => {
  it("non-interactive without approve → SafetyError; approve flag → ok", async () => {
    await expect(
      createSafetyGuard({}, { interactive: false }).requireApproval("fault-injection", "latency"),
    ).rejects.toMatchObject({ code: "SW_SAFETY_APPROVAL_REQUIRED" });
    await createSafetyGuard({}, { interactive: false, approve: true }).requireApproval(
      "fault-injection",
      "x",
    );
    await createSafetyGuard({ approveDisruptive: true }, { interactive: false }).requireApproval(
      "high-load",
      "x",
    );
  });
  it("interactive decline", async () => {
    const g = createSafetyGuard({}, { interactive: true, confirm: async () => false });
    await expect(g.requireApproval("mutating-requests", "x")).rejects.toMatchObject({
      code: "SW_SAFETY_DECLINED",
    });
  });
});

describe("budgets", () => {
  it("rejects requests above ceilings", () => {
    const g = createSafetyGuard({ maxRps: 100 }, { interactive: false });
    expect(() => g.reserve({ maxRps: 1000 })).toThrow(SafetyError);
  });
  it("lease counts requests (and global cap)", () => {
    const g = createSafetyGuard({ maxRequests: 5 }, { interactive: false });
    const a = g.reserve({ maxRequests: 3 });
    expect(a.take()).toBe(true);
    expect(a.take(2)).toBe(true);
    expect(a.take()).toBe(false);
    expect(a.remaining).toBe(0);
    const b = g.reserve({});
    expect(b.take(2)).toBe(true);
    expect(b.take()).toBe(false);
    a.release();
    expect(a.take()).toBe(false);
  });
  it("lease expires after maxDuration (fake clock)", () => {
    const clock = createFakeClock();
    const g = createSafetyGuard({}, { interactive: false, clock });
    const l = g.reserve({ maxDurationMs: 1000 });
    expect(l.take()).toBe(true);
    clock.advance(1001);
    expect(l.take()).toBe(false);
    expect(l.signal.aborted).toBe(true);
  });
  it("killSwitch aborts leases and parent signal propagates", () => {
    const ac = new AbortController();
    const g = createSafetyGuard({}, { interactive: false, signal: ac.signal });
    const l = g.reserve({});
    ac.abort();
    expect(g.killSwitch.aborted).toBe(true);
    expect(l.take()).toBe(false);
    const g2 = createSafetyGuard({}, { interactive: false });
    g2.kill("test");
    expect(g2.killSwitch.aborted).toBe(true);
    expect(() => g2.reserve({})).toThrow(SafetyError);
  });
  it("throttle enforces maxRps via GCRA", async () => {
    const clock = createFakeClock();
    const g = createSafetyGuard({ maxRps: 10 }, { interactive: false, clock });
    const l = g.reserve({ maxRps: 2 });
    await l.throttle();
    const p = l.throttle();
    let done = false;
    p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(500);
    await p;
  });
});

describe("audit log", () => {
  it("hash-chains entries across guard instances and detects tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-audit-"));
    const file = join(dir, "sub", "audit.log");
    const g = createSafetyGuard({}, { interactive: false, auditFile: file });
    g.audit({ action: "run.started", target: "http://u:secretpw@127.0.0.1", detail: { token: "abc123456" } });
    g.reserve({}).release();
    const g2 = createSafetyGuard({}, { interactive: false, auditFile: file });
    g2.audit({ action: "run.ended" });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("secretpw");
    expect(text).not.toContain("abc123456");
    expect(verifyAuditLog(file)).toEqual({ ok: true, entries: 4 });
    writeFileSync(file, text.replace("run.started", "run.startex"));
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 1 });
  });
});

describe("createEngineContext", () => {
  it("fills test-friendly defaults", () => {
    const ctx = createEngineContext();
    expect(ctx.rng.seed).toBe(1);
    expect(ctx.newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ctx.safety.checkTarget(new URL("http://127.0.0.1:1")).allowed).toBe(true);
    expect(ctx.safety.checkTarget(new URL("https://example.com")).allowed).toBe(false);
    expect(ctx.env.runtime.name).toBe("node");
    expect(ctx.signal.aborted).toBe(false);
  });
  it("respects overrides", () => {
    const clock = createFakeClock(5);
    const ctx = createEngineContext({ clock, seed: 9, config: { a: 1 } });
    expect(ctx.clock.now()).toBe(5);
    expect(ctx.rng.seed).toBe(9);
    expect(ctx.config).toEqual({ a: 1 });
  });
});

describe("IPv4-mapped IPv6 in hex form (sw-coverage wave 5)", () => {
  it("classifies [::ffff:7f00:1] like 127.0.0.1 and ::ffff:a00:1 like 10.0.0.1", async () => {
    const { classifyHost: c } = await import("../../../src/core/safety/guard.js");
    expect(c(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe("loopback");
    expect(c("::ffff:a00:1")).toBe("private");
    expect(c("::ffff:a9fe:a9fe")).toBe("private"); // 169.254.169.254
    expect(c("::ffff:808:808")).toBe("public");
  });
});
