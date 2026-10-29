import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Bitset } from "../../../src/shared/ds/bitset.js";
import { KeyedMinHeap, MinHeap, TopK } from "../../../src/shared/ds/heap.js";
import { LRUCache } from "../../../src/shared/ds/lru.js";
import { KeyedUnionFind, UnionFind } from "../../../src/shared/ds/union-find.js";

describe("MinHeap", () => {
  it("pop order equals sort", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (xs) => {
        const h = new MinHeap<number>((a, b) => a - b);
        for (const x of xs) h.push(x);
        expect(h.size).toBe(xs.length);
        const out: number[] = [];
        for (let v = h.pop(); v !== undefined; v = h.pop()) out.push(v);
        expect(out).toEqual([...xs].sort((a, b) => a - b));
      }),
    );
  });

  it("interleaved push/pop matches a sorted-array model", () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: -50, max: 50 }), { nil: undefined })), (ops) => {
        const h = new MinHeap<number>((a, b) => a - b);
        const model: number[] = [];
        for (const op of ops) {
          if (op === undefined) {
            model.sort((a, b) => a - b);
            expect(h.pop()).toBe(model.shift());
          } else {
            h.push(op);
            model.push(op);
          }
          expect(h.peek()).toBe(model.length ? Math.min(...model) : undefined);
        }
      }),
    );
  });

  it("replaceTop", () => {
    const h = new MinHeap<number>((a, b) => a - b);
    expect(h.replaceTop(5)).toBeUndefined();
    h.push(3);
    expect(h.replaceTop(10)).toBe(3);
    expect(h.pop()).toBe(5);
    expect(h.pop()).toBe(10);
  });
});

describe("KeyedMinHeap", () => {
  it("pops by key, FIFO on ties, and grows", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 300 }), (keys) => {
        const h = new KeyedMinHeap<number>(2);
        keys.forEach((k, i) => {
          h.push(k, i);
        });
        const expected = keys.map((k, i) => ({ k, i })).sort((a, b) => a.k - b.k || a.i - b.i);
        for (const e of expected) {
          expect(h.peekKey()).toBe(e.k);
          expect(h.pop()).toBe(e.i);
        }
        expect(h.pop()).toBeUndefined();
        expect(h.size).toBe(0);
      }),
    );
  });
});

describe("TopK", () => {
  it("keeps the k largest", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer({ min: 0, max: 10 }), (xs, k) => {
        const t = new TopK<number>(k);
        for (const x of xs) t.offer(x, x);
        const want = [...xs].sort((a, b) => b - a).slice(0, k);
        expect(t.items().map((e) => e.score)).toEqual(want);
      }),
    );
  });
});

describe("LRUCache", () => {
  it("matches a reference model", () => {
    type Op = { t: "get"; k: number } | { t: "set"; k: number; v: number } | { t: "del"; k: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ t: fc.constant("get" as const), k: fc.integer({ min: 0, max: 8 }) }),
      fc.record({ t: fc.constant("set" as const), k: fc.integer({ min: 0, max: 8 }), v: fc.integer() }),
      fc.record({ t: fc.constant("del" as const), k: fc.integer({ min: 0, max: 8 }) }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.array(opArb, { maxLength: 100 }), (max, ops) => {
        const evicted: number[] = [];
        const c = new LRUCache<number, number>(max, (k) => evicted.push(k));
        let model: { k: number; v: number }[] = []; // least recent first
        const modelEvicted: number[] = [];
        for (const op of ops) {
          const i = model.findIndex((e) => e.k === op.k);
          if (op.t === "get") {
            const e = i >= 0 ? model.splice(i, 1)[0] : undefined;
            if (e) model.push(e);
            expect(c.get(op.k)).toBe(e?.v);
          } else if (op.t === "set") {
            if (i >= 0) model.splice(i, 1);
            model.push({ k: op.k, v: op.v });
            while (model.length > max) modelEvicted.push((model.shift() as { k: number }).k);
            c.set(op.k, op.v);
          } else {
            expect(c.delete(op.k)).toBe(i >= 0);
            model = model.filter((e) => e.k !== op.k);
          }
          expect(c.keys()).toEqual(model.map((e) => e.k));
          expect(c.size).toBe(model.length);
        }
        expect(evicted).toEqual(modelEvicted);
      }),
    );
  });

  it("peek does not change recency; invalid max throws", () => {
    const c = new LRUCache<string, number>(2);
    c.set("a", 1).set("b", 2);
    expect(c.peek("a")).toBe(1);
    c.set("c", 3);
    expect(c.has("a")).toBe(false);
    expect(() => new LRUCache(0)).toThrow(RangeError);
  });
});

describe("Bitset", () => {
  it("matches a Set model, popcount and toArray", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 200 })
          .chain((n) =>
            fc.tuple(fc.constant(n), fc.array(fc.tuple(fc.boolean(), fc.nat({ max: Math.max(0, n - 1) })))),
          ),
        ([n, ops]) => {
          const b = new Bitset(n);
          const model = new Set<number>();
          for (const [on, i] of ops) {
            if (n === 0) break;
            if (on) {
              expect(b.testAndSet(i)).toBe(!model.has(i));
              model.add(i);
            } else {
              b.clear(i);
              model.delete(i);
            }
          }
          expect(b.count()).toBe(model.size);
          expect(b.toArray()).toEqual([...model].sort((x, y) => x - y));
          for (let i = 0; i < n; i++) expect(b.test(i)).toBe(model.has(i));
        },
      ),
    );
  });

  it("or/and/ratio/bounds", () => {
    const a = new Bitset(64).set(0).set(31).set(32).set(63);
    const b = new Bitset(64).set(31).set(40);
    expect(a.clone().or(b).count()).toBe(5);
    expect(a.clone().and(b).toArray()).toEqual([31]);
    expect(a.ratio()).toBe(4 / 64);
    expect(() => a.test(64)).toThrow(RangeError);
    expect(() => a.or(new Bitset(10))).toThrow(RangeError);
    a.reset();
    expect(a.count()).toBe(0);
  });
});

describe("UnionFind", () => {
  it("matches a naive labelling model", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 30 })
          .chain((n) =>
            fc.tuple(fc.constant(n), fc.array(fc.tuple(fc.nat({ max: n - 1 }), fc.nat({ max: n - 1 })))),
          ),
        ([n, pairs]) => {
          const uf = new UnionFind(n);
          const label = Array.from({ length: n }, (_, i) => i);
          for (const [a, b] of pairs) {
            const la = label[a] as number;
            const lb = label[b] as number;
            expect(uf.union(a, b)).toBe(la !== lb);
            if (la !== lb) for (let i = 0; i < n; i++) if (label[i] === lb) label[i] = la;
          }
          for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++) expect(uf.connected(i, j)).toBe(label[i] === label[j]);
          expect(uf.count).toBe(new Set(label).size);
        },
      ),
    );
  });

  it("deep chains do not recurse; add() grows", () => {
    const n = 200_000;
    const uf = new UnionFind(n);
    for (let i = 1; i < n; i++) uf.union(i - 1, i);
    expect(uf.count).toBe(1);
    expect(uf.connected(0, n - 1)).toBe(true);
    const id = uf.add();
    expect(id).toBe(n);
    expect(uf.count).toBe(2);
    expect(() => uf.find(n + 5)).toThrow(RangeError);
  });

  it("keyed wrapper groups entities", () => {
    const k = new KeyedUnionFind();
    k.union("orders-svc", "OrdersService");
    k.union("OrdersService", "orders.internal:8080");
    k.add("payments");
    expect(k.connected("orders-svc", "orders.internal:8080")).toBe(true);
    expect(k.connected("orders-svc", "payments")).toBe(false);
    expect(k.connected("x", "x")).toBe(true);
    expect(k.find("orders.internal:8080")).toBe(k.find("orders-svc"));
    expect(k.count).toBe(2);
    expect(k.groups()).toEqual([["orders-svc", "OrdersService", "orders.internal:8080"], ["payments"]]);
    for (let i = 0; i < 50_000; i++) k.union(`a${i}`, `a${i + 1}`);
    expect(k.connected("a0", "a50000")).toBe(true);
  });
});
