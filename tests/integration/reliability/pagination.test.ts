/**
 * Paginated invariant collections end to end (docs/03-engines/reliability-lab.md, "Duplicate-operation
 * invariants").
 *
 * client (Idempotency-Key per logical op, retries with the same key)
 *   → built-in fault proxy (slow-body: responses lost after the POST was applied)
 *   → in-test NON-idempotent store whose GET /orders is paginated (?page=N, server-side page size,
 *     RFC 8288 `Link: rel="next"`).
 *
 * The store fixes its page size on the first listing after the workload so that the FIRST duplicated
 * order lands on page 3: a single-request read (page 1) or a 2-page read cannot see it.
 * - page style and link style read every page → the duplicate on page 3 is found (violated)
 * - page style with maxPages 2 → partial collection → status error + limitation (never silently "held")
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import { runReliability } from "../../../src/engines/reliability/index.js";
import { approvedCtx, assertNothingLeft } from "./helpers.js";

interface Order {
  id: string;
  key: string | null;
}

interface PagedStore {
  url: string;
  orders: Order[];
  pageSize: number | null;
  listed: string[];
  close(): Promise<void>;
}

const LEGACY = 3;

/** Index of the first order whose key already appeared earlier (a duplicate), or -1. */
function firstDuplicate(orders: readonly Order[]): number {
  const seen = new Set<string>();
  for (const [i, o] of orders.entries()) {
    if (o.key === null) continue;
    if (seen.has(o.key)) return i;
    seen.add(o.key);
  }
  return -1;
}

async function startPagedStore(): Promise<PagedStore> {
  const state: PagedStore = { url: "", orders: [], pageSize: null, listed: [], close: async () => {} };
  for (let i = 0; i < LEGACY; i++) state.orders.push({ id: `legacy${i}`, key: `legacy-${i}` });
  let seq = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        const s = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(s)),
          ...headers,
        });
        res.end(s);
      };
      const u = new URL(req.url ?? "/", "http://store");
      if (req.method === "POST" && u.pathname === "/orders") {
        const key =
          typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
        const order = { id: `o${++seq}`, key }; // non-idempotent: every retry creates an order
        state.orders.push(order);
        return send(201, { ...order, padding: "x".repeat(64) });
      }
      if (req.method === "GET" && u.pathname === "/orders") {
        state.listed.push(`${u.pathname}${u.search}`);
        if (state.pageSize === null) {
          // first listing after the workload: choose s with 2s <= firstDup < 3s → page 3
          const i = firstDuplicate(state.orders);
          state.pageSize = i >= 4 ? Math.floor(i / 2) : 10;
        }
        const size = state.pageSize; // server-side size: the client's `size` is ignored (clamp)
        const page = Math.max(1, Number(u.searchParams.get("page") ?? 1));
        const items = state.orders.slice((page - 1) * size, page * size);
        const more = page * size < state.orders.length;
        return send(200, { items }, more ? { link: `</orders?page=${page + 1}>; rel="next"` } : {});
      }
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

let store: PagedStore | undefined;
let proxy: BuiltinFaultProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  await store?.close();
  store = undefined;
  proxy = undefined;
});

describe("paginated invariant collections", () => {
  it("finds a duplicate that first appears on page 3; a 2-page read is reported as untrusted", async () => {
    store = await startPagedStore();
    proxy = await startFaultProxy({ upstream: store.url, name: "store" });
    const r = await runReliability(
      {
        target: proxy.url,
        scenario: "slow-network",
        dependency: "store",
        fault: { type: "slow-body", delayMs: "3s", chunkBytes: 1 },
        workload: {
          rate: 15,
          timeout: "400ms",
          routes: [
            {
              name: "create-order",
              method: "POST",
              path: "/orders",
              body: '{"qty":1}',
              idempotency: { retries: 2, backoff: "50ms" },
            },
          ],
        },
        steady: "1s",
        duration: "2s",
        recovery: "1500ms",
        seed: 13,
        invariants: [
          {
            type: "no-duplicates",
            name: "by-page",
            collection: "GET /orders",
            key: "key",
            page: { style: "page", size: 50 },
          },
          {
            type: "no-duplicates",
            name: "by-link",
            collection: "GET /orders",
            key: "key",
            page: { style: "link" },
          },
          {
            type: "no-duplicates",
            name: "two-pages-only",
            collection: "GET /orders",
            key: "key",
            page: { style: "page", maxPages: 2 },
          },
        ],
      },
      approvedCtx(),
      { injectors: { store: proxy } },
    );
    const s = store;
    const firstDup = firstDuplicate(s.orders);
    expect(firstDup).toBeGreaterThanOrEqual(4);
    const size = s.pageSize as number;
    expect(Math.floor(firstDup / size) + 1).toBe(3); // the first duplicate is on page 3

    const inv = new Map((r.data?.runs[0]?.invariants ?? []).map((x) => [x.name, x]));
    for (const name of ["by-page", "by-link"]) {
      const x = inv.get(name);
      expect(x?.status, name).toBe("violated");
      expect(x?.partial, name).toBeUndefined();
      const dupKey = s.orders[firstDup]?.key;
      expect(
        x?.duplicates?.some((d) => d.key === dupKey),
        name,
      ).toBe(true);
    }
    // page style ended on the empty page after the last; link style on the missing rel="next"
    const pages = Math.ceil(s.orders.length / size);
    expect(s.listed.filter((l) => l.includes("size=50")).length).toBe(pages + 1);
    expect(s.listed.filter((l) => l === `/orders?page=${pages}`).length).toBe(1);
    expect(s.listed.filter((l) => l.includes("size=100")).length).toBe(2); // maxPages 2

    const partial = inv.get("two-pages-only");
    expect(partial?.status).toBe("error");
    expect(partial?.detail).toMatch(/^not trusted: evaluated on a partial collection/);
    expect(partial?.partial?.[0]).toMatch(/maxPages 2/);
    const lim = r.limitations.find((l) => l.code === "invariant-partial-collection");
    expect(lim?.message).toMatch(/"two-pages-only" was evaluated on a partial collection .* not trusted/);
    expect(lim?.impact).toBe("reduces-confidence");
    expect(r.limitations.filter((l) => l.code === "invariant-partial-collection")).toHaveLength(1);

    const dups = r.findings.filter((f) => f.ruleId === "reliability/duplicate-operation");
    expect(dups.length).toBe(2); // by-page + by-link; the untrusted read gives none
    await assertNothingLeft(proxy);
  }, 30_000);
});
