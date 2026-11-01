import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { parseAgentInput } from "../../../src/engines/agent/index.js";
import { parseBugsInput } from "../../../src/engines/bugs/index.js";
import { parsePerformanceInput } from "../../../src/engines/performance/index.js";
import { checkReliabilityInput, parseReliabilityInput } from "../../../src/engines/reliability/index.js";
import { parseStressInput } from "../../../src/engines/stress/index.js";

// Regression (wave 7, sw-design7 report): engine input errors printed paths relative to the
// section, e.g. `(root): Unrecognized key: "duraton"`, while the config loader prints the full
// path (`performance.duraton`). Engine parse errors now name the config section and suggest typos.

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

const T = "http://127.0.0.1:3000";

describe("engine input errors carry the config section", () => {
  it("performance: unknown key → full path + did you mean", () => {
    const e = errorOf(() => parsePerformanceInput({ target: T, duraton: "10s" }));
    expect(e.code).toBe("SW_CONFIG_PERFORMANCE");
    expect(e.message).toContain('performance.duraton: Unknown key (did you mean "duration"?)');
    expect(e.message).not.toContain("(root)");
  });

  it("performance: nested value error has the section prefix", () => {
    const e = errorOf(() => parsePerformanceInput({ target: T, model: "warp" }));
    expect(e.message).toMatch(/performance\.model: /);
  });

  it("performance: invalid threshold is a parse error naming the section path", () => {
    const e = errorOf(() => parsePerformanceInput({ target: T, thresholds: { http: ["p95 < banana"] } }));
    expect(e.message).toContain("performance.thresholds.http");
    expect(e.message).toContain("banana");
  });

  it("stress: unknown key (stress field or base key) → full path", () => {
    const e = errorOf(() =>
      parseStressInput({ target: T, mode: "step", stages: [1], hold: "1s", duraton: 1 }),
    );
    expect(e.code).toBe("SW_CONFIG_STRESS");
    expect(e.message).toContain("stress.duraton: Unknown key");
    expect(e.message).not.toContain("(root)");
    const e2 = errorOf(() => parseStressInput({ target: T, mode: "step" }));
    expect(e2.message).toContain("stress.stages");
  });

  it("stress: invalid base threshold names stress.thresholds", () => {
    const e = errorOf(() =>
      parseStressInput({
        target: T,
        mode: "step",
        stages: [1],
        hold: "1s",
        thresholds: { http: "p95<banana" },
      }),
    );
    expect(e.message).toContain("stress.thresholds.http");
  });

  it("reliability: unknown key, unknown scenario, bad steadyState", () => {
    const base = { target: T, scenario: "dependency-latency", dependency: "db" };
    expect(errorOf(() => parseReliabilityInput({ ...base, duraton: 1 })).message).toContain(
      "reliability.duraton: Unknown key",
    );
    expect(
      errorOf(() => checkReliabilityInput(parseReliabilityInput({ ...base, scenario: "nope" }))).message,
    ).toContain('Unknown scenario "nope"');
    expect(
      errorOf(() => checkReliabilityInput(parseReliabilityInput({ ...base, steadyState: ["p95 < banana"] })))
        .message,
    ).toContain("reliability.steadyState[0]");
  });

  it("agent and bugs: unknown key with section prefix", () => {
    expect(errorOf(() => parseAgentInput({ target: T, budgt: 1 })).message).toContain("agent.budgt");
    expect(errorOf(() => parseBugsInput({ target: T, contrat: "x" })).message).toContain("bugs.contrat");
  });
});
