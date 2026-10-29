/**
 * Ground truth: examples/shop-fastify/expected-findings.json — `retry-no-jitter`
 * (reliability/retry-without-jitter) and `no-circuit-breaker` (reliability/no-circuit-breaker).
 * Sustained payments 503 behind the built-in proxy, 2 repetitions → reproduced defects.
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

describe("shop-fastify: dependency-5xx on payments", () => {
  let shop: ShopBehindProxy;
  beforeAll(async () => {
    shop = await startShopBehindProxy("shop-fastify");
  });
  afterAll(async () => {
    await shop.close();
  });

  it("detects retry-no-jitter and no-circuit-breaker, reproduced in 2/2 runs, and leaves nothing behind", async () => {
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 10, routes: [fastifyOrders, { name: "health", path: "/healthz", dependsOn: [] }] },
        steady: "3s",
        duration: "5s",
        recovery: "3s",
        repeat: 2,
        seed: 11,
        steadyState: ["error_rate<5%"],
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    const rules = r.findings.map((f) => f.ruleId);
    const jitter = r.findings.find((f) => f.ruleId === "reliability/retry-without-jitter");
    const breaker = r.findings.find((f) => f.ruleId === "reliability/no-circuit-breaker");
    const run = r.data?.runs[0];
    expect(run?.amplification?.factor).toBeGreaterThan(3);
    expect(run?.amplification?.factor).toBeLessThan(6);
    expect(run?.jitter?.lagMs).toBeGreaterThanOrEqual(45);
    expect(run?.jitter?.lagMs).toBeLessThanOrEqual(75);
    expect(jitter?.classification).toBe("reproduced-defect");
    expect(breaker?.classification).toBe("reproduced-defect");
    // precision: bounded retries with a timeout → not an unbounded storm, no timeout defect, no isolation failure
    expect(rules).not.toContain("reliability/retry-without-backoff");
    expect(rules).not.toContain("reliability/outbound-no-timeout");
    expect(rules).not.toContain("reliability/isolation-failure");
    expect(run?.recovery?.recovered).toBe(true);
    expect(r.status).toBe("failed");
    await assertNothingLeft(shop.proxy);
  }, 40_000);
});
