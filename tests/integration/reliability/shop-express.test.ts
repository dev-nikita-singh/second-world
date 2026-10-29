/**
 * Ground truth: examples/shop-express/expected-findings.json — `unbounded-retry`
 * (reliability/retry-without-backoff) and `no-timeout-outbound` (reliability/outbound-no-timeout,
 * engine architecture, alsoDetectableBy reliability).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReliability } from "../../../src/engines/reliability/index.js";
import {
  approvedCtx,
  assertNothingLeft,
  expressOrders,
  type ShopBehindProxy,
  startShopBehindProxy,
} from "./helpers.js";

describe("shop-express behind the fault proxy", () => {
  let shop: ShopBehindProxy;
  beforeEach(async () => {
    shop = await startShopBehindProxy("shop-express");
  });
  afterEach(async () => {
    await shop.close();
  });

  it("unbounded-retry: payments 503 → retry storm without backoff", async () => {
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 5, routes: [expressOrders] },
        steady: "2s",
        duration: "2s",
        recovery: "3s",
        seed: 5,
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    const f = r.findings.find((x) => x.ruleId === "reliability/retry-without-backoff");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("high");
    expect(r.data?.runs[0]?.amplification?.factor).toBeGreaterThan(10);
    // the storm finding supersedes the jitter rule (no backoff at all)
    expect(r.findings.map((x) => x.ruleId)).not.toContain("reliability/retry-without-jitter");
    await assertNothingLeft(shop.proxy);
  }, 30_000);

  it("no-timeout-outbound: black-holed payments → client latency tracks the black-hole", async () => {
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-timeout",
        dependency: "payments",
        workload: { rate: 5, routes: [expressOrders], timeout: "15s" },
        steady: "2s",
        duration: "4s",
        recovery: "3s",
        seed: 6,
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    const run = r.data?.runs[0];
    expect(run?.timeout?.verdict).toBe("no-timeout");
    expect(run?.timeout?.completedDuringFault).toBe(0);
    const f = r.findings.find((x) => x.ruleId === "reliability/outbound-no-timeout");
    expect(f?.severity).toBe("high");
    // held requests are released on revert, so the app recovers
    expect(run?.recovery?.recovered).toBe(true);
    await assertNothingLeft(shop.proxy);
  }, 30_000);
});
