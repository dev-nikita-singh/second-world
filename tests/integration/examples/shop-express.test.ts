/**
 * shop-express: boots on port 0, happy paths work, and EVERY seeded defect in
 * examples/shop-express/expected-findings.json is reproducible with plain HTTP.
 * This proves the fixture is valid ground truth for the engines.
 */
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
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

const order = (
  token: string,
  items: { productId: number; qty: number }[],
  headers?: Record<string, string>,
) => api(shop.url, "POST", "/orders", { token, body: { items }, ...(headers ? { headers } : {}) });

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
    const ok = await api(shop.url, "POST", "/auth/login", {
      body: { username: "alice", password: "alice-pass" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBe("alice-token");
    const bad = await api(shop.url, "POST", "/auth/login", { body: { username: "alice", password: "nope" } });
    expect(bad.status).toBe(401);
  });

  it("cart add/get/clear within valid quantities", async () => {
    expect((await api(shop.url, "GET", "/cart")).status).toBe(401);
    const add = await api(shop.url, "POST", "/cart/items", {
      token: "alice-token",
      body: { productId: 1, qty: 10 },
    });
    expect(add.status).toBe(201);
    const cart = await api(shop.url, "GET", "/cart", { token: "alice-token" });
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.total).toBeCloseTo(71.3, 2); // unit price 7.125 → 7.13;
    expect((await api(shop.url, "DELETE", "/cart", { token: "alice-token" })).status).toBe(204);
    expect(
      (await api(shop.url, "POST", "/cart/items", { token: "alice-token", body: { productId: "x", qty: 1 } }))
        .status,
    ).toBe(400);
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
    // Relative to measured work, not a fixed +60 ms (pbkdf2 is ~20 ms on a fast Linux box, ~50 ms on a
    // slow one). Raw sockets make the arrival order deterministic: fetch's pool opened new connections
    // for the logins while /healthz reused an idle one, so /healthz sometimes overtook every login.
    const LOGIN = JSON.stringify({ username: "bob", password: "bob-pass" });
    const baseMs = Math.min(...(await rawBurst(shop.url, [null, null, null])));
    const loginWorkMs =
      Math.min(...(await seq(3, async () => (await rawBurst(shop.url, [LOGIN]))[0] as number))) - baseMs;
    // 8 logins written first, then /healthz on its own connection, all in one synchronous burst.
    const burst = await rawBurst(shop.url, [...Array.from({ length: 8 }, () => LOGIN), null]);
    const healthMs = burst[8] as number;
    // A non-blocking server answers /healthz in ~baseMs. With pbkdf2Sync the 8 logins run back to
    // back on the event loop ahead of it, so /healthz waits for (almost) all of them.
    expect(loginWorkMs).toBeGreaterThan(1);
    expect(healthMs - baseMs, `login work ${loginWorkMs.toFixed(1)} ms`).toBeGreaterThan(
      0.5 * 8 * loginWorkMs,
    );
    reproduced.add("sync-crypto-login");
  });

  it("module-cycle: inventory.ts and orders.ts import each other", () => {
    const inv = readFileSync(
      new URL("../../../examples/shop-express/src/services/inventory.ts", import.meta.url),
      "utf8",
    );
    const ord = readFileSync(
      new URL("../../../examples/shop-express/src/services/orders.ts", import.meta.url),
      "utf8",
    );
    expect(inv).toMatch(/from "\.\/orders\.js"/);
    expect(ord).toMatch(/from "\.\/inventory\.js"/);
    reproduced.add("module-cycle");
  });

  it("stock-race: concurrent orders oversell a product with stock 1", async () => {
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => order("alice-token", [{ productId: 20, qty: 1 }])),
    );
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
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => order("alice-token", [{ productId: 6, qty: 1 }], h)),
    );
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
      const r = await api(shop.url, "POST", "/cart/items", {
        token: "alice-token",
        body: { productId: 1, qty },
      });
      expect(r.status, `qty=${qty}`).toBe(500);
    }
    for (const qty of [1, 100]) {
      const r = await api(shop.url, "POST", "/cart/items", {
        token: "alice-token",
        body: { productId: 1, qty },
      });
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

async function seq<T>(n: number, f: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await f());
  return out;
}

/**
 * Opens one connection per entry (null = GET /healthz, string = POST /auth/login with that JSON body),
 * waits until the server has accepted them all, then writes every request in one synchronous burst in
 * array order. Resolves each request's latency (write → response fully received) in ms.
 */
async function rawBurst(baseUrl: string, entries: (string | null)[]): Promise<number[]> {
  const { hostname, port } = new URL(baseUrl);
  const socks = await Promise.all(
    entries.map(
      () =>
        new Promise<Socket>((resolve, reject) => {
          const s = connect({ host: hostname, port: Number(port) }, () => resolve(s));
          s.once("error", reject);
        }),
    ),
  );
  await new Promise((r) => setTimeout(r, 30)); // the server accepts every connection first
  const done = socks.map((s) => {
    const t0 = { v: 0 };
    const p = new Promise<number>((resolve, reject) => {
      s.on("data", () => undefined);
      s.once("end", () => resolve(performance.now() - t0.v));
      s.once("error", reject);
    });
    return { s, t0, p };
  });
  entries.forEach((body, i) => {
    const d = done[i] as (typeof done)[number];
    const head =
      body === null
        ? "GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
        : `POST /auth/login HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    d.t0.v = performance.now();
    d.s.write(head);
  });
  try {
    return await Promise.all(done.map((d) => d.p));
  } finally {
    for (const s of socks) s.destroy();
  }
}
