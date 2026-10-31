/**
 * F9: docs/09 §2 world.report.{combine,write,render,renderComparison,exitCode} and
 * world.history.compare, plus the reporting API re-exported from src/index.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld } from "../../../src/core/world.js";
import * as api from "../../../src/index.js";
import { lat, makePerfData, makeResult } from "../../fixtures/reports.js";

function perf(p50: number, i: number) {
  const base = makePerfData();
  return makeResult({
    runId: `run-${p50}-${i}`,
    data: { ...base, latency: { corrected: lat(p50 + i * 0.3), raw: lat(p50 + i * 0.3) } },
  });
}

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "sw-wr-"));
  mkdirSync(join(dir, ".git"));
  const w = await createWorld({
    config: { report: { outDir: "out", formats: ["json", "md"], failOn: "high" } },
    cwd: dir,
    env: {},
    probe: false,
    auditFile: false,
  });
  return { w, dir };
}

describe("public reporting API from src/index.ts", () => {
  it("exports renderReport, writeReports, renderComparison, REPORT_FORMATS, computeExitCode, combineResults", () => {
    expect(api.REPORT_FORMATS).toEqual(
      expect.arrayContaining(["tty", "json", "md", "junit", "sarif", "html"]),
    );
    for (const fn of [
      api.renderReport,
      api.writeReports,
      api.renderComparison,
      api.computeExitCode,
      api.combineResults,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(api.computeExitCode([makeResult({ status: "cancelled" })])).toBe(130);
  });
});

describe("world.report", () => {
  it("combine / render / exitCode use config.report.failOn", async () => {
    const { w } = await world();
    const rep = w.report.combine([makeResult()]) as {
      kind: string;
      results: unknown[];
      verdict: { exitCode: number };
    };
    expect(rep.kind).toBe("second-world-report");
    expect(rep.results).toHaveLength(1);
    expect(w.report.render(rep, "md")).toMatch(/#/);
    expect(JSON.parse(w.report.render(rep, "json")).kind).toBe("second-world-report");
    expect(w.report.exitCode([makeResult({ status: "error" })])).toBe(70);
    expect(w.report.exitCode(rep)).toBe(rep.verdict.exitCode);
    await w.close();
  });

  it("write uses config formats/outDir (resolved against the config dir) and accepts overrides", async () => {
    const { w, dir } = await world();
    const r = await w.report.write(w.report.combine(makeResult()));
    expect(r.files.map((f) => f.format).sort()).toEqual(["json", "md"]);
    expect(existsSync(join(dir, "out", "report.json"))).toBe(true);
    const r2 = await w.report.write([makeResult()], {
      formats: ["junit", "tty"],
      outDir: "x",
      baseName: "ci",
    });
    expect(r2.files).toEqual([{ format: "junit", path: join(dir, "x", "ci.junit.xml") }]);
    expect(readFileSync(join(dir, "x", "ci.junit.xml"), "utf8")).toMatch(/<testsuites/);
    await w.close();
  });
});

describe("world.history.compare", () => {
  it("baseline name / ids / raw results on either side; ≥ 5 per side → statistical verdict", async () => {
    const { w } = await world();
    const fastIds: string[] = [];
    for (let i = 0; i < 5; i++)
      fastIds.push(((await w.history.save([perf(50, i)], { label: "fast" })) as { id: string }).id);
    const store = (await w.history.store()) as unknown as {
      setBaseline(n: string, id: string): Promise<unknown>;
    };
    await store.setBaseline("main", fastIds[0] as string);

    // bare baseline name vs a report not in history (single-run)
    const single = (await w.history.compare({
      baseline: "main",
      current: w.report.combine(perf(150, 0)) as never,
    })) as {
      method: string;
      metrics: Array<{ metric: string; movement?: string }>;
    };
    expect(single.method).toBe("single-run");
    expect(single.metrics.find((m) => m.metric === "performance.http.p95")?.movement).toBe("worse");

    // 5 ids vs 5 raw results → statistical regression
    const slow = [0, 1, 2, 3, 4].map((i) => perf(150, i));
    const stat = (await w.history.compare({ baseline: fastIds, current: slow.map((r) => [r]) })) as {
      method: string;
      regressions: string[];
      metrics: Array<{ metric: string; verdict: string }>;
    };
    expect(stat.method).toBe("statistical");
    expect(stat.metrics.find((m) => m.metric === "performance.http.p95")?.verdict).toBe("regressed");
    expect(stat.regressions).toContain("performance.http.p95");
    expect(w.report.renderComparison(stat, "md")).toMatch(/history comparison/i);

    await expect(
      w.history.compare({ baseline: "nope", current: fastIds[0] as string }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await w.close();
  });

  it("a single result is saved under its own runId (one id per run; sw-qa wave 5)", async () => {
    const { w } = await world();
    const r = makeResult({ runId: "01TESTRUNIDSAMEASREPORT0001" });
    expect((await w.history.save([r]))?.id).toBe("01TESTRUNIDSAMEASREPORT0001");
    // Same runId again: not overwritten, a fresh id instead.
    const again = await w.history.save([r]);
    expect(again?.id).toBeTruthy();
    expect(again?.id).not.toBe("01TESTRUNIDSAMEASREPORT0001");
    const store = (await w.history.store()) as unknown as { get(id: string): Promise<{ id: string } | null> };
    expect((await store.get("01TESTRUNIDSAMEASREPORT0001"))?.id).toBe("01TESTRUNIDSAMEASREPORT0001");
    await w.close();
  });

  it("history.save accepts a combined report", async () => {
    const { w } = await world();
    const saved = await w.history.save(w.report.combine([makeResult()]) as never, { label: "rep" });
    expect(saved?.id).toBeTruthy();
    await w.close();
  });
});
