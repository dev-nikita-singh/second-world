/**
 * Regressions reported by sw-qa (wave 5): an evolve/What-If app that never becomes healthy
 * (e.g. bound to 127.0.0.1 inside the docker sandbox) retried every repetition (10 × 30 s), gave no
 * hint and exited 70. Now: the hint is in the message, an arm is skipped after 2 failed starts,
 * a baseline that never starts is a TargetError (exit 5), and "runs needed" is never below the
 * smallest n at which Holm-adjusted Mann–Whitney can reach significance.
 */
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../src/core/clock.js";
import { ExitCode, TargetError } from "../../../src/core/errors.js";
import { minFeasibleRepetitions } from "../../../src/engines/experiments/analysis.js";
import { type StartAppOptions, waitHealthy } from "../../../src/engines/experiments/app.js";
import { runExperiment, type WorkloadRunner } from "../../../src/engines/experiments/index.js";
import { fakeResult } from "../../fixtures/experiments/fake-perf.js";

const HINT = "docker sandbox: the app must listen on $HOST";

function unhealthy(
  code: "SW_ENGINE_WHATIF_HEALTH_TIMEOUT" | "SW_ENGINE_WHATIF_APP_EXITED",
  starts: string[],
) {
  return async (o: StartAppOptions) => {
    starts.push(String(o.env?.VARIANT ?? "base"));
    throw Object.assign(new Error(`not healthy within 30000 ms${o.healthHint ? `. ${o.healthHint}` : ""}`), {
      code,
    });
  };
}

const workload: WorkloadRunner = async (input) => fakeResult(String(input.target), { p95: 10 });

describe("app start failures", () => {
  it("the health-timeout message carries the sandbox hint", async () => {
    const clock = createFakeClock(0);
    const p = waitHealthy(
      "http://127.0.0.1:9/healthz",
      { path: "/healthz", timeoutMs: 0, intervalMs: 1 },
      clock,
      undefined,
      undefined,
      HINT,
    );
    await expect(p).rejects.toThrow(/within 0 ms\. docker sandbox: the app must listen on \$HOST/);
  });

  it("a baseline that never starts: 2 attempts, then skipped, then TargetError (exit 5) with the hint", async () => {
    const starts: string[] = [];
    const run = runExperiment(
      {
        name: "never-healthy",
        baseline: {
          start: ["node", "app.js"],
          workload: { scenarios: [{ name: "s", steps: [{ path: "/" }] }] },
        },
        variants: [{ name: "v", env: { VARIANT: "v" } }],
        metrics: ["p95"],
        design: { repetitions: 5 },
        bootstrap: 200,
      },
      {},
      {
        runWorkload: workload,
        startApp: unhealthy("SW_ENGINE_WHATIF_HEALTH_TIMEOUT", starts),
        healthHint: HINT,
      },
    );
    const err = await run.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TargetError);
    expect((err as TargetError).exitCode).toBe(ExitCode.TargetUnreachable);
    expect((err as TargetError).code).toBe("SW_TARGET_APP_UNHEALTHY");
    expect((err as TargetError).hint).toContain("$HOST");
    // 2 attempts per arm, not 5: the rest are skipped without waiting for the health timeout.
    expect(starts.filter((s) => s === "base")).toHaveLength(2);
    expect(starts.filter((s) => s === "v")).toHaveLength(2);
  });

  it("a variant that never starts is skipped but the experiment still completes", async () => {
    const starts: string[] = [];
    let port = 41000;
    const res = await runExperiment(
      {
        name: "variant-broken",
        baseline: {
          start: ["node", "app.js"],
          workload: { scenarios: [{ name: "s", steps: [{ path: "/" }] }] },
        },
        variants: [{ name: "v", env: { VARIANT: "v" } }],
        metrics: ["p95"],
        design: { repetitions: 5 },
        bootstrap: 200,
      },
      {},
      {
        runWorkload: workload,
        startApp: async (o) => {
          const who = String(o.env?.VARIANT ?? "base");
          starts.push(who);
          if (who === "v")
            throw Object.assign(new Error("app exited before becoming healthy"), {
              code: "SW_ENGINE_WHATIF_APP_EXITED",
            });
          const p = port++;
          return {
            url: `http://127.0.0.1:${p}`,
            port: p,
            pid: undefined,
            argv: [],
            output: () => "",
            stop: async () => {},
            exited: false,
          };
        },
      },
    );
    expect(starts.filter((s) => s === "v")).toHaveLength(2);
    expect(starts.filter((s) => s === "base")).toHaveLength(5);
    const skipped = res.data!.runs.filter((r) => r.arm === "v" && r.error?.startsWith("skipped:"));
    expect(skipped).toHaveLength(3);
  });

  it("runs needed respects the Holm/Mann–Whitney feasibility floor", () => {
    expect(minFeasibleRepetitions(0.05, 1)).toBe(4); // 2/C(8,4) = 0.029
    expect(minFeasibleRepetitions(0.05, 4)).toBe(5); // n = 4 → 0.114, n = 5 → 0.032
    expect(minFeasibleRepetitions(0.05, 20)).toBeGreaterThan(5);
    for (const m of [1, 2, 4, 8, 16]) {
      const n = minFeasibleRepetitions(0.05, m);
      let c = 1;
      for (let k = 1; k <= n; k++) c = (c * (n + k)) / k; // C(2n, n)
      expect((2 / c) * m).toBeLessThan(0.05);
    }
  });
});
