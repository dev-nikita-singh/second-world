import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../../src/shared/ds/ring-buffer.js";

type Op = { t: "push"; v: number } | { t: "shift" } | { t: "pop" } | { t: "remove"; v: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("push" as const), v: fc.integer({ min: 0, max: 20 }) }),
  fc.record({ t: fc.constant("shift" as const) }),
  fc.record({ t: fc.constant("pop" as const) }),
  fc.record({ t: fc.constant("remove" as const), v: fc.integer({ min: 0, max: 20 }) }),
);

function runModel(ops: Op[], cap: number, mode: "grow" | "overwrite" | "reject"): void {
  const rb = new RingBuffer<number>(
    cap,
    mode === "grow" ? { grow: true } : mode === "overwrite" ? { overwrite: true } : {},
  );
  const realCap = rb.capacity;
  const model: number[] = [];
  for (const op of ops) {
    if (op.t === "push") {
      const r = rb.push(op.v);
      if (model.length < realCap || mode === "grow") {
        model.push(op.v);
        expect(r).toBe(true);
      } else if (mode === "overwrite") {
        model.shift();
        model.push(op.v);
        expect(r).toBe(false);
      } else {
        expect(r).toBe(false);
      }
    } else if (op.t === "shift") {
      expect(rb.shift()).toBe(model.shift());
    } else if (op.t === "pop") {
      expect(rb.pop()).toBe(model.pop());
    } else {
      const i = model.indexOf(op.v);
      if (i >= 0) model.splice(i, 1);
      expect(rb.remove(op.v)).toBe(i >= 0);
    }
    expect(rb.size).toBe(model.length);
    expect(rb.toArray()).toEqual(model);
    expect(rb.peek()).toBe(model[0]);
    expect(rb.peekLast()).toBe(model[model.length - 1]);
  }
  expect([...rb]).toEqual(model);
}

describe("RingBuffer", () => {
  it("rounds capacity to a power of two", () => {
    expect(new RingBuffer(5).capacity).toBe(8);
    expect(new RingBuffer(8).capacity).toBe(8);
    expect(new RingBuffer(0).capacity).toBe(1);
  });

  for (const mode of ["grow", "overwrite", "reject"] as const) {
    it(`matches an array model (${mode})`, () => {
      fc.assert(
        fc.property(fc.array(opArb, { maxLength: 200 }), fc.integer({ min: 1, max: 9 }), (ops, cap) => {
          runModel(ops, cap, mode);
        }),
        { numRuns: 300 },
      );
    });
  }

  it("at() supports negative indexes and counts drops", () => {
    const rb = new RingBuffer<number>(4, { overwrite: true });
    for (let i = 0; i < 10; i++) rb.push(i);
    expect(rb.toArray()).toEqual([6, 7, 8, 9]);
    expect(rb.at(0)).toBe(6);
    expect(rb.at(-1)).toBe(9);
    expect(rb.at(4)).toBeUndefined();
    expect(rb.dropped).toBe(6);
    rb.clear();
    expect(rb.size).toBe(0);
  });
});
