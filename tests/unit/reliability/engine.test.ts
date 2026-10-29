import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { pendingGlobalCleanups } from "../../../src/adapters/faults/cleanup.js";
import { ConfigError, SafetyError } from "../../../src/core/errors.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { listScenarios, runReliability } from "../../../src/engines/reliability/index.js";
import { type MiniApp, startMiniApp } from "../../integration/reliability/fixtures/mini-app.js";

const approved = () => ({ safety: createSafetyGuard({}, { interactive: false, approve: true }) });

describe("safety and configuration", () => {
  const base = {
    target: "http://127.0.0.1:1/checkout",
    scenario: "dependency-5xx",
    dependency: "payments",
    dependencies: { payments: { upstream: "http://127.0.0.1:2" } },
  };

  it("requires approval for fault injection (non-interactive without approve → SafetyError)", async () => {
    const e = await runReliability(base).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SafetyError);
    expect((e as SafetyError).code).toBe("SW_SAFETY_APPROVAL_REQUIRED");
  });

  it("blocks production by default, even when approved", async () => {
    const e = await runReliability({ ...base, environment: "production" }, approved()).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SafetyError);
    expect((e as SafetyError).code).toBe("SW_SAFETY_PRODUCTION_FAULTS");
    const viaGuard = await runReliability(base, {
      safety: createSafetyGuard({ environment: "production" }, { interactive: false, approve: true }),
    }).catch((x: unknown) => x);
    expect((viaGuard as SafetyError).code).toBe("SW_SAFETY_PRODUCTION_FAULTS");
  });

  it("rejects public targets, unknown scenarios and over-long experiments", async () => {
    await expect(
      runReliability({ ...base, target: "http://example.com/" }, approved()),
    ).rejects.toBeInstanceOf(SafetyError);
    await expect(runReliability({ ...base, scenario: "nope" }, approved())).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(runReliability({ ...base, duration: "20m" }, approved())).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(runReliability({ ...base, target: "not a url" }, approved())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("reports 'requires adapter' as a limitation instead of injecting", async () => {
    const r = await runReliability({ ...base, scenario: "db-unavailable" }, approved());
    expect(r.status).toBe("skipped");
    expect(r.limitations.map((l) => l.code)).toContain("requires-adapter");
  });

  it("lists the scenario catalogue", () => {
    const ids = listScenarios().map((s) => s.id);
    for (const id of [
      "dependency-latency",
      "dependency-timeout",
      "dependency-5xx",
      "dependency-reset",
      "restart-dependency",
      "flapping-dependency",
      "partial-failure",
      "slow-network",
      "db-unavailable",
      "cache-unavailable",
    ])
      expect(ids).toContain(id);
  });
});

describe("experiment runner (mini app + payments-fake behind the built-in proxy)", () => {
  let payments: PaymentsFake;
  let proxy: BuiltinFaultProxy;
  let app: MiniApp;

  beforeEach(async () => {
    payments = await startPaymentsFake();
    proxy = await startFaultProxy({ upstream: payments.url, name: "payments" });
    app = await startMiniApp({ dependencyUrl: proxy.url, timeoutMs: 500, maxAttempts: 1 });
  });
  afterEach(async () => {
    await app.close();
    await proxy.close();
    await payments.close();
  });

  const input = (over: Record<string, unknown> = {}) => ({
    target: app.url,
    scenario: "dependency-5xx",
    dependency: "payments",
    workload: {
      rate: 20,
      routes: [
        { name: "checkout", path: "/checkout", dependsOn: ["payments"] },
        { name: "browse", path: "/browse", dependsOn: [] },
      ],
    },
    steady: "1s",
    duration: "1500ms",
    recovery: "1500ms",
    seed: 3,
    ...over,
  });

  it("measures the fault, evaluates the hypothesis and recovers; the fault is reverted", async () => {
    const r = await runReliability(
      input({
        recovery: "3500ms",
        hypothesis: ["scenario.browse.error_rate<1%", "scenario.checkout.error_rate<5%"],
      }),
      approved(),
      {
        injectors: { payments: proxy },
      },
    );
    const d = r.data;
    expect(d).toBeDefined();
    const run = d?.runs[0];
    expect(run?.steadyOk).toBe(true);
    expect(run?.fault.applied).toBe(true);
    expect(run?.during.errorRate).toBeGreaterThan(0.3);
    expect(d?.verdict).toBe("violated");
    const browse = run?.checks.find((c) => c.expression.includes("browse"));
    expect(browse?.passed).toBe(true);
    expect(run?.recovery?.recovered).toBe(true);
    expect(r.findings.some((f) => f.classification === "threshold-breach")).toBe(true);
    expect(r.findings.some((f) => f.ruleId === "reliability/experiment")).toBe(true);
    expect(proxy.active()).toEqual([]);
    expect(pendingGlobalCleanups().filter((n) => n.startsWith("reliability:"))).toEqual([]);
  });

  it("reverts the fault when the run throws mid-fault", async () => {
    const e = await runReliability(input(), approved(), {
      injectors: { payments: proxy },
      onPhase: (phase) => {
        if (phase === "fault-applied") {
          expect(proxy.active()).toHaveLength(1);
          throw new Error("injected crash");
        }
      },
    }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("injected crash");
    expect(proxy.active()).toEqual([]);
    expect(pendingGlobalCleanups().filter((n) => n.startsWith("reliability:"))).toEqual([]);
  });

  it("reverts the fault on abort (cancelled result)", async () => {
    const ac = new AbortController();
    const r = await runReliability(
      input(),
      { ...approved(), signal: ac.signal },
      {
        injectors: { payments: proxy },
        onPhase: (phase) => {
          if (phase === "fault-applied") setTimeout(() => ac.abort(), 200);
        },
      },
    );
    expect(r.status).toBe("cancelled");
    expect(proxy.active()).toEqual([]);
  });

  it("abort condition reverts early", async () => {
    const r = await runReliability(
      input({ duration: "3s", abort: { errorRate: "20%", graceMs: 300 } }),
      approved(),
      {
        injectors: { payments: proxy },
      },
    );
    const run = r.data?.runs[0];
    expect(run?.fault.abortedEarly).toMatch(/abort threshold/);
    expect(run?.fault.durationMs).toBeLessThan(2500);
    expect(proxy.active()).toEqual([]);
  });

  it("does not inject when the steady state is not met", async () => {
    const r = await runReliability(input({ steadyState: ["p95<0.001ms"] }), approved(), {
      injectors: { payments: proxy },
    });
    expect(r.status).toBe("failed");
    expect(r.data?.verdict).toBe("inconclusive");
    expect(r.data?.runs[0]?.fault.applied).toBe(false);
    expect(r.findings[0]?.ruleId).toBe("reliability/steady-state-not-met");
    expect(proxy.stats().injected).toEqual({});
  });

  it("starts and closes its own proxy from config (dependencies.<name>.upstream)", async () => {
    const r = await runReliability(
      {
        target: app.url,
        scenario: "dependency-latency",
        dependency: "payments",
        dependencies: { payments: { upstream: payments.url } },
        workload: { rate: 10, routes: [{ name: "browse", path: "/browse" }] },
        steady: "500ms",
        duration: "500ms",
        recovery: "500ms",
      },
      approved(),
    );
    expect(r.data?.injector).toBe("builtin-proxy");
    const own = pendingGlobalCleanups().filter(
      (n) => n.startsWith("builtin-proxy:payments") && !n.endsWith(`:${proxy.port}`),
    );
    expect(own).toEqual([]);
  });
});
