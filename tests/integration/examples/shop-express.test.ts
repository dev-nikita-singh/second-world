/**
 * shop-express: boots on port 0, happy paths work, and EVERY seeded defect in
 * examples/shop-express/expected-findings.json is reproducible with plain HTTP.
 * This proves the fixture is valid ground truth for the engines.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { api } from "../../helpers/http.js";

const expected = JSON.parse(
  readFileSync(new URL("../../../examples/shop-express/expected-findings.json", import.meta.url), "utf8"),
) as { defects: { id: string }[] };

let shop: RunningExample;
const reproduced = new Set<string>();

beforeAll(async () => {
  shop = await startExample("shop-express");
});
afterAll(async () => {
  await shop?.close();
});
beforeEach(async () => {
  await api(shop.url, "POST", "/__test/reset");
  shop.payments.reset();
});

const order = (token: string, items: { productId: number; qty: number }[], headers?: Record<string, string>) =>
  api(shop.url, "POST", "/orders", { token, body: { items }, ...(headers ? { headers } : {}) });

describe("shop-express happy paths", () => {
  it("healthz, products list/get", async () => {
    expect((await api(shop.url, "GET", "/healthz")).status).toBe(200);
    const list = await api(shop.url, "GET", "/products");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(20);
    expect(typeof list.body.items[0].price).toBe("number");
    expect((await api(shop.url, "GET", "/products/1")).status).toBe(200);
    expect((await api(shop.url, "GET", "/products/999")).status).toBe(404);
    expect((await api(shop.url, "GET", "/products?category=books")).body.items.length).toBeGreaterThan(0);
  });

  it("login with valid/invalid credentials", async () => {
    const ok = await api(shop.url, "POST", "/auth/login", { body: { username: "alice", password: "alice-pass" } });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBe("alice-token");
    const bad = await api(shop.url, "POST", "/auth/login", { body: { username: "alice", password: "nope" } });
    expect(bad.status).toBe(401);
  });

  it("cart add/get/clear within valid quantities", async () => {
    expect((await api(shop.url, "GET", "/cart")).status).toBe(401);
    const add = await api(shop.url, "POST", "/cart/items", { token: "alice-token", body: { productId: 1, qty: 10 } });
    expect(add.status).toBe(201);
    const cart = await api(shop.url, "GET", "/cart", { token: "alice-token" });
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.total).toBeCloseTo(71.3, 2) // unit price 7.125 → 7.13;
    expect((await api(shop.url, "DELETE", "/cart", { token: "alice-token" })).status).toBe(204);
    expect((await api(shop.url, "POST", "/cart/items", { token: "alice-token", body: { productId: "x", qty: 1 } })).status).toBe(400);
  });

  it("orders: create (paid via payments), list own, admin route protected", async () => {
    const o = await order("alice-token", [{ productId: 2, qty: 3 }]);
    expect(o.status).toBe(201);
    expect(o.body.status).toBe("paid");
    expect(o.body.userId).toBe("u_alice");
    const mine = await api(shop.url, "GET", "/orders", { token: "alice-token" });
    expect(mine.body.items).toHaveLength(1);
    expect((await api(shop.url, "GET", "/orders", { token: "bob-token" })).body.items).toHaveLength(0);
    expect((await api(shop.url, "GET", `/orders/${o.body.id}`, { token: "alice-token" })).status).toBe(200);
    expect((await api(shop.url, "GET", "/admin/stats", { token: "alice-token" })).status).toBe(403);
    expect((await api(shop.url, "GET", "/admin/stats")).status).toBe(401);
    const admin = await api(shop.url, "GET", "/admin/stats", { token: "admin-token" });
    expect(admin.status).toBe(200);
    expect(admin.body.orders).toBe(1);
    expect((await order("alice-token", [{ productId: 999, qty: 1 }])).status).toBe(404);
  });
});

describe("shop-express seeded defects are reproducible", () => {
  it("n-plus-one-reviews: 1 + N queries for include=reviews", async () => {
    await api(shop.url, "POST", "/__test/reset");
    const r = await api(shop.url, "GET", "/products?include=reviews");
    expect(r.status).toBe(200);
    expect(r.body.items[0].reviews).toHaveLength(3);
    const q = (await api(shop.url, "GET", "/__test/stats")).body.queries as number;
    expect(q).toBe(1 + 20);
    reproduced.add("n-plus-one-reviews");
  });

  it("no-timeout-outbound: a hanging payments provider hangs POST /orders", async () => {
    shop.payments.setBehavior({ hang: true });
    const p = order("alice-token", [{ productId: 1, qty: 1 }]).then(
      () => "completed",
      () => "client-timeout",
    );
    const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r("still-pending"), 1500))]);
    expect(raced).toBe("still-pending");
    shop.payments.setBehavior({ hang: false }); // releases the hung charge (503) → retry succeeds
    expect(await p).toBe("completed");
    reproduced.add("no-timeout-outbound");
  });

  it("sync-crypto-login: concurrent logins block unrelated requests", async () => {
    const base = await api(shop.url, "GET", "/healthz");
    const logins = Array.from({ length: 8 }, () =>
      api(shop.url, "POST", "/auth/login", { body: { username: "bob", password: "bob-pass" } }),
    );
    await new Promise((r) => setImmediate(r));
    const health = api(shop.url, "GET", "/healthz");
    const [h] = await Promise.all([health, ...logins]);
    // 8 × ~15–50 ms pbkdf2Sync serialised on the event loop.
    expect(h.ms).toBeGreaterThan(base.ms + 60);
    reproduced.add("sync-crypto-login");
  });

  it("module-cycle: inventory.ts and orders.ts import each other", () => {
    const inv = readFileSync(new URL("../../../examples/shop-express/src/services/inventory.ts", import.meta.url), "utf8");
    const ord = readFileSync(new URL("../../../examples/shop-express/src/services/orders.ts", import.meta.url), "utf8");
    expect(inv).toMatch(/from "\.\/orders\.js"/);
    expect(ord).toMatch(/from "\.\/inventory\.js"/);
    reproduced.add("module-cycle");
  });

  it("stock-race: concurrent orders oversell a product with stock 1", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => order("alice-token", [{ productId: 20, qty: 1 }])));
    const created = rs.filter((r) => r.status === 201).length;
    expect(created).toBeGreaterThan(1);
    reproduced.add("stock-race");
  });

  it("idempotency-ignored: same Idempotency-Key creates two orders", async () => {
    const h = { "idempotency-key": "same-key-123" };
    const a = await order("alice-token", [{ productId: 3, qty: 1 }], h);
    const b = await order("alice-token", [{ productId: 3, qty: 1 }], h);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    reproduced.add("idempotency-ignored");
  });

  it("idempotency-key-race (discovered): concurrent requests with one key create several orders", async () => {
    const h = { "idempotency-key": "race-key-1" };
    const rs = await Promise.all(Array.from({ length: 5 }, () => order("alice-token", [{ productId: 6, qty: 1 }], h)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBeGreaterThan(1);
    reproduced.add("idempotency-key-race");
  });

  it("bola-orders: bob can read alice's order", async () => {
    const a = await order("alice-token", [{ productId: 4, qty: 1 }]);
    const stolen = await api(shop.url, "GET", `/orders/${a.body.id}`, { token: "bob-token" });
    expect(stolen.status).toBe(200);
    expect(stolen.body.userId).toBe("u_alice");
    reproduced.add("bola-orders");
  });

  it("schema-drift-price: GET /products/:id returns price as string", async () => {
    const r = await api(shop.url, "GET", "/products/1");
    expect(typeof r.body.price).toBe("string");
    reproduced.add("schema-drift-price");
  });

  it("boundary-500: qty 0 / -1 / 101 → 500 (contract: 400); 1 and 100 are fine", async () => {
    for (const qty of [0, -1, 101]) {
      const r = await api(shop.url, "POST", "/cart/items", { token: "alice-token", body: { productId: 1, qty } });
      expect(r.status, `qty=${qty}`).toBe(500);
    }
    for (const qty of [1, 100]) {
      const r = await api(shop.url, "POST", "/cart/items", { token: "alice-token", body: { productId: 1, qty } });
      expect(r.status, `qty=${qty}`).toBe(201);
    }
    expect((await order("alice-token", [{ productId: 1, qty: 0 }])).status).toBe(500);
    reproduced.add("boundary-500");
  });

  it("unbounded-retry: 25 failures → 26 back-to-back attempts, no backoff", async () => {
    shop.payments.setBehavior({ failNext: 25 });
    const r = await order("alice-token", [{ productId: 5, qty: 1 }]);
    expect(r.status).toBe(201);
    const st = shop.payments.stats();
    expect(st.attemptsByOrder[r.body.id]).toBe(26);
    const t = st.attemptTimes;
    const span = (t[t.length - 1] ?? 0) - (t[0] ?? 0);
    // With even a 10 ms base backoff 25 retries would take ≥ 250 ms (exponential: far more).
    expect(span).toBeLessThan(250 + 25 * 15);
    const gaps = t.slice(1).map((x, i) => x - (t[i] ?? 0));
    const maxGap = Math.max(...gaps);
    expect(maxGap).toBeLessThan(100); // no growing backoff
    reproduced.add("unbounded-retry");
  });

  it("no-circuit-breaker (discovered): a payments provider failing on every call is still called by every order", async () => {
    shop.payments.setBehavior({ failPct: 100 });
    const pending = [1, 2, 3].map((productId) => order("alice-token", [{ productId, qty: 1 }]));
    await new Promise((r) => setTimeout(r, 300));
    const st = shop.payments.stats();
    const perOrder = Object.values(st.attemptsByOrder);
    // all three orders keep calling the failing provider (a breaker would fail fast after a few failures)
    expect(perOrder).toHaveLength(3);
    for (const n of perOrder) expect(n).toBeGreaterThan(10);
    shop.payments.setBehavior({ failPct: 0 });
    for (const r of await Promise.all(pending)) expect(r.status).toBe(201);
    reproduced.add("no-circuit-breaker");
  });

  it("every defect in expected-findings.json was reproduced", () => {
    expect([...reproduced].sort()).toEqual(expected.defects.map((d) => d.id).sort());
  });
});
