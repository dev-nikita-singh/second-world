/**
 * Integration helpers: start an example shop whose payments dependency goes through the built-in
 * fault proxy (payments-fake ← proxy ← shop), and assert that nothing is left behind.
 */
import net from "node:net";
import { expect } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { pendingGlobalCleanups } from "../../../src/adapters/faults/cleanup.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";

export interface ShopBehindProxy {
  url: string;
  payments: PaymentsFake;
  proxy: BuiltinFaultProxy;
  close(): Promise<void>;
}

export async function startShopBehindProxy(name: "shop-express" | "shop-fastify"): Promise<ShopBehindProxy> {
  const payments = await startPaymentsFake();
  const proxy = await startFaultProxy({ upstream: payments.url, name: "payments" });
  let app: { url: string; close(): Promise<void> };
  if (name === "shop-express") {
    const m = await import("../../../examples/shop-express/src/server.js");
    app = await m.start(0, { paymentsUrl: proxy.url, queryDelayMs: 1 });
  } else {
    const m = await import("../../../examples/shop-fastify/src/server.js");
    app = await m.start(0, { paymentsUrl: proxy.url, queryDelayMs: 1, fixed: false });
  }
  return {
    url: app.url,
    payments,
    proxy,
    close: async () => {
      await app.close();
      await proxy.close();
      await payments.close();
    },
  };
}

export const approvedCtx = () => ({ safety: createSafetyGuard({}, { interactive: false, approve: true }) });

export function portRefuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(true));
  });
}

/** No fault active, proxy closed and its port refusing, no pending global reverts. */
export async function assertNothingLeft(proxy: BuiltinFaultProxy): Promise<void> {
  expect(proxy.active()).toEqual([]);
  const port = proxy.port;
  await proxy.close();
  expect(proxy.closed).toBe(true);
  expect(await portRefuses(port)).toBe(true);
  expect(
    pendingGlobalCleanups().filter((n) => n.startsWith("reliability:") || n.endsWith(`:${port}`)),
  ).toEqual([]);
}

export const fastifyOrders = {
  name: "orders",
  method: "POST",
  path: "/orders",
  headers: { authorization: "Bearer alice-token" },
  body: '{"productId":{{rand 1 39}},"qty":1}',
  dependsOn: ["payments"],
};

export const expressOrders = {
  name: "orders",
  method: "POST",
  path: "/orders",
  headers: { authorization: "Bearer alice-token" },
  body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
  dependsOn: ["payments"],
};
