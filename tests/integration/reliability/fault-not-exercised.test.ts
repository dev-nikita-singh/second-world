/**
 * Found in manual testing (2026-11-09, docs/manual-testing.md §2.6): shop-express started WITHOUT
 * PAYMENTS_URL pointing at the fault proxy. The fault went into a proxy nobody called, every detector said
 * "ok", and `sw reliability run dependency-5xx` printed PASS (exit 0). The run must instead be invalid:
 * limitation `fault-not-exercised` (impact invalidates), verdict inconclusive, status failed (never passed).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { runReliability } from "../../../src/engines/reliability/index.js";
import { computeExitCode } from "../../../src/engines/reporting/exit-code.js";
import {
  approvedCtx,
  assertNothingLeft,
  expressOrders,
  type ShopBehindProxy,
  startShopBehindProxy,
} from "./helpers.js";

describe("fault that never reaches the app", () => {
  let payments: PaymentsFake;
  let proxy: BuiltinFaultProxy;
  let app: { url: string; close(): Promise<void> };
  beforeEach(async () => {
    payments = await startPaymentsFake();
    proxy = await startFaultProxy({ upstream: payments.url, name: "payments" });
    const m = await import("../../../examples/shop-express/src/server.js");
    // The mistake: the shop talks to payments directly, not through the proxy.
    app = await m.start(0, { paymentsUrl: payments.url, queryDelayMs: 1 });
  });
  afterEach(async () => {
    await app.close();
    await proxy.close();
    await payments.close();
  });

  it("is reported as invalid, not as a pass", async () => {
    const r = await runReliability(
      {
        target: app.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 8, routes: [expressOrders] },
        steady: "2s",
        duration: "2s",
        recovery: "2s",
        seed: 9,
      },
      approvedCtx(),
      { injectors: { payments: proxy } },
    );
    const lim = r.limitations.find((l) => l.code === "fault-not-exercised");
    expect(lim?.impact).toBe("invalidates");
    expect(lim?.message).toMatch(/received 0 calls/);
    expect(lim?.message).toContain(proxy.url);
    expect(r.status).toBe("failed");
    expect(r.data?.verdict).toBe("inconclusive");
    expect(computeExitCode([r])).not.toBe(0);
    expect(r.data?.runs[0]?.amplification).toMatchObject({ proxyRequests: 0, steadyProxyRequests: 0 });
    await assertNothingLeft(proxy);
  }, 30_000);
});

describe("control: the same experiment wired correctly", () => {
  let shop: ShopBehindProxy;
  beforeEach(async () => {
    shop = await startShopBehindProxy("shop-express");
  });
  afterEach(async () => {
    await shop.close();
  });

  it("has no fault-not-exercised limitation", async () => {
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-5xx",
        dependency: "payments",
        workload: { rate: 8, routes: [expressOrders] },
        steady: "2s",
        duration: "2s",
        recovery: "2s",
        seed: 9,
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    expect(r.limitations.map((l) => l.code)).not.toContain("fault-not-exercised");
    expect(r.limitations.map((l) => l.code)).not.toContain("fault-not-exercised-during-fault");
    expect(r.data?.runs[0]?.amplification?.steadyProxyRequests).toBeGreaterThan(0);
    await assertNothingLeft(shop.proxy);
  }, 30_000);
});
