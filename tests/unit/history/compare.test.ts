import { describe, expect, it } from "vitest";
import type { Finding } from "../../../src/core/evidence/schemas.js";
import { createFinding } from "../../../src/core/evidence/store.js";
import { createRng } from "../../../src/core/rng.js";
import type { Rng } from "../../../src/core/types.js";
import {
  captureGitMetadata,
  compareRuns,
  diffFindings,
  type HistoryRun,
  metricDirection,
  trendAnalysis,
} from "../../../src/engines/history/index.js";
import { withTmpDir } from "../../helpers/tmp.js";

function finding(title: string, status: Finding["status"] = "open"): Finding {
  return createFinding({
    engine: "bugs",
    ruleId: "R",
    category: "bug",
    title,
    severity: "medium",
    classification: "reproduced-defect",
    confidence: 1,
    status,
    evidence: [{ kind: "note", text: title }],
  });
}

let n = 0;
function run(metrics: Record<string, number>, findings: Finding[] = []): HistoryRun {
  return {
    schemaVersion: 1,
    id: `run${++n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    tags: [],
    engines: ["performance"],
    status: "passed",
    metrics,
    results: [
      {
        schemaVersion: 1,
        engine: "bugs",
        runId: "x",
        status: "passed",
        startedAt: "",
        endedAt: "",
        findings,
        limitations: [],
        artifacts: [],
      },
    ],
  };
}

/** Lognormal per-run p95 with 5% run-to-run CV (measured power: 97.5% at CV 5%, ~90% at 6%, ~66-76% at 8%). */
function p95Sample(rng: Rng, median: number): number {
  const u1 = Math.max(1e-12, rng.next());
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return median * Math.exp(0.05 * z);
}

function arm(rng: Rng, median: number, r: number): HistoryRun[] {
  return Array.from({ length: r }, () =>
    run({ "performance.http.p95": p95Sample(rng, median), "performance.http.rps": 100 + rng.next() * 5 }),
  );
}

describe("finding diff by fingerprint", () => {
  it("classifies new / fixed / regressed / unchanged", () => {
    const a = finding("A stays");
    const b = finding("B gets fixed");
    const c = finding("C is new");
    const d = finding("D came back");
    const e = finding("E was fixed in baseline", "fixed");
    const e2 = { ...finding("E was fixed in baseline"), status: "open" as const };
    const diff = diffFindings([a, b, e], [a, c, d, e2], new Set([d.fingerprint]));
    expect(diff.unchanged.map((x) => x.title)).toEqual(["A stays"]);
    expect(diff.fixed.map((x) => x.title)).toEqual(["B gets fixed"]);
    expect(diff.new.map((x) => x.title)).toEqual(["C is new"]);
    expect(diff.regressed.map((x) => x.title).sort()).toEqual(["D came back", "E was fixed in baseline"]);
  });

  it("compareRuns carries the finding diff", () => {
    const f1 = finding("x");
    const f2 = finding("y");
    const r = compareRuns(run({}, [f1]), run({}, [f1, f2]));
    expect(r.findings.new.map((x) => x.fingerprint)).toEqual([f2.fingerprint]);
    expect(r.findings.unchanged).toHaveLength(1);
  });
});

describe("regression detection", () => {
  it("detects a seeded 20% p95 regression with r = 5 (≥ 95% of 40 seeds)", () => {
    let detected = 0;
    const trials = 40;
    for (let s = 0; s < trials; s++) {
      const rng = createRng(1000 + s);
      const cmp = compareRuns(arm(rng, 100, 5), arm(rng, 120, 5), { seed: s, B: 2000 });
      const m = cmp.metrics.find((x) => x.metric === "performance.http.p95")!;
      expect(m.method).toBe("statistical");
      if (m.verdict === "regressed") detected++;
    }
    expect(detected / trials).toBeGreaterThanOrEqual(0.95);
  });

  it("A/A comparisons: false-positive rate ≤ 5% over 100 seeded trials", () => {
    let fp = 0;
    for (let s = 0; s < 100; s++) {
      const rng = createRng(5000 + s);
      const cmp = compareRuns(arm(rng, 100, 5), arm(rng, 100, 5), { seed: s, B: 2000 });
      if (cmp.metrics.some((m) => m.verdict === "regressed" || m.verdict === "improved")) fp++;
    }
    expect(fp / 100).toBeLessThanOrEqual(0.05);
  });

  it("single run per arm is labelled 'single-run, no statistics' and never claims significance", () => {
    const r = compareRuns(run({ "performance.http.p95": 100 }), run({ "performance.http.p95": 130 }));
    const m = r.metrics[0]!;
    expect(r.method).toBe("single-run");
    expect(m.method).toBe("single-run");
    expect(m.verdict).toBe("inconclusive");
    expect(m.movement).toBe("worse");
    expect(m.relativeChange).toBeCloseTo(0.3);
    expect(m.note).toMatch(/no statistics/);
    expect(r.regressions).toEqual([]);
    expect(r.summary).toMatch(/single-run/);
  });

  it("uses per-run repetitions when a single run carries them", () => {
    const rng = createRng(3);
    const reps = (med: number): number[] => Array.from({ length: 6 }, () => p95Sample(rng, med));
    const a = { ...run({ "performance.http.p95": 100 }), repetitions: { "performance.http.p95": reps(100) } };
    const b = { ...run({ "performance.http.p95": 140 }), repetitions: { "performance.http.p95": reps(140) } };
    const m = compareRuns(a, b, { B: 2000 }).metrics[0]!;
    expect(m.method).toBe("statistical");
    expect(m.verdict).toBe("regressed");
  });

  it("Holm adjustment is applied across metrics", () => {
    const rng = createRng(9);
    const r = compareRuns(arm(rng, 100, 5), arm(rng, 120, 5), { B: 1000 });
    for (const m of r.metrics) expect(m.pAdjusted).toBeGreaterThanOrEqual(m.p!);
  });

  it("metric directions", () => {
    expect(metricDirection("performance.http.p95")).toBe("lower-is-better");
    expect(metricDirection("performance.http.rps")).toBe("higher-is-better");
    expect(metricDirection("stress.tested_capacity")).toBe("higher-is-better");
  });
});

describe("trend analysis", () => {
  const series = (vals: number[]) =>
    vals.map((value, i) => ({
      runId: `r${i}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
      value,
    }));

  it("flags a single anomalous run with robust z > 3.5", () => {
    const vals = [100, 102, 99, 101, 100, 98, 103, 100, 101, 99, 160, 100, 101];
    const t = trendAnalysis("p95", series(vals));
    expect(t.anomalies.map((p) => p.runId)).toEqual(["r10"]);
  });

  it("CUSUM flags a sustained shift", () => {
    const vals = [
      ...Array.from({ length: 15 }, (_, i) => 100 + (i % 3)),
      ...Array.from({ length: 10 }, (_, i) => 115 + (i % 3)),
    ];
    const t = trendAnalysis("p95", series(vals));
    expect(t.changePoints.length).toBeGreaterThan(0);
    expect(t.changePoints[0]!.changePoint).toBe("up");
    expect(Number(t.changePoints[0]!.runId.slice(1))).toBeGreaterThanOrEqual(15);
  });
});

describe("git metadata", () => {
  it("returns undefined (no error) outside a repo or without git", async () => {
    await withTmpDir(async (d) => {
      expect(await captureGitMetadata(d.path)).toBeUndefined();
      expect(await captureGitMetadata(d.path, { gitBin: "definitely-not-git-xyz" })).toBeUndefined();
    });
  });

  it("captures commit, branch and dirty flag in a real repo (skipped if git is missing)", async () => {
    const { execa } = await import("execa");
    const probe = await execa("git", ["--version"], { reject: false });
    if (probe.failed) return;
    await withTmpDir(async (d) => {
      const g = (args: string[]) =>
        execa("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
          cwd: d.path,
          reject: false,
        });
      await g(["init", "-b", "trunk"]);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(d.join("a.txt"), "1");
      await g(["add", "a.txt"]);
      await g(["commit", "-m", "init"]);
      const clean = await captureGitMetadata(d.path);
      expect(clean?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(clean?.branch).toBe("trunk");
      expect(clean?.dirty).toBe(false);
      await writeFile(d.join("a.txt"), "2");
      expect((await captureGitMetadata(d.path))?.dirty).toBe(true);
    });
  });
});
