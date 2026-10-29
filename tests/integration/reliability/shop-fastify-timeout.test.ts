/**
 * Precision: shop-fastify's `outbound-timeout` is correct by design (AbortSignal.timeout(2000) per
 * attempt, 4 attempts) → a black-holed payments must NOT yield reliability/outbound-no-timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  beforeAll(async () => {
    shop = await startShopBehindProxy("shop-fastify");
  });
  afterAll(async () => {
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
});
