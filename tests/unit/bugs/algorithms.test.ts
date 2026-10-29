import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ddmin } from "../../../src/engines/bugs/algorithms/ddmin.js";
import { ipog, uncoveredPairs } from "../../../src/engines/bugs/algorithms/ipog.js";
import {
  type CounterInput,
  checkLinearizable,
  counterModel,
  type HistoryOp,
  registerModel,
  setModel,
  stockModel,
} from "../../../src/engines/bugs/algorithms/linearizability.js";
import { classifyReplays } from "../../../src/engines/bugs/classify.js";

describe("IPOG pairwise", () => {
  it("covers every pair (property) with far fewer rows than exhaustive", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 2, maxLength: 7 }), (sizes) => {
        const rows = ipog(sizes);
        expect(uncoveredPairs(sizes, rows)).toEqual([]);
        for (const r of rows) {
          expect(r).toHaveLength(sizes.length);
          for (const [i, v] of r.entries()) expect(v).toBeLessThan(sizes[i] as number);
        }
        const exhaustive = sizes.reduce((a, b) => a * b, 1);
        expect(rows.length).toBeLessThanOrEqual(exhaustive);
      }),
      { numRuns: 60 },
    );
  });

  it("10 params x 5 values: ~v² log p rows instead of 9.7M", () => {
    const sizes = new Array(10).fill(5);
    const rows = ipog(sizes);
    expect(uncoveredPairs(sizes, rows)).toEqual([]);
    expect(rows.length).toBeLessThan(60);
  });

  it("respects constraints and still covers all feasible pairs", () => {
    // param0 value 0 is incompatible with param1 value 0
    const constraint = (r: (number | undefined)[]): boolean => !(r[0] === 0 && r[1] === 0);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 2, max: 4 }), { minLength: 2, maxLength: 5 }), (sizes) => {
        const rows = ipog(sizes, { constraint });
        for (const r of rows) expect(constraint(r)).toBe(true);
        expect(uncoveredPairs(sizes, rows, constraint)).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });
});

describe("ddmin", () => {
  it("returns a 1-minimal failing subsequence (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 40 })
          .chain((n) =>
            fc.tuple(
              fc.constant(n),
              fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { minLength: 1, maxLength: Math.min(n, 4) }),
            ),
          ),
        async ([n, culprits]) => {
          const input = Array.from({ length: n }, (_, i) => i);
          const need = new Set(culprits);
          const fails = (s: number[]): boolean => [...need].every((c) => s.includes(c));
          const r = await ddmin(input, fails, { maxTests: 5000 });
          expect(r.exhausted).toBe(false);
          expect(fails(r.result)).toBe(true);
          // 1-minimal: removing any element makes it pass
          for (let i = 0; i < r.result.length; i++) {
            expect(fails(r.result.filter((_, j) => j !== i))).toBe(false);
          }
          expect([...r.result].sort((a, b) => a - b)).toEqual([...need].sort((a, b) => a - b));
        },
      ),
      { numRuns: 80 },
    );
  });

  it("caps the number of tests", async () => {
    const input = Array.from({ length: 64 }, (_, i) => i);
    const r = await ddmin(input, (s) => s.includes(3) && s.includes(60), { maxTests: 5 });
    expect(r.tests).toBeLessThanOrEqual(5);
  });
});

describe("linearizability (Wing–Gong)", () => {
  const op = <I, O>(input: I, output: O | undefined, call: number, ret: number): HistoryOp<I, O> => ({
    input,
    output,
    call,
    ret,
  });

  it("stock: one success of five concurrent takes on stock 1 is linearizable", () => {
    const h = [op({ take: 1 }, true, 0, 10), ...[1, 2, 3, 4].map((i) => op({ take: 1 }, false, i, 10 + i))];
    expect(checkLinearizable(h, stockModel(1)).result).toBe("ok");
  });

  it("stock: two successes on stock 1 is a violation (oversell)", () => {
    const h = [op({ take: 1 }, true, 0, 10), op({ take: 1 }, true, 1, 11), op({ take: 1 }, false, 2, 12)];
    expect(checkLinearizable(h, stockModel(1)).result).toBe("violation");
  });

  it("stock: unknown outcome is accepted either way", () => {
    const h = [
      op({ take: 1 }, true, 0, 10),
      op<{ take: number }, boolean>({ take: 1 }, undefined, 1, Infinity),
    ];
    expect(checkLinearizable(h, stockModel(1)).result).toBe("ok");
  });

  it("register: respects real-time order", () => {
    const m = registerModel<number>(0);
    // write 1 completes before read starts; read returning 0 is stale → violation
    const bad = [op({ op: "write" as const, value: 1 }, null, 0, 5), op({ op: "read" as const }, 0, 6, 8)];
    expect(checkLinearizable(bad, m).result).toBe("violation");
    // overlapping → either value fine
    const ok = [op({ op: "write" as const, value: 1 }, null, 0, 10), op({ op: "read" as const }, 0, 2, 8)];
    expect(checkLinearizable(ok, m).result).toBe("ok");
  });

  const cop = (
    input: CounterInput,
    output: number | null,
    call: number,
    ret: number,
  ): HistoryOp<CounterInput, number | null> => ({ input, output, call, ret });
  it("counter: lost update detected", () => {
    const m = counterModel(0);
    const h = [
      cop({ op: "inc" }, null, 0, 5),
      cop({ op: "inc" }, null, 1, 6),
      cop({ op: "read" }, 1, 10, 11),
    ];
    expect(checkLinearizable(h, m).result).toBe("violation");
    const good = [...h.slice(0, 2), cop({ op: "read" }, 2, 10, 11)];
    expect(checkLinearizable(good, m).result).toBe("ok");
  });

  it("set: add twice concurrently cannot both report 'added'", () => {
    const m = setModel();
    const h = [
      op({ op: "add" as const, value: "a" }, true, 0, 5),
      op({ op: "add" as const, value: "a" }, true, 1, 6),
    ];
    expect(checkLinearizable(h, m).result).toBe("violation");
  });

  it("returns unknown when the step budget is exceeded", () => {
    const h = Array.from({ length: 30 }, (_, i) => cop({ op: "inc" }, null, 0, 100 + i));
    h.push(cop({ op: "read" }, -1, 200, 201));
    expect(checkLinearizable(h, counterModel(0), { maxSteps: 50 }).result).toBe("unknown");
  });
});

describe("replay classification (Wilson)", () => {
  it("n/n → deterministic reproduced-defect", () => {
    const c = classifyReplays({ failures: 3, runs: 3 });
    expect(c.classification).toBe("reproduced-defect");
    expect(c.flaky).toBe(false);
  });
  it("k/n → flaky with Wilson interval containing the rate", () => {
    const c = classifyReplays({ failures: 4, runs: 10 });
    expect(c.classification).toBe("reproduced-defect");
    expect(c.flaky).toBe(true);
    expect(c.wilson.lower).toBeLessThan(0.4);
    expect(c.wilson.upper).toBeGreaterThan(0.4);
    expect(c.wilson.lower).toBeGreaterThan(0.1);
  });
  it("0/n → observation", () => {
    expect(classifyReplays({ failures: 0, runs: 3 }).classification).toBe("observation");
    expect(classifyReplays({ failures: 0, runs: 0 }).classification).toBe("observation");
  });
});
