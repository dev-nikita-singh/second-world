import { describe, expect, it } from "vitest";
import type {
  HttpExecutor,
  HttpRequestSpec,
  HttpResult,
} from "../../../src/adapters/http/undici-executor.js";
import { ConfigError } from "../../../src/core/errors.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { buildFindings } from "../../../src/engines/reliability/findings.js";
import { parseReliabilityInput, runReliability } from "../../../src/engines/reliability/index.js";
import {
  type CollectionFetcher,
  type CollectionSpec,
  classifyAttempt,
  evalConserved,
  evalCount,
  evalNoDuplicates,
  evaluateInvariants,
  InvariantSchema,
  invariantDetections,
  itemsOf,
  OP_KEY_MARKER,
  OpLedger,
  opExecutor,
  parseCollectionRef,
  selectPath,
  sumField,
  takeBaselines,
  withOpKey,
} from "../../../src/engines/reliability/invariants.js";
import type { ReliabilityData, RunAnalysis } from "../../../src/engines/reliability/types.js";

const res = (
  status: number,
  kind?: HttpResult["error"] extends infer E ? (E extends { kind: infer K } ? K : never) : never,
): HttpResult => ({
  status,
  bytesIn: 0,
  bytesOut: 0,
  tStart: 0,
  tHeaders: 0,
  tEnd: 1,
  ...(kind ? { error: { kind, message: kind } } : {}),
});

describe("paths and collections", () => {
  const body = {
    items: [
      { id: "o1", meta: { key: "k1" }, lines: [{ qty: 2 }, { qty: 3 }] },
      { id: "o2", meta: { key: "k1" }, lines: [{ qty: 1 }] },
      { id: 3, meta: { key: 7 }, lines: [] },
    ],
  };
  it("selectPath follows dots, indexes and wildcards", () => {
    expect(selectPath(body, "items.0.meta.key")).toEqual(["k1"]);
    expect(selectPath(body, "items.*.lines.*.qty")).toEqual([2, 3, 1]);
    expect(selectPath(body, "items[].lines[0].qty")).toEqual([2, 1]);
    expect(selectPath(body, "items.*.nope")).toEqual([]);
    expect(selectPath(body, "")).toEqual([body]);
  });
  it("itemsOf finds the array (explicit path, root array, items/data)", () => {
    expect(itemsOf(body)).toHaveLength(3);
    expect(itemsOf([1, 2])).toEqual([1, 2]);
    expect(itemsOf({ data: [1] })).toEqual([1]);
    expect(itemsOf({ x: { y: [5] } }, "x.y")).toEqual([5]);
    expect(() => itemsOf({ x: 1 })).toThrow(/no item array/);
    expect(() => itemsOf({ x: 1 }, "x")).toThrow(/not an array/);
  });
  it("sumField sums numbers (and numeric strings) at a wildcard path", () => {
    expect(sumField(body.items, "lines.*.qty")).toEqual({ sum: 6, values: 3 });
    expect(sumField([{ s: "4.5" }, { s: "x" }, { s: 1 }], "s")).toEqual({ sum: 5.5, values: 2 });
  });
  it("parseCollectionRef: method + path relative to the target origin", () => {
    const a = parseCollectionRef("GET /orders?page=1", "http://127.0.0.1:3000/app");
    expect([a.method, a.url.href]).toEqual(["GET", "http://127.0.0.1:3000/orders?page=1"]);
    expect(parseCollectionRef("/x", "http://h:1").method).toBe("GET");
    expect(parseCollectionRef("post http://o:2/y", "http://h:1").url.origin).toBe("http://o:2");
  });
});

describe("invariant evaluators", () => {
  it("no-duplicates: groups by key, only workload keys by default", () => {
    const items = [
      { id: "a", k: "sw-x-r0-1" },
      { id: "b", k: "sw-x-r0-1" },
      { id: "c", k: "sw-x-r0-1" },
      { id: "d", k: "sw-x-r0-2" },
      { id: "e", k: "old" },
      { id: "f", k: "old" },
      { id: "g" },
    ];
    const ours = (k: string) => k.startsWith("sw-x-");
    const r = evalNoDuplicates(items, "k", "id", ours);
    expect(r.checked).toBe(4);
    expect(r.distinct).toBe(2);
    expect(r.unkeyed).toBe(1);
    expect(r.extra).toBe(2);
    expect(r.duplicates).toEqual([{ key: "sw-x-r0-1", count: 3, ids: ["a", "b", "c"] }]);
    const all = evalNoDuplicates(items, "k", "id", () => true);
    expect(all.duplicates.map((d) => d.key)).toEqual(["sw-x-r0-1", "old"]);
  });
  it("count-matches: [confirmed, confirmed + ambiguous] × perOperation", () => {
    expect(evalCount(10, 15, { confirmed: 5, ambiguous: 0 })).toMatchObject({ held: true, direction: "ok" });
    expect(evalCount(10, 17, { confirmed: 5, ambiguous: 2 })).toMatchObject({
      held: true,
      expected: { min: 5, max: 7 },
    });
    expect(evalCount(10, 18, { confirmed: 5, ambiguous: 2 })).toMatchObject({
      held: false,
      direction: "excess",
      observed: 8,
    });
    expect(evalCount(10, 14, { confirmed: 5, ambiguous: 2 })).toMatchObject({
      held: false,
      direction: "deficit",
    });
    expect(evalCount(0, 10, { confirmed: 5, ambiguous: 0 }, 2)).toMatchObject({ held: true });
  });
  it("conserved: constant by default, or perOperation × ops ± tolerance (negative per-op too)", () => {
    expect(evalConserved(100, 100, { confirmed: 9, ambiguous: 3 })).toMatchObject({ held: true });
    expect(evalConserved(100, 99, { confirmed: 9, ambiguous: 3 })).toMatchObject({
      held: false,
      direction: "deficit",
    });
    expect(evalConserved(100, 99.5, { confirmed: 0, ambiguous: 0 }, 0, 0.5)).toMatchObject({ held: true });
    // stock −1 per order: 5 confirmed, 2 ambiguous → Δ ∈ [−7, −5]
    expect(evalConserved(100, 94, { confirmed: 5, ambiguous: 2 }, -1)).toMatchObject({
      held: true,
      expected: { min: -7, max: -5 },
    });
    expect(evalConserved(100, 90, { confirmed: 5, ambiguous: 2 }, -1)).toMatchObject({
      held: false,
      direction: "deficit",
    });
    expect(evalConserved(0.1, 0.30000000000000004, { confirmed: 2, ambiguous: 0 }, 0.1)).toMatchObject({
      held: true,
    });
  });
});

describe("ledger and keyed retries", () => {
  it("classifies attempts (unsent / ambiguous / rejected / ok)", () => {
    expect(classifyAttempt(res(201))).toBe("ok");
    expect(classifyAttempt(res(409))).toBe("rejected");
    expect(classifyAttempt(res(503))).toBe("ambiguous");
    expect(classifyAttempt(res(0, "timeout"))).toBe("ambiguous");
    expect(classifyAttempt(res(0, "econnreset"))).toBe("ambiguous");
    expect(classifyAttempt(res(0, "econnrefused"))).toBe("unsent");
    expect(classifyAttempt(res(0, "aborted"))).toBe("aborted");
  });
  it("records exact counters; a 4xx after an ambiguous attempt stays ambiguous; detail is bounded", () => {
    const l = new OpLedger("sw-t-r0", 2);
    l.record("r", l.nextKey(), ["ok"], [201], "steady");
    l.phase = "fault";
    l.record("r", l.nextKey(), ["ambiguous", "rejected"], [0, 409], l.phase);
    l.record("r", l.nextKey(), ["ambiguous", "ambiguous", "ambiguous"], [0, 0, 0], l.phase);
    l.record("r", l.nextKey(), ["rejected"], [400], "recovery");
    l.record("r", l.nextKey(), ["unsent"], [0], "recovery");
    expect(l.routeCounts("r")).toEqual({
      ops: 5,
      confirmed: 1,
      rejected: 1,
      ambiguous: 2,
      unsent: 1,
      aborted: 0,
      retried: 2,
      attempts: 8,
      retriedDuringFault: 2,
    });
    expect(l.get("sw-t-r0-2")).toMatchObject({
      outcome: "ambiguous",
      attempts: 2,
      phase: "fault",
      statuses: [0, 409],
    });
    expect(l.get("sw-t-r0-3")).toBeUndefined(); // bounded detail
    expect(l.untracked).toBe(3);
    expect(l.owns("sw-t-r0-17")).toBe(true);
    expect(l.owns("sw-t-r0-x")).toBe(false);
    expect(l.owns("sw-t-r1-1")).toBe(false);
  });
  it("withOpKey sets the header and substitutes the marker in path, headers and body", () => {
    const req: HttpRequestSpec = {
      origin: "http://h",
      method: "POST",
      path: `/x/${OP_KEY_MARKER}`,
      headers: ["Idempotency-Key", "stale", "x-req", `id-${OP_KEY_MARKER}`, "content-length", "30"],
      body: Buffer.from(`{"clientRequestId":"${OP_KEY_MARKER}"}`),
    };
    const out = withOpKey(req, "sw-a-r0-1", "Idempotency-Key");
    expect(out.path).toBe("/x/sw-a-r0-1");
    expect(out.body).toBe('{"clientRequestId":"sw-a-r0-1"}');
    expect(out.headers).toEqual([
      "x-req",
      "id-sw-a-r0-1",
      "Idempotency-Key",
      "sw-a-r0-1",
      "content-length",
      "31",
    ]);
    expect(withOpKey({ origin: "o", method: "GET", path: "/" }, "k", false).headers).toEqual([]);
  });
  it("opExecutor retries with the SAME key, records one logical op, returns the last attempt", async () => {
    const seen: string[] = [];
    const script = [res(0, "timeout"), res(503), res(201)];
    const inner: HttpExecutor = {
      async execute(req) {
        const h = Array.isArray(req.headers) ? req.headers : Object.entries(req.headers ?? {}).flat();
        seen.push(h[h.indexOf("Idempotency-Key") + 1] as string);
        const r = script.shift() as HttpResult;
        return { ...r, tStart: seen.length * 10, tEnd: seen.length * 10 + 5 };
      },
      inFlight: 0,
      openSockets: 0,
      close: async () => {},
    };
    const ledger = new OpLedger("sw-q-r0");
    const sleeps: number[] = [];
    const ex = opExecutor(inner, ledger, {
      routeHeader: "x-sw-route",
      idempotency: new Map([
        [
          "orders",
          { header: "Idempotency-Key", retries: 3, backoff: 10, retryOn: ["timeout", "5xx", "transport"] },
        ],
      ]),
      counted: new Set(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r = await ex.execute({
      origin: "o",
      method: "POST",
      path: "/orders",
      headers: { "x-sw-route": "orders" },
    });
    expect(r.status).toBe(201);
    expect(r.tStart).toBe(10); // logical latency from the first attempt
    expect(seen).toEqual(["sw-q-r0-1", "sw-q-r0-1", "sw-q-r0-1"]);
    expect(sleeps).toEqual([10, 20]);
    expect(seen.length).toBe(3);
    expect(ledger.routeCounts("orders")).toMatchObject({ ops: 1, confirmed: 1, retried: 1, attempts: 3 });
    // 4xx is not retried; untracked routes pass straight through
    script.push(res(409), res(200));
    await ex.execute({ origin: "o", method: "POST", path: "/orders", headers: { "x-sw-route": "orders" } });
    expect(ledger.routeCounts("orders")).toMatchObject({ ops: 2, rejected: 1 });
    await ex.execute({
      origin: "o",
      method: "GET",
      path: "/",
      headers: { "x-sw-route": "browse", "Idempotency-Key": "-" },
    });
    expect(ledger.counts.has("browse")).toBe(false);
    expect(seen.at(-1)).toBe("-"); // passed through untouched
  });
});

/** Fake fetcher: collections by path; `after()` switches to the post-run state. */
function fakeFetcher(before: Record<string, unknown[]>, after: Record<string, unknown[]>) {
  let state = before;
  const f: CollectionFetcher & { after(): void } = {
    async items(c: CollectionSpec) {
      const p = parseCollectionRef(c.collection, "http://t").url.pathname;
      const v = state[p];
      if (!v) throw new Error(`GET ${p}: HTTP 404`);
      return v;
    },
    after() {
      state = after;
    },
  };
  return f;
}

describe("evaluateInvariants + detections + trust ladder", () => {
  const invariants = [
    InvariantSchema.parse({ type: "no-duplicates", name: "by-key", collection: "/orders", key: "key" }),
    InvariantSchema.parse({ type: "count-matches", name: "count", collection: "/orders" }),
    InvariantSchema.parse({
      type: "conserved",
      name: "stock+sold",
      terms: [
        { collection: "/stock", field: "n" },
        { collection: "/orders", field: "qty" },
      ],
    }),
    InvariantSchema.parse({
      type: "count-matches",
      name: "broken",
      collection: "/missing",
      routes: ["orders"],
    }),
  ];

  async function evaluate(dupes: boolean) {
    const ledger = new OpLedger("sw-z-r0");
    const k1 = ledger.nextKey();
    const k2 = ledger.nextKey();
    ledger.record("orders", k1, ["ok"], [201], "steady");
    ledger.phase = "fault";
    ledger.record("orders", k2, ["ambiguous", "ambiguous", "ok"], [0, 0, 201], "fault");
    const old = { id: "o0", key: "legacy", qty: 1 };
    const created = dupes
      ? [
          { id: "o1", key: k1, qty: 1 },
          { id: "o2", key: k2, qty: 1 },
          { id: "o3", key: k2, qty: 1 },
          { id: "o4", key: k2, qty: 1 },
        ]
      : [
          { id: "o1", key: k1, qty: 1 },
          { id: "o2", key: k2, qty: 1 },
        ];
    const f = fakeFetcher(
      { "/orders": [old], "/stock": [{ n: 10 }] },
      { "/orders": [old, ...created], "/stock": [{ n: 10 - created.length }] },
    );
    const baselines = await takeBaselines(invariants, f);
    f.after();
    return evaluateInvariants(invariants, baselines, f, ledger, ["orders"]);
  }

  it("all held for an idempotent server; a missing collection is an error, not a violation", async () => {
    const r = await evaluate(false);
    expect(r.map((x) => [x.name, x.status])).toEqual([
      ["by-key", "held"],
      ["count", "held"],
      ["stock+sold", "held"],
      ["broken", "error"],
    ]);
    expect(r[3]?.detail).toMatch(/not evaluated: baseline: GET \/missing: HTTP 404/);
    expect(invariantDetections(r, { dependency: "db", faults: ["x"], redact: (s) => s })).toEqual([]);
  });

  it("duplicates: no-duplicates names the key, count-matches sees the excess; stock+sold is still conserved", async () => {
    const r = await evaluate(true);
    const by = new Map(r.map((x) => [x.name, x]));
    expect(by.get("by-key")).toMatchObject({
      status: "violated",
      duplicateKeys: 1,
      extraResources: 2,
      checked: 4,
    });
    expect(by.get("by-key")?.duplicates?.[0]).toMatchObject({
      key: "sw-z-r0-2",
      count: 3,
      ids: ["o2", "o3", "o4"],
      route: "orders",
      attempts: 3,
      phase: "fault",
      outcome: "ok",
    });
    expect(by.get("count")).toMatchObject({
      status: "violated",
      direction: "excess",
      observed: 4,
      expected: { min: 2, max: 2 },
    });
    expect(by.get("stock+sold")?.status).toBe("held");

    const det = invariantDetections(r, {
      dependency: "payments",
      faults: ["connection reset"],
      redact: (s) => s.replaceAll("o3", "«redacted»"),
    });
    expect(det.map((d) => [d.ruleId, d.group])).toEqual([
      ["reliability/duplicate-operation", "reliability/duplicate-operation|by-key"],
      ["reliability/duplicate-operation", "reliability/duplicate-operation|count"],
    ]);
    const notes = det[0]?.notes ?? [];
    expect(notes[0]).toBe(
      "key sw-z-r0-2: 3 resources (ids o2, «redacted», o4); 3 attempt(s) [error, error, 201], outcome ok, first sent while the fault was active",
    );
    expect(notes).toContain("Fault active during the run: connection reset on payments");
    expect(det[1]?.metrics.find((m) => m.metric === "invariant.observed")?.value).toBe(4);
    expect(
      det[1]?.notes.some((n) =>
        n.includes("1 retried with the same key, 1 of them first sent while the fault was active"),
      ),
    ).toBe(true);
  });

  it("lost writes and conservation breaks get their own rules", () => {
    const det = invariantDetections(
      [
        {
          name: "c",
          type: "count-matches",
          status: "violated",
          detail: "d",
          expected: { min: 5, max: 6 },
          observed: 3,
          direction: "deficit",
          before: 0,
          after: 3,
        },
        {
          name: "s",
          type: "conserved",
          status: "violated",
          detail: "d",
          expected: { min: 0, max: 0 },
          observed: 2,
          direction: "excess",
          before: 10,
          after: 12,
        },
      ],
      { dependency: "db", faults: [], redact: (s) => s },
    );
    expect(det.map((d) => d.ruleId)).toEqual(["reliability/lost-write", "reliability/invariant-violated"]);
    expect(det[0]?.title).toContain("Lost writes");
  });

  it("observation in a single run, reproduced-defect when hit in every one of ≥ 2 runs", async () => {
    const results = await evaluate(true);
    const detections = invariantDetections(results, { dependency: "d", faults: ["f"], redact: (s) => s }).map(
      (d) => ({
        ...d,
        kind: "detector" as const,
      }),
    );
    const run = (index: number, withHits: boolean) =>
      ({
        index,
        fault: { applied: true, durationMs: 1000, abortedEarly: null },
        steady: stats,
        during: stats,
        recovery: null,
        checks: [],
        detections: withHits ? detections : [],
        invariants: results,
      }) as unknown as RunAnalysis;
    const stats = { requests: 10, errors: 0, errorRate: 0, timeoutRate: 0, p95: 5 };
    const data = (runs: RunAnalysis[]) =>
      ({
        scenario: "s",
        dependency: "d",
        injector: "builtin",
        faults: ["f"],
        phases: { steadyMs: 1, faultMs: 1, recoveryMs: 1 },
        workload: { rate: 1, arrival: "poisson", routes: [] },
        runs,
      }) as unknown as ReliabilityData;
    const input = parseReliabilityInput({ target: "http://127.0.0.1:1", scenario: "s", dependency: "d" });
    const ctx = {
      newId: () => "id",
      clock: { now: () => 0, isoNow: () => "2026-01-01T00:00:00.000Z", sleep: async () => {} },
    };
    const one = buildFindings(data([run(0, true)]), ctx, input).findings.filter(
      (f) => f.ruleId === "reliability/duplicate-operation",
    );
    expect(one.map((f) => f.classification)).toEqual(["observation", "observation"]);
    const two = buildFindings(data([run(0, true), run(1, true)]), ctx, input).findings.filter(
      (f) => f.ruleId === "reliability/duplicate-operation",
    );
    expect(two.map((f) => f.classification)).toEqual(["reproduced-defect", "reproduced-defect"]);
    expect(
      two[0]?.evidence.some((e) => e.kind === "note" && e.text.startsWith("key sw-z-r0-2: 3 resources")),
    ).toBe(true);
    const flaky = buildFindings(data([run(0, true), run(1, false)]), ctx, input).findings.filter(
      (f) => f.ruleId === "reliability/duplicate-operation",
    );
    expect(flaky.map((f) => f.classification)).toEqual(["observation", "observation"]);
  });
});

describe("configuration", () => {
  const base = {
    target: "http://127.0.0.1:1/",
    scenario: "dependency-5xx",
    dependency: "payments",
    dependencies: { payments: { upstream: "http://127.0.0.1:2" } },
  };
  const approved = () => ({ safety: createSafetyGuard({}, { interactive: false, approve: true }) });

  it("parses idempotency + invariants with defaults", () => {
    const p = parseReliabilityInput({
      ...base,
      workload: { routes: [{ name: "orders", method: "POST", path: "/orders", idempotency: {} }] },
      invariants: [{ type: "no-duplicates", collection: "GET /orders", key: "idempotencyKey" }],
    });
    expect(p.workload.routes[0]?.idempotency).toEqual({
      header: "Idempotency-Key",
      retries: 2,
      backoff: 100,
      retryOn: ["transport", "timeout", "5xx"],
    });
    expect(p.invariants[0]).toMatchObject({
      type: "no-duplicates",
      id: "id",
      scope: "workload",
      headers: {},
    });
    expect(parseReliabilityInput(base).invariants).toEqual([]);
    expect(() =>
      parseReliabilityInput({ ...base, invariants: [{ type: "unique", collection: "/x" }] }),
    ).toThrow(ConfigError);
    expect(() => parseReliabilityInput({ ...base, invariants: [{ type: "conserved", terms: [] }] })).toThrow(
      ConfigError,
    );
  });

  it("rejects invariants that reference unknown routes or cannot attribute operations", async () => {
    const routes = [{ name: "orders", method: "POST", path: "/orders" }];
    await expect(
      runReliability(
        {
          ...base,
          workload: { routes },
          invariants: [{ type: "no-duplicates", collection: "/orders", key: "k" }],
        },
        approved(),
      ),
    ).rejects.toThrow(/no-duplicates needs a workload route with `idempotency`/);
    await expect(
      runReliability(
        { ...base, workload: { routes }, invariants: [{ type: "count-matches", collection: "/orders" }] },
        approved(),
      ),
    ).rejects.toThrow(/needs `routes`/);
    await expect(
      runReliability(
        {
          ...base,
          workload: { routes },
          invariants: [{ type: "count-matches", collection: "/orders", routes: ["nope"] }],
        },
        approved(),
      ),
    ).rejects.toThrow(/route "nope" is not a workload route/);
    await expect(
      runReliability(
        {
          ...base,
          workload: { routes },
          invariants: [
            { type: "count-matches", collection: "/orders", routes: ["orders"], headersFrom: "x" },
          ],
        },
        approved(),
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
