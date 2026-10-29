import { describe, expect, it } from "vitest";
import {
  checkLinearizable,
  type HistoryOp,
  type StockOp,
  stockModel,
  stockRwModel,
} from "../../../src/engines/bugs/algorithms/linearizability.js";
import type { Exchange } from "../../../src/engines/bugs/http.js";
import { checkMixed } from "../../../src/engines/bugs/invariants.js";
import { ConcurrencyTestSchema } from "../../../src/engines/bugs/schema.js";

const take = (ok: boolean | undefined, call: number, ret: number): HistoryOp<StockOp, boolean | number> => ({
  input: { op: "take", n: 1 },
  output: ok,
  call,
  ret,
});
const read = (v: number | undefined, call: number, ret: number): HistoryOp<StockOp, boolean | number> => ({
  input: { op: "read" },
  output: v,
  call,
  ret,
});

describe("stock read/take model (mixed histories)", () => {
  it("accepts a linearizable interleaving of takes and reads", () => {
    const h = [read(1, 0, 2), take(true, 1, 10), read(1, 3, 4), take(false, 5, 12), read(0, 13, 14)];
    expect(checkLinearizable(h, stockRwModel(1)).result).toBe("ok");
  });

  it("a concurrent read may see the value before or after an overlapping take", () => {
    const before = [take(true, 0, 10), read(3, 1, 9)];
    const after = [take(true, 0, 10), read(2, 1, 9)];
    expect(checkLinearizable(before, stockRwModel(3)).result).toBe("ok");
    expect(checkLinearizable(after, stockRwModel(3)).result).toBe("ok");
  });

  it("detects a lost update that a take-only check cannot see", () => {
    // stock 5; three concurrent successful takes; a later read still sees 4.
    const takes = [take(true, 2, 10), take(true, 2, 10), take(true, 3, 11)];
    const h = [read(5, 0, 1), ...takes, read(4, 12, 13)];
    expect(checkLinearizable(h, stockRwModel()).result).toBe("violation");
    // The takes alone are linearizable against stock(5): only the mixed history exposes the race.
    const onlyTakes = takes.map((t) => ({ ...t, input: { take: 1 }, output: t.output as boolean }));
    expect(checkLinearizable(onlyTakes, stockModel(5)).result).toBe("ok");
  });

  it("detects a read that goes back in time", () => {
    const h = [take(true, 0, 5), read(0, 6, 7), read(1, 8, 9)];
    expect(checkLinearizable(h, stockRwModel(1)).result).toBe("violation");
  });

  it("oversell: two successful takes of the last item", () => {
    const h = [take(true, 0, 10), take(true, 0, 10), read(0, 11, 12)];
    expect(checkLinearizable(h, stockRwModel(1)).result).toBe("violation");
  });

  it("unknown outcomes (timeouts) accept both effects", () => {
    const h = [read(2, 0, 1), take(undefined, 2, Infinity), read(2, 3, 4)];
    expect(checkLinearizable(h, stockRwModel()).result).toBe("ok");
    const h2 = [read(2, 0, 1), take(undefined, 2, Infinity), read(1, 3, 4)];
    expect(checkLinearizable(h2, stockRwModel()).result).toBe("ok");
  });

  it("an unknown initial value is fixed by the first linearized read", () => {
    expect(checkLinearizable([read(7, 0, 1), take(true, 2, 3), read(6, 4, 5)], stockRwModel()).result).toBe(
      "ok",
    );
    expect(checkLinearizable([read(7, 0, 1), take(true, 2, 3), read(7, 4, 5)], stockRwModel()).result).toBe(
      "violation",
    );
  });

  it("is bounded: a step cap yields 'unknown', never unbounded work", () => {
    const h = Array.from({ length: 40 }, (_, i) =>
      i % 2 ? read(undefined, 0, 100) : take(undefined, 0, 100),
    );
    const r = checkLinearizable(h, stockRwModel(100), { maxSteps: 50 });
    expect(["unknown", "ok"]).toContain(r.result);
    expect(r.steps).toBeLessThanOrEqual(51);
  });
});

function ex(status: number, t: [number, number], json?: unknown, requestBody?: unknown): Exchange {
  const e: Exchange = {
    operation: "",
    method: "GET",
    url: "http://127.0.0.1/x",
    requestHeaders: {},
    status,
    responseHeaders: {},
    contentType: "application/json",
    durationMs: t[1] - t[0],
    tStart: t[0],
    tEnd: t[1],
    rateLimitedRetries: 0,
  };
  if (json !== undefined) e.json = json;
  if (requestBody !== undefined) e.requestBody = JSON.stringify(requestBody);
  return e;
}

describe("checkMixed (POST /orders = take, GET /products/{id} = read)", () => {
  const test = ConcurrencyTestSchema.parse({
    operation: "POST /orders",
    burst: 3,
    mix: [
      { operation: "GET /products/{id}", as: "read", pointer: "/stock", phase: "before" },
      { operation: "GET /products/{id}", as: "read", pointer: "/stock", count: 2 },
      { operation: "GET /products/{id}", as: "read", pointer: "/stock", phase: "after" },
    ],
  });
  const inv = { kind: "linearizable" as const, model: "stock" as const, take: 1 };

  it("reports the lost update with the impossible history", () => {
    const exs = [
      ex(200, [0, 1], { stock: 100 }),
      ex(201, [2, 9]),
      ex(201, [2, 9]),
      ex(201, [2, 10]),
      ex(200, [2, 4], { stock: 100 }),
      ex(200, [2, 5], { stock: 99 }),
      ex(200, [11, 12], { stock: 99 }),
    ];
    const r = checkMixed(inv, test, exs, [0, -1, -1, -1, 1, 1, 2]);
    expect(r.linearizability?.result).toBe("violation");
    expect(r.message).toMatch(/mixed operations \(\d take, \d read|mixed operations/);
    expect(r.message).toContain("take→ok(201)");
    expect(r.message).toContain("read→99");
  });

  it("passes a correct (atomic) implementation", () => {
    const exs = [
      ex(200, [0, 1], { stock: 100 }),
      ex(201, [2, 9]),
      ex(201, [2, 9]),
      ex(201, [2, 10]),
      ex(200, [2, 4], { stock: 100 }),
      ex(200, [2, 5], { stock: 98 }),
      ex(200, [11, 12], { stock: 97 }),
    ];
    expect(checkMixed(inv, test, exs, [0, -1, -1, -1, 1, 1, 2]).message).toBeNull();
  });

  it("out-of-stock refusals (409) and 5xx are modelled (refused / unknown)", () => {
    const exs = [
      ex(200, [0, 1], { stock: 1 }),
      ex(201, [2, 9]),
      ex(409, [2, 9]),
      ex(502, [2, 10]),
      ex(200, [11, 12], { stock: 0 }),
    ];
    expect(checkMixed(inv, test, exs, [0, -1, -1, -1, 2]).message).toBeNull();
    const oversell = [
      ex(200, [0, 1], { stock: 1 }),
      ex(201, [2, 9]),
      ex(201, [2, 9]),
      ex(200, [11, 12], { stock: 0 }),
    ];
    expect(checkMixed(inv, test, oversell, [0, -1, -1, 2]).linearizability?.result).toBe("violation");
  });

  it("counter: concurrent increments with a final read", () => {
    const t = ConcurrencyTestSchema.parse({
      operation: "POST /counter",
      burst: 2,
      mix: [{ operation: "GET /counter", as: "read", pointer: "/value", phase: "after" }],
    });
    const c = { kind: "linearizable" as const, model: "counter" as const, initial: 0, take: 1 };
    const lost = [ex(200, [0, 5]), ex(200, [0, 5]), ex(200, [6, 7], { value: 1 })];
    expect(checkMixed(c, t, lost, [-1, -1, 0]).linearizability?.result).toBe("violation");
    const good = [ex(200, [0, 5]), ex(200, [0, 5]), ex(200, [6, 7], { value: 2 })];
    expect(checkMixed(c, t, good, [-1, -1, 0]).message).toBeNull();
  });

  it("register: writes (value from the request body) and reads", () => {
    const t = ConcurrencyTestSchema.parse({
      operation: "PUT /cfg",
      burst: 2,
      pointer: "/v",
      mix: [{ operation: "GET /cfg", as: "read", pointer: "/v", phase: "after" }],
    });
    const r = { kind: "linearizable" as const, model: "register" as const, initial: 0, take: 1 };
    const ok = [
      ex(200, [0, 5], undefined, { v: 1 }),
      ex(200, [0, 5], undefined, { v: 2 }),
      ex(200, [6, 7], { v: 2 }),
    ];
    expect(checkMixed(r, t, ok, [-1, -1, 0]).message).toBeNull();
    const bad = [
      ex(200, [0, 5], undefined, { v: 1 }),
      ex(200, [0, 5], undefined, { v: 2 }),
      ex(200, [6, 7], { v: 3 }),
    ];
    expect(checkMixed(r, t, bad, [-1, -1, 0]).linearizability?.result).toBe("violation");
  });

  it("schema: burst + concurrent mix requests are capped at 64", () => {
    expect(() =>
      ConcurrencyTestSchema.parse({
        operation: "POST /orders",
        burst: 60,
        mix: [{ operation: "GET /x", as: "read", count: 10 }],
      }),
    ).toThrow(/64/);
  });
});
