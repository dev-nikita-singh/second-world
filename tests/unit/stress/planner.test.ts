import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStressInput } from "../../../src/engines/stress/index.js";
import {
  defaultMinStep,
  nextBisectionLevel,
  planStages,
  rangeLevels,
} from "../../../src/engines/stress/planner.js";

const T = "http://127.0.0.1:1";

describe("stress planner", () => {
  it("step: explicit stages are sorted, de-duplicated, with hold/settle", () => {
    const inp = parseStressInput({ target: T, stages: [50, 10, 25, 10], hold: "2s", settle: "500ms" });
    const st = planStages(inp);
    expect(st.map((s) => s.level)).toEqual([10, 25, 50]);
    expect(st.every((s) => s.holdMs === 2000 && s.settleMs === 500 && s.kind === "step")).toBe(true);
    expect(st.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("step: range from..to by step includes `to`", () => {
    const inp = parseStressInput({ target: T, range: { from: 10, to: 45, step: 10 } });
    expect(planStages(inp).map((s) => s.level)).toEqual([10, 20, 30, 40, 45]);
  });

  it("infers rate load type from base rate and keeps fractional rates", () => {
    const inp = parseStressInput({ target: T, rate: 10, stages: [12.345, 100] });
    expect(inp.loadType).toBe("rate");
    expect(planStages(inp).map((s) => s.level)).toEqual([12.35, 100]);
  });

  it("ramp: n stages linear from..to, total hold = duration", () => {
    const inp = parseStressInput({
      target: T,
      mode: "ramp",
      ramp: { from: 10, to: 100, duration: "10s", stages: 10 },
    });
    const st = planStages(inp);
    expect(st[0]?.level).toBe(10);
    expect(st.at(-1)?.level).toBe(100);
    expect(st.reduce((a, s) => a + s.holdMs, 0)).toBe(10_000);
  });

  it("spike: baseline → peak → baseline (recovery defaults to max(hold, 3×duration))", () => {
    const inp = parseStressInput({
      target: T,
      mode: "spike",
      hold: "5s",
      spike: { baseline: 5, peak: 50, duration: "3s" },
    });
    const st = planStages(inp);
    expect(st.map((s) => [s.kind, s.level, s.holdMs])).toEqual([
      ["spike-before", 5, 5000],
      ["spike-peak", 50, 3000],
      ["spike-after", 5, 9000],
    ]);
  });

  it("soak: one long stage", () => {
    const inp = parseStressInput({ target: T, mode: "soak", soak: { level: 20, duration: "1h" } });
    const st = planStages(inp);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ kind: "soak", level: 20, holdMs: 3_600_000 });
  });

  it("breakpoint: coarse ladder", () => {
    const inp = parseStressInput({
      target: T,
      rate: 1,
      mode: "breakpoint",
      breakpoint: { from: 50, to: 300, step: 50 },
    });
    expect(planStages(inp).map((s) => s.level)).toEqual([50, 100, 150, 200, 250, 300]);
  });

  it("rejects missing mode blocks and bad base input", () => {
    expect(() => parseStressInput({ target: T, mode: "breakpoint" })).toThrow(/breakpoint/);
    expect(() => parseStressInput({ target: T })).toThrow(/stages/);
    expect(() => parseStressInput({ target: "ftp://x", stages: [1] })).toThrow(/target/);
    expect(() => parseStressInput({ target: T, mode: "spike", spike: { baseline: 10, peak: 5 } })).toThrow(
      /peak/,
    );
  });

  it("property: step and ramp plans are strictly increasing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 30 }),
        fc.boolean(),
        (levels, rate) => {
          const inp = parseStressInput({ target: T, ...(rate ? { rate: 1 } : {}), stages: levels });
          const st = planStages(inp);
          for (let i = 1; i < st.length; i++) expect(st[i]!.level).toBeGreaterThan(st[i - 1]!.level);
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 2, max: 50 }),
        (from, span, n) => {
          const inp = parseStressInput({
            target: T,
            mode: "ramp",
            ramp: { from, to: from + span, duration: 60_000, stages: n },
          });
          const st = planStages(inp);
          for (let i = 1; i < st.length; i++) expect(st[i]!.level).toBeGreaterThan(st[i - 1]!.level);
          expect(st.reduce((a, s) => a + s.holdMs, 0)).toBeLessThanOrEqual(60_000);
        },
      ),
    );
  });

  it("property: bisection converges in ≤ ⌈log2(range/minStep)⌉+1 probes to the true boundary", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 2, max: 100_000 }),
        fc.integer({ min: 1, max: 50 }),
        fc.double({ min: 0, max: 0.99, noNaN: true }),
        (lo, span, minStep, frac) => {
          const hi = lo + span;
          const boundary = lo + frac * span; // load > boundary fails
          let pass = lo;
          let fail = hi;
          let probes = 0;
          for (;;) {
            const next = nextBisectionLevel(pass, fail, minStep, "vus");
            if (next === null) break;
            probes++;
            if (next > boundary) fail = next;
            else pass = next;
            expect(probes).toBeLessThan(64);
          }
          expect(probes).toBeLessThanOrEqual(Math.max(0, Math.ceil(Math.log2(span / minStep))) + 1);
          expect(fail - pass).toBeLessThanOrEqual(Math.max(minStep, 1));
          expect(pass).toBeLessThanOrEqual(boundary);
          expect(fail).toBeGreaterThan(boundary);
        },
      ),
    );
  });

  it("rangeLevels / defaultMinStep basics", () => {
    expect(rangeLevels(1, 1, 5, "vus")).toEqual([1]);
    expect(defaultMinStep(50, "vus")).toBe(13);
    expect(defaultMinStep(2, "vus")).toBe(1);
    expect(defaultMinStep(2, "rate")).toBe(0.5);
  });
});
