/**
 * Duplicate-operation invariants (docs/03-engines/reliability-lab.md §3) end to end.
 *
 * client (workload, Idempotency-Key per logical op, 2 retries with the same key)
 *   → built-in fault proxy (slow-body: the response is lost after the server applied the POST)
 *   → in-test store (127.0.0.1, port 0)
 *
 * - buggy store: ignores the key → every retry creates another order → no-duplicates,
 *   count-matches (excess) and conserved (stock) are violated; with repeat 2 → reproduced-defect
 * - idempotent store: replays the stored order for a known key → no invariant finding
 * - examples/shop-express (planted `idempotency-ignored`): black-holed payments + client timeout →
 *   retried POST /orders create extra orders → count-matches flags duplicates
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { runReliability } from "../../../src/engines/reliability/index.js";
import {
  approvedCtx,
  assertNothingLeft,
  expressOrders,
  type ShopBehindProxy,
  startShopBehindProxy,
} from "./helpers.js";

interface Store {
  url: string;
  orders: { id: string; key: string | null; qty: number }[];
  stock: number;
  close(): Promise<void>;
}

const SECRET = "Bearer store-secret-token-1234567890";

async function startStore(mode: "buggy" | "idempotent"): Promise<Store> {
  const state: Store = { url: "", orders: [], stock: 100_000, close: async () => {} };
  const byKey = new Map<string, Store["orders"][number]>();
  let seq = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== SECRET) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown): void => {
        const s = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
        res.end(s);
      };
      if (req.method === "POST" && req.url === "/orders") {
        const key =
          typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
        if (mode === "idempotent" && key !== null) {
          const prev = byKey.get(key);
          if (prev) return send(201, prev);
        }
        // deliberately non-idempotent in "buggy" mode: a retried POST is applied again
        const qty = (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { qty?: number }).qty ?? 1;
        const order = { id: `o${++seq}`, key, qty };
        state.orders.push(order);
        state.stock -= qty;
        if (key !== null) byKey.set(key, order);
        return send(201, { ...order, padding: "x".repeat(64) });
      }
      if (req.method === "GET" && req.url === "/orders") return send(200, { items: state.orders });
      if (req.method === "GET" && req.url === "/stock")
        return send(200, { items: [{ sku: "a", stock: state.stock }] });
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

let store: Store | undefined;
let proxy: BuiltinFaultProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  await store?.close();
  store = undefined;
  proxy = undefined;
});

async function setup(mode: "buggy" | "idempotent") {
  store = await startStore(mode);
  proxy = await startFaultProxy({ upstream: store.url, name: "store" });
  return { store, proxy };
}

const input = (target: string, repeat = 1) => ({
  target,
  scenario: "slow-network",
  dependency: "store",
  // the response body trickles 1 byte / 3 s: the order is created, the client times out and retries
  fault: { type: "slow-body" as const, delayMs: "3s", chunkBytes: 1 },
  workload: {
    rate: 15,
    timeout: "400ms",
    routes: [
      {
        name: "create-order",
        method: "POST",
        path: "/orders",
        headers: { authorization: SECRET },
        body: '{"qty":1}',
        idempotency: { retries: 2, backoff: "50ms" },
      },
    ],
  },
  steady: "1s",
  duration: "2s",
  recovery: "1500ms",
  repeat,
  seed: 11,
  invariants: [
    {
      type: "no-duplicates" as const,
      name: "orders-by-key",
      collection: "GET /orders",
      key: "key",
      headersFrom: "create-order",
    },
    {
      type: "count-matches" as const,
      name: "orders-count",
      collection: "/orders",
      headersFrom: "create-order",
    },
    {
      type: "conserved" as const,
      name: "stock",
      terms: [{ collection: "GET /stock", field: "stock", headersFrom: "create-order" }],
      perOperation: -1,
    },
  ],
});

describe("duplicate-operation invariants (in-test store behind the fault proxy)", () => {
  it("non-idempotent store: retried POSTs after lost responses are detected (reproduced in 2/2 runs)", async () => {
    const s = await setup("buggy");
    const r = await runReliability(input(s.proxy.url, 2), approvedCtx(), { injectors: { store: s.proxy } });
    expect(r.data?.runs).toHaveLength(2);
    for (const run of r.data?.runs ?? []) {
      const inv = new Map((run.invariants ?? []).map((x) => [x.name, x]));
      expect(inv.get("orders-by-key")?.status).toBe("violated");
      expect(inv.get("orders-count")?.status).toBe("violated");
      expect(inv.get("orders-count")?.direction).toBe("excess");
      expect(inv.get("stock")?.status).toBe("violated");
      const ops = run.operations?.["create-order"];
      expect(ops?.retried).toBeGreaterThan(0);
      expect(ops?.retriedDuringFault).toBeGreaterThan(0);
      const dupList = inv.get("orders-by-key")?.duplicates ?? [];
      expect(dupList[0]?.count).toBeGreaterThan(1);
      expect(dupList[0]?.route).toBe("create-order");
      // An op first sent at the very end of the steady phase can lose its response once the fault starts,
      // so its phase is "steady" (seen under full-suite load). At least one duplicate starts in the fault.
      expect(dupList.some((d) => d.phase === "fault")).toBe(true);
      for (const d of dupList) expect(["steady", "fault"]).toContain(d.phase);
    }
    const dups = r.findings.filter((f) => f.ruleId === "reliability/duplicate-operation");
    expect(dups.length).toBe(2); // no-duplicates + count-matches (grouped per invariant)
    for (const f of dups) {
      expect(f.classification).toBe("reproduced-defect");
      expect(f.severity).toBe("high");
      const notes = f.evidence.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text);
      expect(notes.some((t) => t.includes("slow body"))).toBe(true);
      expect(notes).toContain("Detected in 2/2 run(s)");
    }
    const byKey = dups.find((f) => f.title.includes("orders-by-key"));
    const keyNotes =
      byKey?.evidence.filter((e) => e.kind === "note").map((e) => (e as { text: string }).text) ?? [];
    expect(keyNotes.some((t) => /key sw-[a-z0-9]+-r\d-\d+: [2-9] resources \(ids o\d+/.test(t))).toBe(true);
    expect(keyNotes.some((t) => t.includes("while the fault was active"))).toBe(true);
    const metrics = byKey?.evidence.filter((e) => e.kind === "measurement") ?? [];
    expect(
      metrics.find((m) => (m as { metric: string }).metric === "invariant.duplicate_keys"),
    ).toBeDefined();
    expect(r.findings.find((f) => f.ruleId === "reliability/invariant-violated")?.classification).toBe(
      "reproduced-defect",
    );
    // no secrets anywhere in the result
    expect(JSON.stringify(r)).not.toContain("store-secret-token");
    expect(r.status).toBe("failed");
    await assertNothingLeft(s.proxy);
  }, 30_000);

  it("idempotent store: same faults and retries, no invariant finding", async () => {
    const s = await setup("idempotent");
    const r = await runReliability(input(s.proxy.url), approvedCtx(), { injectors: { store: s.proxy } });
    const run = r.data?.runs[0];
    expect(run?.fault.applied).toBe(true);
    expect(run?.operations?.["create-order"]?.retried).toBeGreaterThan(0);
    expect(run?.invariants?.map((x) => [x.name, x.status])).toEqual([
      ["orders-by-key", "held"],
      ["orders-count", "held"],
      ["stock", "held"],
    ]);
    const ruleIds = r.findings.map((f) => f.ruleId);
    expect(ruleIds).not.toContain("reliability/duplicate-operation");
    expect(ruleIds).not.toContain("reliability/lost-write");
    expect(ruleIds).not.toContain("reliability/invariant-violated");
    // every key maps to exactly one order on the server
    const keys = s.store.orders.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    await assertNothingLeft(s.proxy);
  }, 30_000);
});

describe("dependency-reset when=after-response (built-in proxy)", () => {
  const resetInput = (target: string, when?: "after-response") => {
    const base = input(target);
    const { fault: _fault, ...rest } = base;
    return {
      ...rest,
      scenario: "dependency-reset",
      // 50 %: every other call is reset, so retries also succeed and confirmed operations exist
      params: { percent: 50, ...(when ? { when } : {}) },
    };
  };

  it("the store applied the POST, the client saw a reset and retried → duplicates", async () => {
    const s = await setup("buggy");
    const r = await runReliability(resetInput(s.proxy.url, "after-response"), approvedCtx(), {
      injectors: { store: s.proxy },
    });
    const run = r.data?.runs[0];
    expect(run?.fault.applied).toBe(true);
    expect(r.data?.faults).toEqual(["connection reset after the upstream responded on 50%"]);
    const inv = new Map((run?.invariants ?? []).map((x) => [x.name, x]));
    expect(inv.get("orders-by-key")?.status).toBe("violated");
    expect(inv.get("orders-count")?.status).toBe("violated");
    expect(inv.get("orders-count")?.direction).toBe("excess");
    expect(inv.get("stock")?.status).toBe("violated");
    expect(run?.operations?.["create-order"]?.retriedDuringFault).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.ruleId === "reliability/duplicate-operation")).toBe(true);
    await assertNothingLeft(s.proxy);
  }, 30_000);

  it("control: the default reset (before the request is forwarded) produces no duplicates", async () => {
    const s = await setup("buggy");
    const r = await runReliability(resetInput(s.proxy.url), approvedCtx(), { injectors: { store: s.proxy } });
    const run = r.data?.runs[0];
    expect(run?.fault.applied).toBe(true);
    expect(run?.operations?.["create-order"]?.retriedDuringFault).toBeGreaterThan(0);
    expect(run?.invariants?.map((x) => [x.name, x.status])).toEqual([
      ["orders-by-key", "held"],
      ["orders-count", "held"],
      ["stock", "held"],
    ]);
    const keys = s.store.orders.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    await assertNothingLeft(s.proxy);
  }, 30_000);
});

describe("examples/shop-express (planted idempotency-ignored)", () => {
  let shop: ShopBehindProxy | undefined;
  afterEach(async () => {
    await shop?.close();
    shop = undefined;
  });

  it("black-holed payments + client timeout: retried POST /orders create duplicate orders", async () => {
    shop = await startShopBehindProxy("shop-express");
    const r = await runReliability(
      {
        target: shop.url,
        scenario: "dependency-timeout",
        dependency: "payments",
        workload: {
          rate: 5,
          timeout: "800ms",
          routes: [{ ...expressOrders, idempotency: { retries: 2, backoff: "50ms" } }],
        },
        steady: "1500ms",
        duration: "3s",
        recovery: "3s",
        seed: 21,
        invariants: [
          { type: "count-matches", name: "alice-orders", collection: "GET /orders", headersFrom: "orders" },
        ],
      },
      approvedCtx(),
      { injectors: { payments: shop.proxy } },
    );
    const inv = r.data?.runs[0]?.invariants?.[0];
    expect(inv?.status).toBe("violated");
    expect(inv?.direction).toBe("excess");
    expect(inv?.observed).toBeGreaterThan(inv?.expected?.max ?? Number.POSITIVE_INFINITY);
    const f = r.findings.find((x) => x.ruleId === "reliability/duplicate-operation");
    expect(f?.classification).toBe("observation");
    expect(f?.severity).toBe("high");
    expect(JSON.stringify(r)).not.toContain("alice-token");
    await assertNothingLeft(shop.proxy);
  }, 30_000);
});
