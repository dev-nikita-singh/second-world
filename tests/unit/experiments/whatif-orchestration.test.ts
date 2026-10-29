import { describe, expect, it } from "vitest";
import type { RunningApp, StartAppOptions } from "../../../src/engines/experiments/app.js";
import { runExperiment, type WorkloadRunner } from "../../../src/engines/experiments/index.js";
import { fakeResult } from "../../fixtures/experiments/fake-perf.js";

/** Deterministic per-call noise. */
function noise(i: number): number {
  return ((i * 7919) % 13) / 13 - 0.5;
}

function fakeStarter(log: string[]) {
  let port = 40000;
  return async (o: StartAppOptions): Promise<RunningApp> => {
    const p = port++;
    log.push(`start ${o.env?.VARIANT ?? "base"} ${p}`);
    return {
      url: `http://127.0.0.1:${p}`,
      port: p,
      pid: undefined,
      argv: [],
      output: () => "",
      stop: async () => {
        log.push(`stop ${p}`);
      },
      exited: false,
    };
  };
}

describe("runExperiment orchestration (stubbed workload)", () => {
  it("per-run lifecycle: one process per run, interleaved, improved verdict, reset before each run", async () => {
    const log: string[] = [];
    const targets = new Map<string, string>();
    let call = 0;
    const runWorkload: WorkloadRunner = async (input) => {
      const t = String(input.target);
      const variant = targets.get(t);
      const i = call++;
      return fakeResult(
        t,
        { p95: (variant === "fast" ? 60 : 100) + noise(i) * 2, rps: 100 + noise(i) },
        `perf${i}`,
      );
    };
    const starter = fakeStarter(log);
    const res = await runExperiment(
      {
        name: "fast-vs-base",
        hypothesis: "fast lowers p95 by ≥ 15%",
        baseline: { start: "node app.js", env: { VARIANT: "base" }, reset: ["node", "-e", "0"] },
        variants: [{ name: "fast", env: { VARIANT: "fast" } }],
        metrics: ["p95", "rps"],
        success: { p95: { improvement: ">= 15%" }, rps: { notWorse: true } },
        design: { repetitions: 5, seed: 3 },
        bootstrap: 2000,
      },
      {},
      {
        runWorkload,
        startApp: async (o) => {
          const app = await starter(o);
          targets.set(app.url, o.env?.VARIANT === "fast" ? "fast" : "base");
          return app;
        },
      },
    );
    expect(res.status).toBe("passed");
    const d = res.data!;
    expect(d.runs).toHaveLength(10);
    expect(d.runs.map((r) => r.arm).slice(0, 4)).toEqual(["baseline", "fast", "fast", "baseline"]);
    expect(log.filter((l) => l.startsWith("start"))).toHaveLength(10);
    expect(log.filter((l) => l.startsWith("stop"))).toHaveLength(10);
    const p95 = d.comparisons.find((c) => c.metric === "p95")!;
    expect(p95.verdict).toBe("improved");
    expect(p95.success?.status).toBe("met");
    expect(d.verdicts[0]).toMatchObject({ variant: "fast", hypothesis: "supported" });
    expect(d.arms[1]!.kind).toBe("process");
    expect(d.fingerprints.consistent).toBe(true);
    expect(res.findings.some((f) => f.ruleId === "WHATIF-IMPROVED")).toBe(true);
  });

  it("per-arm lifecycle and shared process for endpoint variants", async () => {
    const log: string[] = [];
    const runWorkload: WorkloadRunner = async (input) => {
      const scen =
        (input.scenarios as { steps: { path: string }[] }[] | undefined)?.[0]?.steps[0]?.path ?? "";
      return fakeResult(String(input.target), { p95: scen === "/fast" ? 5 : 20 });
    };
    const res = await runExperiment(
      {
        name: "two-endpoints",
        baseline: {
          start: ["node", "app.js"],
          workload: { scenarios: [{ name: "s", steps: [{ path: "/slow" }] }] },
        },
        variants: [
          { name: "fast-endpoint", workload: { scenarios: [{ name: "s", steps: [{ path: "/fast" }] }] } },
        ],
        metrics: ["p95"],
        design: { repetitions: 5, lifecycle: "per-arm" },
        bootstrap: 1000,
      },
      {},
      { runWorkload, startApp: fakeStarter(log) },
    );
    expect(log.filter((l) => l.startsWith("start"))).toHaveLength(1);
    expect(res.data!.arms[0]!.sharesProcessWith).toEqual(["fast-endpoint"]);
    expect(res.data!.comparisons[0]!.verdict).toBe("improved");
  });

  it("A/A mode on external target reports a noise floor and warns on fingerprint mismatch", async () => {
    let i = 0;
    const runWorkload: WorkloadRunner = async (input) => {
      const k = i++;
      return fakeResult(String(input.target), {
        p95: 50 + noise(k) * 0.2,
        hostname: k === 3 ? "other-host" : "host",
      });
    };
    const res = await runExperiment(
      {
        name: "aa",
        mode: "aa",
        baseline: { target: "http://127.0.0.1:9" },
        metrics: ["p95"],
        design: { repetitions: 6 },
        bootstrap: 1000,
      },
      {},
      { runWorkload },
    );
    const d = res.data!;
    expect(d.arms.map((a) => a.name)).toEqual(["baseline", "baseline#2"]);
    expect(d.comparisons[0]!.verdict).toBe("no-significant-change");
    expect(d.noiseFloor?.[0]?.mde).toBeLessThan(0.05);
    expect(d.fingerprints.consistent).toBe(false);
    expect(res.limitations.some((l) => l.code === "WHATIF-FINGERPRINT-MISMATCH")).toBe(true);
  });

  it("few repetitions → warning + inconclusive; failed runs are recorded, not fatal", async () => {
    let i = 0;
    const runWorkload: WorkloadRunner = async (input) => {
      if (i++ === 1) throw new Error("boom");
      return fakeResult(String(input.target), { p95: 50 });
    };
    const res = await runExperiment(
      {
        name: "few",
        baseline: { target: "http://127.0.0.1:9" },
        variants: [{ name: "v" }],
        metrics: ["p95", "server.cpu"],
        design: { repetitions: 2 },
        bootstrap: 500,
      },
      {},
      { runWorkload },
    );
    const codes = res.limitations.map((l) => l.code);
    expect(codes).toEqual(
      expect.arrayContaining(["WHATIF-FEW-REPETITIONS", "WHATIF-RUN-FAILED", "WHATIF-METRIC-UNAVAILABLE"]),
    );
    expect(res.data!.runs.filter((r) => r.status === "error")).toHaveLength(1);
    expect(res.data!.comparisons[0]!.verdict).toBe("inconclusive");
  });

  it("cancellation stops the schedule and stops the app", async () => {
    const ac = new AbortController();
    const log: string[] = [];
    let i = 0;
    const runWorkload: WorkloadRunner = async (input) => {
      if (++i === 3) ac.abort();
      return fakeResult(String(input.target), { p95: 50 });
    };
    const res = await runExperiment(
      {
        name: "cancel",
        baseline: { start: "node a.js" },
        variants: [{ name: "v", env: { X: "1" } }],
        metrics: ["p95"],
        bootstrap: 500,
      },
      { signal: ac.signal },
      { runWorkload, startApp: fakeStarter(log) },
    );
    expect(res.status).toBe("cancelled");
    expect(res.data!.runs.length).toBeLessThan(10);
    expect(log.filter((l) => l.startsWith("start")).length).toBe(
      log.filter((l) => l.startsWith("stop")).length,
    );
  });
});
