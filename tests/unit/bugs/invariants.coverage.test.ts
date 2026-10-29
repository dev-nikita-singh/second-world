/**
 * Property + edge tests for the Bug Hunter's built-in concurrency invariants and invariant
 * loading (src/engines/bugs/invariants.ts; docs/03-engines/api-bug-hunter.md §1.4, docs/04 §7.5).
 * Owner: sw-coverage (Wave 5).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import type { Exchange } from "../../../src/engines/bugs/http.js";
import {
  checkBuiltin,
  checkMixed,
  invariantMessage,
  loadInvariant,
  toInvariantExchange,
} from "../../../src/engines/bugs/invariants.js";

function ex(status: number, t: number, extra: Partial<Exchange> = {}): Exchange {
  return {
    operation: "op",
    method: "POST",
    url: "http://127.0.0.1/x",
    requestHeaders: {},
    status,
    responseHeaders: {},
    contentType: "application/json",
    durationMs: 1,
    tStart: t * 10,
    tEnd: t * 10 + 5, // sequential, non-overlapping by default
    rateLimitedRetries: 0,
    ...extra,
  };
}
/** All requests overlap in time. */
const concurrent = (e: Exchange): Exchange => ({ ...e, tStart: 0, tEnd: 1000 });

describe("checkBuiltin: stock", () => {
  it("property: a correct sequential history (first `initial` takes succeed) is linearizable", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 8 }), (initial, n) => {
        const h = Array.from({ length: n }, (_, i) => ex(i < initial ? 201 : 409, i));
        expect(checkBuiltin({ kind: "linearizable", model: "stock", initial, take: 1 }, h).message).toBeNull();
      }),
    );
  });

  it("property: more successes than stock is a violation, even fully concurrent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 3 }), (initial, extra) => {
        const h = Array.from({ length: initial + extra }, (_, i) => concurrent(ex(200, i)));
        const r = checkBuiltin({ kind: "linearizable", model: "stock", initial, take: 1 }, h);
        expect(r.message).toMatch(new RegExp(`${initial + extra} of ${initial + extra} concurrent takes succeeded`));
        expect(r.linearizability?.result).toBe("violation");
      }),
    );
  });

  it("errors/5xx are ambiguous; blocked exchanges are ignored; default initial is 1", () => {
    const h = [ex(200, 0), ex(503, 1), ex(0, 2, { error: "ECONNRESET" }), ex(200, 3, { blocked: "budget" })];
    expect(checkBuiltin({ kind: "linearizable", model: "stock", take: 1 }, h).message).toBeNull();
    expect(checkBuiltin({ kind: "linearizable", model: "stock", take: 1 }, [ex(200, 0), ex(200, 1)]).message).not.toBeNull();
  });
});

describe("checkBuiltin: other kinds", () => {
  it("max-success counts only 2xx of non-blocked requests", () => {
    const h = [ex(200, 0), ex(201, 1), ex(409, 2), ex(200, 3, { blocked: "mutation" })];
    expect(checkBuiltin({ kind: "max-success", max: 2 }, h).message).toBeNull();
    expect(checkBuiltin({ kind: "max-success", max: 1 }, h).message).toBe("2 of 3 concurrent requests succeeded (max 1)");
  });

  it("same-response compares the pointer value across 2xx responses", () => {
    const same = [ex(200, 0, { json: { id: 1, t: 1 } }), ex(200, 1, { json: { id: 1, t: 2 } }), ex(500, 2, { json: { id: 9 } })];
    expect(checkBuiltin({ kind: "same-response", pointer: "/id" }, same).message).toBeNull();
    expect(checkBuiltin({ kind: "same-response", pointer: "/t" }, same).message).toMatch(/2 distinct values at \/t/);
  });

  it("counter: duplicate returned values are a lost update; distinct values are fine", () => {
    const lost = [ex(200, 0, { json: 1 }), ex(200, 1, { json: { value: 1 } })].map(concurrent);
    expect(checkBuiltin({ kind: "linearizable", model: "counter", take: 1 }, lost).message).toMatch(/Lost update: 2 increments returned only 1/);
    const okay = [ex(200, 0, { json: 1 }), ex(200, 1, { json: 2 }), ex(500, 2)];
    expect(checkBuiltin({ kind: "linearizable", model: "counter", initial: 0, take: 1 }, okay).message).toBeNull();
    expect(checkBuiltin({ kind: "linearizable", model: "counter", take: 1 }, [ex(200, 0, { json: "x" }), ex(200, 1, { json: "x" })]).message).toBeNull();
  });

  it("set: the same element created twice is a violation; 201 then 409 is fine; initial membership respected", () => {
    const m = { kind: "linearizable", model: "set", take: 1 } as const;
    expect(checkBuiltin(m, [ex(201, 0), ex(201, 1)].map(concurrent)).message).toMatch(/created more than once/);
    expect(checkBuiltin(m, [ex(201, 0), ex(409, 1)]).message).toBeNull();
    expect(checkBuiltin({ ...m, initial: ["x"] }, [ex(201, 0)]).message).not.toBeNull();
    expect(checkBuiltin(m, [ex(0, 0, { error: "timeout" })]).message).toBeNull();
  });

  it("register: reads must return the initial value", () => {
    const m = { kind: "linearizable", model: "register", initial: 5, take: 1 } as const;
    expect(checkBuiltin(m, [ex(200, 0, { json: 5 }), ex(200, 1, { json: 5 })]).message).toBeNull();
    expect(checkBuiltin(m, [ex(200, 0, { json: 6 })]).message).toBe("Not linearizable against register");
    expect(checkBuiltin({ kind: "linearizable", model: "register", take: 1 }, [ex(200, 0, { json: null })]).message).toBeNull();
  });
});

describe("checkMixed", () => {
  const test = (mix: unknown[], extra: Record<string, unknown> = {}) => ({ mix, ...extra }) as never;

  it("stock: take then a read showing the old level is a violation; consistent reads pass", () => {
    const inv = { kind: "linearizable", model: "stock", initial: 3, take: 1 } as const;
    const exs = [ex(201, 0), ex(200, 1, { json: { stock: 3 } })];
    const r = checkMixed(inv, test([{ as: "read", pointer: "/stock" }]), exs, [-1, 0]);
    expect(r.message).toMatch(/Not linearizable against stock\(initial 3\) with mixed operations \(1 take, 1 read\)/);
    const good = [ex(201, 0), ex(200, 1, { json: { stock: 2 } }), ex(201, 2)];
    expect(checkMixed(inv, test([{ as: "read", pointer: "/stock" }]), good, [-1, 0, -1]).message).toBeNull();
    // unknown initial stock learnt from reads
    const unknownInit = { kind: "linearizable", model: "stock", take: 1 } as const;
    expect(checkMixed(unknownInit, test([{ as: "read", pointer: "/stock" }]), [ex(200, 0, { json: { stock: 1 } }), ex(201, 1), ex(200, 2, { json: { stock: 1 } })], [0, -1, 0]).message).toMatch(
      /initial unknown, from reads/,
    );
  });

  it("ambiguous statuses (401/403/408/429/5xx/0) allow either outcome", () => {
    const inv = { kind: "linearizable", model: "stock", initial: 1, take: 1 } as const;
    for (const s of [0, 401, 403, 408, 429, 502]) {
      const exs = [ex(s, 0), ex(200, 1, { json: { n: 1 } })];
      expect(checkMixed(inv, test([{ as: "read", pointer: "/n" }]), exs, [-1, 0]).message, String(s)).toBeNull();
    }
  });

  it("counter, register and set models with mixes; irrelevant ops and empty histories are skipped", () => {
    const counter = { kind: "linearizable", model: "counter", initial: 0, take: 1 } as const;
    const exs = [ex(200, 0), ex(200, 1), ex(200, 2, { json: 1 })];
    expect(checkMixed(counter, test([{ as: "inc" }, { as: "read" }]), exs, [-1, 0, 1]).message).toMatch(/counter/);
    expect(checkMixed(counter, test([{ as: "inc" }]), [ex(409, 0)], [0]).message).toBeNull();
    expect(checkMixed(counter, test([{ as: "add" }]), [ex(200, 0)], [0])).toEqual({ message: null });

    const reg = { kind: "linearizable", model: "register", take: 1 } as const;
    const writes = [ex(200, 0, { requestBody: '{"v":7}' }), ex(200, 1, { json: { v: 8 } })];
    expect(checkMixed(reg, test([{ as: "write", pointer: "/v" }, { as: "read", pointer: "/v" }]), writes, [0, 1]).message).toMatch(/register/);
    expect(checkMixed(reg, test([{ as: "write", pointer: "/v" }]), [ex(200, 0, { requestBody: "not json" })], [0]).message).toBeNull();

    const set = { kind: "linearizable", model: "set", take: 1 } as const;
    const adds = [ex(201, 0), ex(201, 1), ex(200, 2, { json: true })];
    expect(checkMixed(set, test([{ as: "add", value: "a" }, { as: "read" }]), adds, [0, 0, 1]).message).toMatch(/set/);
    expect(checkMixed(set, test([{ as: "add", value: "a" }, { as: "remove", value: "a" }, { as: "has", value: "a" }]), [ex(201, 0), ex(404, 1), ex(418, 2)], [0, 1, 2]).message).not.toBeNull();
    expect(checkMixed(set, test([{ as: "add" }]), [ex(201, 0, { blocked: "budget" })], [0])).toEqual({ message: null });
    expect(checkMixed(set, test([]), [ex(201, 0)], [3])).toEqual({ message: null });
  });
});

describe("invariant loading and helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-inv-cov-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads default, named (#export) and object refs; errors for missing modules/exports", async () => {
    writeFileSync(join(dir, "inv.mjs"), "export default () => true; export const check = (x) => x.ok || 'bad'; export const notFn = 1;");
    const d = await loadInvariant("inv.mjs", dir);
    expect(d.name).toBe("inv.mjs");
    const n = await loadInvariant("./inv.mjs#check", dir);
    expect(n.name).toBe("check");
    expect(await n.fn({ ok: false })).toBe("bad");
    const o = await loadInvariant({ module: join(dir, "inv.mjs"), export: "check", name: "named", operations: ["a"] }, "/");
    expect(o).toMatchObject({ name: "named", operations: ["a"] });
    await expect(loadInvariant("missing.mjs", dir)).rejects.toMatchObject({ code: "SW_CONFIG_BUGS_INVARIANT" });
    await expect(loadInvariant("inv.mjs#notFn", dir)).rejects.toThrow(/no function export notFn/);
  });

  it("invariantMessage and toInvariantExchange", () => {
    expect(invariantMessage(false)).toBe("invariant returned false");
    expect(invariantMessage("msg")).toBe("msg");
    expect(invariantMessage({ ok: false })).toBe("invariant returned ok: false");
    expect(invariantMessage({ ok: false, message: "m" })).toBe("m");
    expect(invariantMessage(true)).toBeNull();
    expect(invariantMessage(undefined)).toBeNull();
    expect(invariantMessage({ ok: true })).toBeNull();
    expect(toInvariantExchange(ex(200, 0, { responseBody: "raw", requestBody: "rb" }))).toMatchObject({ body: "raw", requestBody: "rb" });
    expect(toInvariantExchange(ex(200, 0, { json: { a: 1 } })).body).toEqual({ a: 1 });
  });
});
