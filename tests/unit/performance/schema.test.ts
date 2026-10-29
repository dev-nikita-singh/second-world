import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { parsePerformanceInput } from "../../../src/engines/performance/index.js";
import { PerformanceInputSchema } from "../../../src/engines/performance/schema.js";

describe("PerformanceInputSchema", () => {
  it("fills defaults and infers the closed model", () => {
    const v = PerformanceInputSchema.parse({ target: "http://127.0.0.1:3000/api/x?y=1" });
    expect(v.model).toBe("closed");
    expect(v.vus).toBe(10);
    expect(v.duration).toBe(10_000);
    expect(v.timeout).toBe(10_000);
    expect(v.gracefulStop).toBe(5_000);
    expect(v.http).toEqual({ version: "1.1", keepAlive: true, pipelining: 1 });
    expect(v.workers).toBe(1);
    expect(v.timing).toBe("basic");
    expect(v.arrival).toBe("constant");
    expect(v.scenarios).toHaveLength(1);
    expect(v.scenarios[0]?.steps[0]?.path).toBe("/api/x?y=1");
    expect(v.scenarios[0]?.steps[0]?.method).toBe("GET");
  });

  it("infers open from rate and iterations from iterations", () => {
    expect(PerformanceInputSchema.parse({ target: "http://h:1", rate: 5 }).model).toBe("open");
    const it2 = PerformanceInputSchema.parse({ target: "http://h:1", iterations: 5 });
    expect(it2.model).toBe("iterations");
    expect(it2.duration).toBe(600_000);
  });

  it("parses duration strings", () => {
    const v = PerformanceInputSchema.parse({
      target: "http://h:1",
      duration: "1m30s",
      rampUp: "10s",
      warmup: "500ms",
      timeout: 2000,
      thinkTime: { min: "10ms", max: "20ms" },
    });
    expect(v.duration).toBe(90_000);
    expect(v.rampUp).toBe(10_000);
    expect(v.warmup).toBe(500);
    expect(v.timeout).toBe(2000);
    expect(v.thinkTime).toEqual({ min: 10, max: 20 });
  });

  it("rejects bad input with readable paths", () => {
    expect(() => parsePerformanceInput({ target: "ftp://x" })).toThrow(ConfigError);
    expect(() => parsePerformanceInput({ target: "http://h:1", duration: "ten" })).toThrow(/duration/);
    expect(() => parsePerformanceInput({ target: "http://h:1", model: "open" })).toThrow(/rate/);
    expect(() => parsePerformanceInput({ target: "http://h:1", model: "iterations" })).toThrow(/iterations/);
    expect(() =>
      parsePerformanceInput({
        target: "http://h:1",
        scenarios: [{ name: "a", steps: [{ path: "/", json: {}, body: "x" }] }],
      }),
    ).toThrow(/json/);
    expect(() => parsePerformanceInput({ target: "http://h:1", rate: 50, budget: { maxRps: 10 } })).toThrow(
      /maxRps/,
    );
    expect(() => parsePerformanceInput({ target: "http://h:1", bogus: 1 })).toThrow(ConfigError);
  });

  it("normalises methods and accepts expect/extract", () => {
    const v = PerformanceInputSchema.parse({
      target: "http://h:1",
      scenarios: [
        {
          name: "a",
          weight: 3,
          steps: [
            {
              method: "post",
              path: "/x",
              json: { a: 1 },
              expect: { status: [200, 201] },
              extract: { id: "$.id" },
            },
          ],
        },
      ],
    });
    expect(v.scenarios[0]?.steps[0]?.method).toBe("POST");
    expect(v.scenarios[0]?.weight).toBe(3);
  });
});
