/**
 * History integration: real Performance Lab + Stress runs saved to a temp history dir and diffed.
 *
 * Retries: these tests measure real load. When the whole suite runs in parallel, CPU contention can
 * make the Performance Lab self-check flag generator saturation; stress then (correctly) refuses
 * conclusions from that stage. A retry re-measures; a genuine regression fails all attempts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHistoryStore } from "../../../src/engines/history/index.js";
import { runPerformance } from "../../../src/engines/performance/index.js";
import { runStress } from "../../../src/engines/stress/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { type ChildServer, startChildServer } from "../stress/child-server.js";

let srv: ChildServer;
let tmp: TmpDir;
beforeEach(async () => {
  srv = await startChildServer();
  tmp = await makeTmpDir("sw-hist-int-");
});
afterEach(async () => {
  await srv.close();
  await tmp.cleanup();
});

describe("history (integration)", () => {
  it("saves two performance runs and diffs them (single-run, labelled)", {
    timeout: 20_000,
    retry: 2,
  }, async () => {
    const store = createHistoryStore({ cwd: tmp.path });
    const perf = (ms: number) =>
      runPerformance({
        target: `${srv.url}/fixed/${ms}`,
        vus: 4,
        duration: "1500ms",
        thresholds: { "http.p95": "< 30ms" },
      });
    const r1 = await perf(10);
    const r2 = await perf(40); // slower and breaches the threshold → a finding appears
    const e1 = await store.append({ results: [r1], label: "before" });
    const e2 = await store.append({ results: [r2], label: "after" });
    expect(e1.metrics["performance.http.p95"]).toBeGreaterThan(5);
    expect(e2.findings.count).toBeGreaterThan(0);
    // git metadata: this workspace is not a repo → absent, no error
    expect(e1.git === undefined || typeof e1.git.commit === "string").toBe(true);

    await store.setBaseline("main", e1.id);
    const diff = await store.diff("baseline:main", e2.id);
    expect(diff.method).toBe("single-run");
    const p95 = diff.metrics.find((m) => m.metric === "performance.http.p95")!;
    expect(p95.movement).toBe("worse");
    expect(p95.relativeChange).toBeGreaterThan(1);
    expect(p95.verdict).toBe("inconclusive");
    expect(diff.findings.new.length).toBeGreaterThan(0);
    expect(diff.findings.new[0]?.title).toMatch(/p95/);
    expect((await store.verify()).ok).toBe(true);
    const t = await store.trend("p95");
    expect(t.points.map((p) => p.runId)).toEqual([e1.id, e2.id]);
  });

  it("stores a stress result with capacity metrics", { timeout: 20_000, retry: 2 }, async () => {
    const store = createHistoryStore({ cwd: tmp.path, captureGit: false });
    const s = await runStress({
      target: `${srv.url}/capacity/4?ms=20`,
      stages: [2, 4, 8],
      hold: "1s",
      thresholds: { "http.p95": "< 30ms" },
    });
    const e = await store.append({ results: [s] });
    expect(e.engines).toEqual(["stress"]);
    expect(e.metrics["stress.tested_capacity"]).toBe(4);
    expect(e.metrics["stress.first_breach_level"]).toBe(8);
    const back = await store.get(e.id);
    const data = back?.results[0]?.data as { stages: unknown[] } | undefined;
    expect(data?.stages).toHaveLength(3);
  });
});
