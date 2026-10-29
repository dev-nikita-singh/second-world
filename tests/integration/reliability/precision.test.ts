/**
 * Precision (false positives): correct-by-design outbound policies must not be flagged.
 * - timeout + capped exponential backoff with FULL jitter + circuit breaker → breaker detected, no defects
 * - full jitter without a breaker → amplification/no-breaker reported, but NOT retry-without-jitter
 */
import { afterEach, describe, expect, it } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { runReliability } from "../../../src/engines/reliability/index.js";
import { type MiniApp, type MiniAppPolicy, startMiniApp } from "./fixtures/mini-app.js";
import { approvedCtx, assertNothingLeft } from "./helpers.js";

let payments: PaymentsFake | undefined;
let proxy: BuiltinFaultProxy | undefined;
let app: MiniApp | undefined;

afterEach(async () => {
  await app?.close();
  await proxy?.close();
  await payments?.close();
});

async function setup(
  policy: Omit<MiniAppPolicy, "dependencyUrl">,
): Promise<{ app: MiniApp; proxy: BuiltinFaultProxy }> {
  payments = await startPaymentsFake();
  proxy = await startFaultProxy({ upstream: payments.url, name: "payments" });
  app = await startMiniApp({ ...policy, dependencyUrl: proxy.url });
  return { app, proxy };
}

const routes = [
  { name: "checkout", path: "/checkout", dependsOn: ["payments"] },
  { name: "browse", path: "/browse", dependsOn: [] },
];

describe("correct-by-design policies are not flagged", () => {
  it("timeout + full-jitter backoff + circuit breaker", async () => {
    const s = await setup({
      timeoutMs: 300,
      maxAttempts: 3,
      backoff: "full-jitter",
      baseMs: 50,
      capMs: 400,
      breaker: { failures: 5, cooldownMs: 1000 },
    });
    const r = await runReliability(
      {
        target: s.app.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 20, routes },
        steady: "2s",
        duration: "5s",
        recovery: "4s",
        seed: 31,
      },
      approvedCtx(),
      { injectors: { payments: s.proxy } },
    );
    const run = r.data?.runs[0];
    expect(run?.breaker?.verdict).toBe("breaker-detected");
    expect(run?.breaker?.probeIntervalMs).not.toBeNull();
    const defects = r.findings.filter((f) => f.severity !== "info").map((f) => f.ruleId);
    expect(defects).toEqual([]);
    expect(run?.isolation.find((i) => i.route === "browse")?.degraded).toBe(false);
    expect(run?.recovery?.recovered).toBe(true);
    await assertNothingLeft(s.proxy);
  }, 30_000);

  it("full jitter without a breaker: no synchronised-retry finding", async () => {
    const s = await setup({ timeoutMs: 300, maxAttempts: 4, backoff: "full-jitter", baseMs: 50, capMs: 800 });
    const r = await runReliability(
      {
        target: s.app.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 20, routes },
        steady: "2s",
        duration: "5s",
        recovery: "3s",
        seed: 32,
      },
      approvedCtx(),
      { injectors: { payments: s.proxy } },
    );
    const rules = r.findings.map((f) => f.ruleId);
    expect(r.data?.runs[0]?.jitter?.detected, JSON.stringify(r.data?.runs[0]?.jitter)).toBe(false);
    expect(rules).not.toContain("reliability/retry-without-jitter");
    expect(rules).toContain("reliability/no-circuit-breaker");
    expect(rules).toContain("reliability/retry-storm");
    await assertNothingLeft(s.proxy);
  }, 30_000);

  it("positive control: constant backoff on the same app is flagged", async () => {
    const s = await setup({ timeoutMs: 300, maxAttempts: 4, backoff: "constant", baseMs: 80 });
    const r = await runReliability(
      {
        target: s.app.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 20, routes },
        steady: "2s",
        duration: "4s",
        recovery: "2s",
        seed: 33,
      },
      approvedCtx(),
      { injectors: { payments: s.proxy } },
    );
    expect(r.findings.map((f) => f.ruleId), JSON.stringify(r.data?.runs[0]?.jitter)).toContain(
      "reliability/retry-without-jitter",
    );
    await assertNothingLeft(s.proxy);
  }, 30_000);
});
