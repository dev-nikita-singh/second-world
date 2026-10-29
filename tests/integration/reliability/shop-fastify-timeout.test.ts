/**
 * Precision: shop-fastify's `outbound-timeout` is correct by design (AbortSignal.timeout(2000) per
 * attempt, 4 attempts) → a black-holed payments must NOT yield reliability/outbound-no-timeout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReliability } from "../../../src/engines/reliability/index.js";
import {
  approvedCtx,
  assertNothingLeft,
  fastifyOrders,
  type ShopBehindProxy,
  startShopBehindProxy,
} from "./helpers.js";

describe("shop-fastify: dependency-timeout (correct by design)", () => {
  let shop: ShopBehindProxy;
  beforeEach(async () => {
    shop = await startShopBehindProxy("shop-fastify");
  });
  afterEach(async () => {
    await shop.close();
  });

  it("recognises the outbound timeout and does not flag it", async () => {
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-timeout",
        dependency: "payments",
        workload: { rate: 4, routes: [fastifyOrders], timeout: "20s" },
        steady: "2s",
        duration: "11s",
        recovery: "3s",
        seed: 21,
        // 4 attempts × 2 s timeout + 3 × 50 ms delays
        expectTimeout: "8150ms",
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    const run = r.data?.runs[0];
    expect(run?.timeout?.verdict).toBe("timeout");
    expect(run?.timeout?.effectiveTimeoutMs).toBeGreaterThan(7500);
    expect(run?.timeout?.effectiveTimeoutMs).toBeLessThan(9500);
    const rules = r.findings.map((f) => f.ruleId);
    expect(rules).not.toContain("reliability/outbound-no-timeout");
    expect(rules).not.toContain("reliability/timeout-mismatch");
    await assertNothingLeft(shop.proxy);
  }, 40_000);

  it("short observable window (client gives up after 1 s, 2 runs): inconclusive + limitation, never a defect", async () => {
    // sw-examples repro: workload.timeout 1s, duration 5s, repeat 2 used to give a reproduced-defect
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-timeout",
        dependency: "payments",
        workload: { rate: 4, routes: [fastifyOrders], timeout: "1s" },
        steady: "1500ms",
        duration: "3s",
        recovery: "2s",
        repeat: 2,
        seed: 22,
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    for (const run of r.data?.runs ?? []) {
      expect(run.timeout?.verdict).toBe("inconclusive");
      expect(run.timeout?.windowTooShort).toBe(true);
    }
    expect(r.findings.map((f) => f.ruleId)).not.toContain("reliability/outbound-no-timeout");
    const lim = r.limitations.find((l) => l.code === "timeout-window-too-short");
    expect(lim?.message).toMatch(/client timeout 1000 ms, fault 3000 ms\) < maxOutboundBudget 30000 ms/);
    expect(lim?.message).toMatch(/Raise workload.timeout and the fault duration/);
    await assertNothingLeft(shop.proxy);
  }, 40_000);
});
