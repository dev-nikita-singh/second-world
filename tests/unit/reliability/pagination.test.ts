/**
 * Paginated invariant collections (docs/03-engines/reliability-lab.md, "Duplicate-operation
 * invariants"): offset / page / cursor / link styles, loop guards, caps, cross-origin refusal, and
 * partial collections making an invariant untrusted.
 */
import { describe, expect, it } from "vitest";
import type { HttpExecutor, HttpResult } from "../../../src/adapters/http/undici-executor.js";
import {
  type CollectionFetcher,
  type CollectionItems,
  createCollectionFetcher,
  evalNoDuplicates,
  evaluateInvariants,
  InvariantSchema,
  invariantDetections,
  nextLink,
  OpLedger,
  PageSchema,
  takeBaselines,
} from "../../../src/engines/reliability/invariants.js";

const TARGET = "http://api.test";

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Executor answering from `handler(url)`; records every requested URL. */
function fakeExecutor(handler: (u: URL) => Reply) {
  const seen: string[] = [];
  const ex: HttpExecutor = {
    async execute(req) {
      const u = new URL(req.path, req.origin);
      seen.push(u.href);
      const r = handler(u);
      const body = Buffer.from(JSON.stringify(r.body));
      const out: HttpResult = {
        status: r.status ?? 200,
        headers: r.headers ?? {},
        body,
        bytesIn: body.length,
        bytesOut: 0,
        tStart: 0,
        tHeaders: 0,
        tEnd: 1,
      };
      return out;
    },
    inFlight: 0,
    openSockets: 0,
    close: async () => {},
  };
  return { ex, seen };
}

function fetcherFor(
  handler: (u: URL) => Reply,
  extra: { maxItems?: number; maxTotalBytes?: number; blocked?: (u: URL) => boolean } = {},
) {
  const { ex, seen } = fakeExecutor(handler);
  const checked: string[] = [];
  const fetcher = createCollectionFetcher({
    executor: ex,
    target: TARGET,
    routeHeaders: () => undefined,
    checkUrl: (u) => {
      checked.push(u.href);
      if (extra.blocked?.(u)) throw new Error(`collection ${u.origin} blocked by the safety guard`);
    },
    maxBodyBytes: 1_000_000,
    ...(extra.maxItems !== undefined ? { maxItems: extra.maxItems } : {}),
    ...(extra.maxTotalBytes !== undefined ? { maxTotalBytes: extra.maxTotalBytes } : {}),
  });
  return { fetcher, seen, checked };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, key: `k${i}` }));

const spec = (page: unknown, extra: Record<string, unknown> = {}) =>
  InvariantSchema.parse({
    type: "no-duplicates",
    collection: "GET /orders?status=all",
    key: "key",
    page,
    ...extra,
  }) as Extract<ReturnType<typeof InvariantSchema.parse>, { type: "no-duplicates" }>;

const ids = (items: CollectionItems) => items.map((x) => (x as { id: string }).id);

describe("pagination styles", () => {
  it("offset: advances by the items actually returned (server clamp) and ends on an empty page", async () => {
    const all = rows(230);
    const { fetcher, seen } = fetcherFor((u) => {
      const off = Number(u.searchParams.get("offset"));
      const lim = Math.min(Number(u.searchParams.get("limit")), 50); // server clamps 100 → 50
      expect(u.searchParams.get("status")).toBe("all"); // original query kept
      return { body: { items: all.slice(off, off + lim) } };
    });
    const items = await fetcher.items(spec({ style: "offset" }));
    expect(ids(items)).toEqual(all.map((r) => r.id));
    expect(items.partial).toBeUndefined();
    expect(items.pages).toBe(6); // 5 × 50 (last 30) + the empty page
    expect(new URL(seen[1] as string).searchParams.get("offset")).toBe("50");
  });

  it("page: page/size params with a custom start and names", async () => {
    const all = rows(25);
    const { fetcher, seen } = fetcherFor((u) => {
      const p = Number(u.searchParams.get("p"));
      const n = Number(u.searchParams.get("per_page"));
      return { body: all.slice(p * n, p * n + n) };
    });
    const items = await fetcher.items(
      spec({ style: "page", pageParam: "p", sizeParam: "per_page", size: 10, start: 0 }),
    );
    expect(items.length).toBe(25);
    expect(items.partial).toBeUndefined();
    expect(seen.map((s) => new URL(s).searchParams.get("p"))).toEqual(["0", "1", "2", "3"]);
  });

  it("cursor: reads the next cursor from a JSON path and stops when it is null", async () => {
    const all = rows(7);
    const { fetcher, seen } = fetcherFor((u) => {
      const at = Number(u.searchParams.get("after") ?? 0);
      const next = at + 3 < all.length ? String(at + 3) : null;
      return { body: { data: all.slice(at, at + 3), meta: { next } } };
    });
    const items = await fetcher.items(
      spec({ style: "cursor", cursor: "meta.next", param: "after", limitParam: "n", limit: 3 }),
    );
    expect(ids(items)).toEqual(all.map((r) => r.id));
    expect(items.partial).toBeUndefined();
    expect(new URL(seen[0] as string).searchParams.get("after")).toBeNull();
    expect(new URL(seen[2] as string).searchParams.get("after")).toBe("6");
    expect(new URL(seen[2] as string).searchParams.get("n")).toBe("3");
  });

  it("link: follows rel=next (relative and absolute same-origin) until there is none", async () => {
    const pages: Record<string, Reply> = {
      "/orders": {
        body: [{ id: "a" }],
        headers: { link: '</orders?page=2>; rel="next", </orders?page=9>; rel="last"' },
      },
      "/orders?page=2": {
        body: [{ id: "b" }],
        headers: { link: `<${TARGET}/orders/p3>; rel="prev next"; title="x"` },
      },
      "/orders/p3": { body: [{ id: "c" }], headers: { link: '</orders>; rel="first"' } },
    };
    const { fetcher, checked } = fetcherFor((u) => pages[`${u.pathname}${u.search}`] as Reply);
    const items = await fetcher.items(spec({ style: "link" }, { collection: "/orders" }));
    expect(ids(items)).toEqual(["a", "b", "c"]);
    expect(items.partial).toBeUndefined();
    expect(checked.length).toBe(3); // every page URL went through the safety check
  });

  it("nextLink parses RFC 8288 headers", () => {
    const base = new URL("http://h/x/y?z=1");
    expect(nextLink(undefined, base)).toBeNull();
    expect(nextLink('<a?b=1>; rel="prev"', base)).toBeNull();
    expect(nextLink("<a?b=1>; rel=next", base)?.href).toBe("http://h/x/a?b=1");
    expect(nextLink(['<http://h/1>; rel="last"', '<http://h/2,3>; REL="Next"'], base)?.href).toBe(
      "http://h/2,3",
    );
  });

  it("schema: defaults and strictness", () => {
    expect(PageSchema.parse({ style: "offset" })).toMatchObject({
      offsetParam: "offset",
      limitParam: "limit",
      limit: 100,
      start: 0,
      maxPages: 1000,
    });
    expect(() => PageSchema.parse({ style: "cursor" })).toThrow(); // cursor path required
    expect(() => PageSchema.parse({ style: "link", maxPages: 1_000_000 })).toThrow();
    expect(() => PageSchema.parse({ style: "page", nope: 1 })).toThrow();
  });
});

describe("pagination bounds and guards", () => {
  it("loop guard: a repeated cursor ends the read as partial", async () => {
    const { fetcher, seen } = fetcherFor((u) => {
      const c = u.searchParams.get("cursor");
      return { body: { items: [{ id: `x${c}` }], next: c === null ? "A" : c === "A" ? "B" : "A" } };
    });
    const items = await fetcher.items(spec({ style: "cursor", cursor: "next" }));
    expect(items.partial).toMatch(/cursor repeated/);
    expect(seen.length).toBe(3);
    expect(items.length).toBe(3);
  });

  it("loop guard: a next link back to an earlier page ends the read as partial", async () => {
    const { fetcher, seen } = fetcherFor((u) => ({
      body: [{ id: u.search }],
      headers: { link: u.search === "?p=2" ? '</orders>; rel="next"' : '</orders?p=2>; rel="next"' },
    }));
    const items = await fetcher.items(spec({ style: "link" }, { collection: "/orders" }));
    expect(items.partial).toMatch(/page URL repeated/);
    expect(seen.length).toBe(2);
  });

  it("loop guard: a server ignoring the offset (same page again) is partial, not duplicated", async () => {
    const { fetcher, seen } = fetcherFor(() => ({ body: rows(3) }));
    const items = await fetcher.items(spec({ style: "offset", limit: 3 }));
    expect(items.partial).toMatch(/repeats an earlier page/);
    expect(items.length).toBe(3); // the repeated page is not appended
    expect(seen.length).toBe(2);
  });

  it("cap: maxPages ends the read as partial", async () => {
    const { fetcher, seen } = fetcherFor((u) => {
      const p = Number(u.searchParams.get("page"));
      return { body: [{ id: `p${p}` }] };
    });
    const items = await fetcher.items(spec({ style: "page", maxPages: 4 }));
    expect(seen.length).toBe(4);
    expect(items.partial).toMatch(/maxPages 4.*4 item\(s\) from 4 page\(s\)/);
  });

  it("cap: the item limit is partial unless the next page proves the end", async () => {
    const all = rows(10);
    const handler = (u: URL): Reply => {
      const off = Number(u.searchParams.get("offset"));
      return { body: all.slice(off, off + 4) };
    };
    const capped = await fetcherFor(handler, { maxItems: 6 }).fetcher.items(
      spec({ style: "offset", limit: 4 }),
    );
    expect(capped.length).toBe(6);
    expect(capped.partial).toMatch(/item limit reached \(6 items\)/);
    const exact = await fetcherFor(handler, { maxItems: 10 }).fetcher.items(
      spec({ style: "offset", limit: 4 }),
    );
    expect(exact.length).toBe(10);
    expect(exact.partial).toBeUndefined();
  });

  it("cap: the byte budget over all pages ends the read as partial", async () => {
    const { fetcher } = fetcherFor(
      (u) => ({ body: [{ id: u.searchParams.get("page"), pad: "x".repeat(100) }] }),
      { maxTotalBytes: 300 },
    );
    const items = await fetcher.items(spec({ style: "page" }));
    expect(items.partial).toMatch(/byte budget/);
    expect(items.length).toBe(3);
  });

  it("refuses a next link to another origin (never requested) and marks the read partial", async () => {
    const { fetcher, seen } = fetcherFor(() => ({
      body: [{ id: "a" }],
      headers: { link: '<http://evil.test/steal?from=orders>; rel="next"' },
    }));
    const items = await fetcher.items(spec({ style: "link" }, { collection: "/orders" }));
    expect(items.partial).toMatch(/another origin \(http:\/\/evil\.test\) refused/);
    expect(seen).toEqual([`${TARGET}/orders`]);
    // same host, other port = other origin
    const other = fetcherFor(() => ({
      body: [{ id: "a" }],
      headers: { link: '<http://api.test:8081/orders?p=2>; rel="next"' },
    }));
    const r2 = await other.fetcher.items(spec({ style: "link" }, { collection: "/orders" }));
    expect(r2.partial).toMatch(/refused/);
    expect(other.seen.length).toBe(1);
  });

  it("every page URL passes the safety guard (a blocked page fails the collection)", async () => {
    const { fetcher, seen } = fetcherFor(
      (u) => ({ body: [{ id: u.search }], headers: { link: '</admin/orders?p=2>; rel="next"' } }),
      { blocked: (u) => u.pathname.startsWith("/admin") },
    );
    await expect(fetcher.items(spec({ style: "link" }, { collection: "/orders" }))).rejects.toThrow(
      /blocked by the safety guard/,
    );
    expect(seen.length).toBe(1);
  });

  it("HTTP errors on a later page fail the collection with the page number", async () => {
    const { fetcher } = fetcherFor((u) =>
      u.searchParams.get("page") === "2" ? { status: 500, body: {} } : { body: [{ id: "a" }, { id: "b" }] },
    );
    await expect(fetcher.items(spec({ style: "page" }))).rejects.toThrow(/page 2\): HTTP 500/);
  });
});

describe("partial collections are not trusted", () => {
  const partialFetcher = (state: () => Record<string, CollectionItems>): CollectionFetcher => ({
    async items(c) {
      const v = state()[c.collection];
      if (!v) throw new Error("missing");
      return v;
    },
  });
  const mk = (items: unknown[], partial?: string): CollectionItems => {
    const a: CollectionItems = [...items];
    if (partial) a.partial = partial;
    return a;
  };

  it("held/count/conserved on a partial collection → error; duplicates found stay a violation", async () => {
    const ledger = new OpLedger("sw-p-r0");
    const k1 = ledger.nextKey();
    const k2 = ledger.nextKey();
    ledger.record("orders", k1, ["ok"], [201], "fault");
    ledger.record("orders", k2, ["ok"], [201], "fault");
    const invs = [
      InvariantSchema.parse({ type: "no-duplicates", name: "dup-partial", collection: "/a", key: "key" }),
      InvariantSchema.parse({ type: "no-duplicates", name: "held-partial", collection: "/b", key: "key" }),
      InvariantSchema.parse({ type: "count-matches", name: "count-partial", collection: "/b" }),
      InvariantSchema.parse({
        type: "conserved",
        name: "sum-partial",
        terms: [{ collection: "/b", field: "n" }],
      }),
    ];
    let after = false;
    const why = "GET /b: page limit reached (maxPages 1); read 1 item(s) from 1 page(s)";
    const f = partialFetcher(() =>
      after
        ? {
            "/a": mk(
              [
                { id: "1", key: k1 },
                { id: "2", key: k1 },
              ],
              "GET /a: item limit reached",
            ),
            "/b": mk([{ id: "3", key: k2, n: 1 }], why),
          }
        : { "/a": mk([]), "/b": mk([]) },
    );
    const baselines = await takeBaselines(invs, f);
    after = true;
    const r = await evaluateInvariants(invs, baselines, f, ledger, ["orders"]);
    expect(r.map((x) => [x.name, x.status])).toEqual([
      ["dup-partial", "violated"],
      ["held-partial", "error"],
      ["count-partial", "error"],
      ["sum-partial", "error"],
    ]);
    expect(r[0]?.detail).toMatch(/^at least 1 key\(s\).*partial collection/);
    expect(r[0]?.partial).toEqual(["GET /a: item limit reached"]);
    for (const x of r.slice(1)) {
      expect(x.detail).toMatch(/^not trusted: evaluated on a partial collection/);
      expect(x.partial).toEqual([why]);
    }
    const det = invariantDetections(r, { dependency: "db", faults: ["x"], redact: (s) => s });
    expect(det.map((d) => d.ruleId)).toEqual(["reliability/duplicate-operation"]);
  });

  it("a partial baseline also makes count-matches untrusted", async () => {
    const ledger = new OpLedger("sw-q-r0");
    const inv = [InvariantSchema.parse({ type: "count-matches", collection: "/b", routes: ["o"] })];
    let after = false;
    const f = partialFetcher(() => ({ "/b": after ? mk([1, 2]) : mk([1], "GET /b: cursor repeated") }));
    const b = await takeBaselines(inv, f);
    expect(b[0]).toEqual({ value: 1, partial: ["GET /b: cursor repeated"] });
    after = true;
    const [r] = await evaluateInvariants(inv, b, f, ledger, []);
    expect(r?.status).toBe("error");
  });

  it("the same id listed twice under one key (shifted page boundary) is not a duplicate", () => {
    const ev = evalNoDuplicates(
      [
        { id: "1", key: "k" },
        { id: "1", key: "k" },
        { id: "2", key: "j" },
        { id: "3", key: "j" },
      ],
      "key",
      "id",
      () => true,
    );
    expect(ev.repeated).toBe(1);
    expect(ev.duplicates.map((d) => d.key)).toEqual(["j"]);
  });
});
