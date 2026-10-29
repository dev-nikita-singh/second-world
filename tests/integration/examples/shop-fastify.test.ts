/**
 * shop-fastify: boots on port 0, happy paths, every seeded defect reproducible,
 * the correct-by-design behaviours really are correct, and FIXED removes slow-search.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { api } from "../../helpers/http.js";

const expected = JSON.parse(
  readFileSync(new URL("../../../examples/shop-fastify/expected-findings.json", import.meta.url), "utf8"),
) as { defects: { id: string }[]; correctByDesign: { id: string }[] };

let shop: RunningExample;
const reproduced = new Set<string>();
const verifiedCorrect = new Set<string>();

beforeAll(async () => {
  shop = await startExample("shop-fastify");
});
afterAll(async () => {
  await shop?.close();
});
beforeEach(async () => {
  await api(shop.url, "POST", "/__test/reset");
  shop.payments.reset();
});

const order = (token: string, body: unknown, headers?: Record<string, string>) =>
  api(shop.url, "POST", "/orders", { token, body, ...(headers ? { headers } : {}) });
const queries = async (): Promise<number> => (await api(shop.url, "GET", "/__test/stats")).body.queries as number;

describe("shop-fastify happy paths", () => {
  it("healthz, paging, product get, search, terms", async () => {
    const h = await api(shop.url, "GET", "/healthz");
    expect(h.body).toEqual({ ok: true, variant: "seeded" });
    const page = await api(shop.url, "GET", "/products?page=2&limit=10");
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(10);
    expect(page.body.items[0].id).toBe(11);
    expect(page.body.pages).toBe(4);
    expect((await api(shop.url, "GET", "/products/3")).status).toBe(200);
    expect((await api(shop.url, "GET", "/products/999")).status).toBe(404);
    const s = await api(shop.url, "GET", "/products/search?q=red");
    expect(s.body.items.length).toBeGreaterThan(0);
    expect((await api(shop.url, "GET", "/products/search")).status).toBe(400);
    expect((await api(shop.url, "GET", "/terms")).body).toContain("Terms of service");
  });

  it("orders: create, read own, admin can read, auth required", async () => {
    expect((await order("", { productId: 1, qty: 1 })).status).toBe(401);
    const o = await order("alice-token", { productId: 1, qty: 2 });
    expect(o.status).toBe(201);
    expect(o.body.status).toBe("paid");
    expect((await api(shop.url, "GET", `/orders/${o.body.id}`, { token: "alice-token" })).status).toBe(200);
    expect((await api(shop.url, "GET", `/orders/${o.body.id}`, { token: "admin-token" })).status).toBe(200);
    expect((await api(shop.url, "DELETE", "/products/2", { token: "admin-token" })).status).toBe(204);
  });
});

describe("shop-fastify seeded defects are reproducible", () => {
  it("slow-search: one query per product (1 + 40)", async () => {
    await api(shop.url, "POST", "/__test/reset");
    await api(shop.url, "GET", "/products/search?q=red");
    expect(await queries()).toBe(41);
    reproduced.add("slow-search");
  });

  it("retry-no-jitter: constant ~50 ms gaps between attempts", async () => {
    shop.payments.setBehavior({ failNext: 3 });
    const o = await order("alice-token", { productId: 1, qty: 1 });
    expect(o.status).toBe(201);
    const t = shop.payments.stats().attemptTimes;
    expect(t).toHaveLength(4);
    const gaps = t.slice(1).map((x, i) => x - (t[i] ?? 0));
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(45);
    // constant: no exponential growth (last gap not ≥ 2× first)
    expect((gaps[2] ?? 0) / (gaps[0] ?? 1)).toBeLessThan(1.8);
    reproduced.add("retry-no-jitter");
  });

  it("no-circuit-breaker: every order keeps hammering a dead provider", async () => {
    shop.payments.setBehavior({ failPct: 100 });
    for (let i = 0; i < 5; i++) expect((await order("alice-token", { productId: 1, qty: 1 })).status).toBe(502);
    expect(shop.payments.stats().attempts).toBe(20);
    reproduced.add("no-circuit-breaker");
  });

  it("boundary-500-limit: limit=0 / -1 → 500", async () => {
    expect((await api(shop.url, "GET", "/products?limit=0")).status).toBe(500);
    expect((await api(shop.url, "GET", "/products?limit=-1")).status).toBe(500);
    expect((await api(shop.url, "GET", "/products?limit=1")).status).toBe(200);
    reproduced.add("boundary-500-limit");
  });

  it("bfla-delete-product: a customer can delete products", async () => {
    expect((await api(shop.url, "DELETE", "/products/1", { token: "bob-token" })).status).toBe(204);
    expect((await api(shop.url, "GET", "/products/1")).status).toBe(404);
    reproduced.add("bfla-delete-product");
  });

  it("sync-fs-in-handler: readFileSync inside the /terms handler", () => {
    const src = readFileSync(new URL("../../../examples/shop-fastify/src/server.ts", import.meta.url), "utf8");
    const handler = src.slice(src.indexOf('app.get("/terms"'), src.indexOf('app.post<{ Body'));
    expect(handler).toContain("readFileSync(");
    reproduced.add("sync-fs-in-handler");
  });

  it("idempotency-key-race (discovered): concurrent requests with one key create several orders", async () => {
    const h = { "idempotency-key": "race-key-1" };
    const rs = await Promise.all(Array.from({ length: 5 }, () => order("alice-token", { productId: 6, qty: 1 }, h)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBeGreaterThan(1);
    // ...while a sequential repeat afterwards is replayed (one of the earlier orders comes back)
    const again = await order("alice-token", { productId: 6, qty: 1 }, h);
    expect(rs.map((r) => r.body.id)).toContain(again.body.id);
    reproduced.add("idempotency-key-race");
  });

  it("schema-drift-created-at: createdAt is a number", async () => {
    const o = await order("alice-token", { productId: 1, qty: 1 });
    expect(typeof o.body.createdAt).toBe("string"); // POST is fine
    const g = await api(shop.url, "GET", `/orders/${o.body.id}`, { token: "alice-token" });
    expect(typeof g.body.createdAt).toBe("number");
    reproduced.add("schema-drift-created-at");
  });

  it("every defect in expected-findings.json was reproduced", () => {
    expect([...reproduced].sort()).toEqual(expected.defects.map((d) => d.id).sort());
  });
});

describe("shop-fastify correct-by-design behaviours (precision guards)", () => {
  it("idempotency-honoured (sequential repeats; concurrent ones are the known idempotency-key-race defect)", async () => {
    const h = { "idempotency-key": "k-1" };
    const a = await order("alice-token", { productId: 5, qty: 1 }, h);
    const b = await order("alice-token", { productId: 5, qty: 1 }, h);
    expect(b.body.id).toBe(a.body.id);
    verifiedCorrect.add("idempotency-honoured");
  });

  it("orders-ownership-checked", async () => {
    const a = await order("alice-token", { productId: 5, qty: 1 });
    expect((await api(shop.url, "GET", `/orders/${a.body.id}`, { token: "bob-token" })).status).toBe(404);
    verifiedCorrect.add("orders-ownership-checked");
  });

  it("stock-atomic: product 40 (stock 1) sells exactly once under concurrency", async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => order("alice-token", { productId: 40, qty: 1 })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    verifiedCorrect.add("stock-atomic");
  });

  it("outbound-timeout: payments fetch is bounded by AbortSignal.timeout (static check; a live hang costs 4 x 2 s)", () => {
    const src = readFileSync(new URL("../../../examples/shop-fastify/src/payments-client.ts", import.meta.url), "utf8");
    expect(src).toMatch(/signal: AbortSignal\.timeout\(\d+\)/);
    verifiedCorrect.add("outbound-timeout");
  });

  it("order-qty-validated", async () => {
    for (const qty of [0, 101, -1]) expect((await order("alice-token", { productId: 1, qty })).status).toBe(400);
    verifiedCorrect.add("order-qty-validated");
  });

  it("all correctByDesign entries verified", () => {
    expect([...verifiedCorrect].sort()).toEqual(expected.correctByDesign.map((d) => d.id).sort());
  });
});

describe("shop-fastify FIXED variant", () => {
  it("search uses the index (1 query) and returns the same results, faster", async () => {
    const fixed = await startExample("shop-fastify", { fixed: true, queryDelayMs: 2 });
    const seeded = await startExample("shop-fastify", { queryDelayMs: 2 });
    try {
      expect((await api(fixed.url, "GET", "/healthz")).body.variant).toBe("fixed");
      await api(fixed.url, "POST", "/__test/reset");
      const f = await api(fixed.url, "GET", "/products/search?q=red");
      expect((await api(fixed.url, "GET", "/__test/stats")).body.queries).toBe(1);
      const s = await api(seeded.url, "GET", "/products/search?q=red");
      expect(f.body.items.map((p: { id: number }) => p.id)).toEqual(s.body.items.map((p: { id: number }) => p.id));
      expect(s.ms).toBeGreaterThan(f.ms * 3);
    } finally {
      await Promise.all([fixed.close(), seeded.close()]);
    }
  });
});
