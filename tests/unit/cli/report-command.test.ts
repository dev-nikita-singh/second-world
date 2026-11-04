/**
 * `sw report [reports...] [--last] [--run <id>]` (docs/09-cli-and-api.md §1 "sw report"):
 * combines / re-renders earlier reports without any network or engine run.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createWorld } from "../../../src/core/world.js";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const T0 = "2026-11-04T10:00:00.000Z";
const T1 = "2026-11-04T10:00:05.000Z";

function finding(id: string, engine: string, severity: string, classification: string, title: string) {
  return {
    schemaVersion: 1,
    id,
    fingerprint: `fp-${id}`,
    engine,
    category: "correctness",
    title,
    description: "",
    severity,
    classification,
    status: "open",
    confidence: 0.9,
    evidence: [{ kind: "log", summary: "seen" }],
    locations: [],
    affected: [],
    related: [],
    occurrences: 1,
    firstSeen: T0,
    lastSeen: T1,
    tags: [],
  };
}

const archResult = {
  schemaVersion: 1,
  engine: "architecture",
  runId: "01ARCHRUN0000000000000000A",
  status: "passed",
  startedAt: T0,
  endedAt: T1,
  findings: [finding("f-arch", "architecture", "medium", "suspected-risk", "Cycle in modules")],
  limitations: [],
  artifacts: [],
} as unknown as EngineResult;

const bugsResult = {
  schemaVersion: 1,
  engine: "bugs",
  runId: "01BUGSRUN0000000000000000B",
  status: "failed",
  startedAt: T0,
  endedAt: T1,
  findings: [finding("f-bugs", "bugs", "high", "reproduced-defect", "Object-level authorization missing")],
  limitations: [],
  artifacts: [],
} as unknown as EngineResult;

let tmp: TmpDir;
const cli = (args: string[]) =>
  runCli(["--config", tmp.join("sw.config.json"), ...args], {
    cwd: tmp.path,
    env: { SW_USER_CONFIG_DIR: tmp.join("user") },
  });

beforeAll(async () => {
  tmp = await makeTmpDir("sw-report-cmd-");
  writeFileSync(tmp.join("sw.config.json"), JSON.stringify({ project: { root: "." } }));
  writeFileSync(tmp.join("arch.json"), JSON.stringify(archResult));
  writeFileSync(tmp.join("bugs.json"), JSON.stringify([bugsResult]));
  writeFileSync(tmp.join("broken.json"), "{ not json");
  writeFileSync(tmp.join("other.json"), JSON.stringify({ hello: "world" }));
});

afterAll(async () => {
  await tmp?.cleanup();
});

describe("sw report", () => {
  it("re-renders one report as tty and writes no file without -f/-o", async () => {
    const r = await cli(["report", "arch.json"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[architecture] passed");
    expect(r.stdout).toContain("Cycle in modules");
    expect(existsSync(tmp.join(".second-world", "reports"))).toBe(false);
  }, 60_000);

  it("combines several reports into every format under -o; verdict and exit code over all results", async () => {
    const r = await cli([
      "report",
      "arch.json",
      "bugs.json",
      "-f",
      "json,md,html,junit,sarif",
      "-o",
      "combined",
    ]);
    expect(r.exitCode).toBe(1); // the bugs finding is high, fail-on defaults to high
    expect(r.stdout).toBe(""); // tty not requested
    expect(r.stderr).toContain("combined 2 result(s) from 2 source(s)");
    expect(readdirSync(tmp.join("combined")).sort()).toEqual([
      "report.html",
      "report.json",
      "report.junit.xml",
      "report.md",
      "report.sarif",
    ]);
    const rep = JSON.parse(readFileSync(tmp.join("combined", "report.json"), "utf8"));
    expect(rep.kind).toBe("second-world-report");
    expect(rep.results.map((x: EngineResult) => x.engine)).toEqual(["architecture", "bugs"]);
    expect(rep.runId).not.toBe(archResult.runId);
    expect(rep.runId).not.toBe(bugsResult.runId);
    expect(rep.verdict.passed).toBe(false);
    expect(readFileSync(tmp.join("combined", "report.md"), "utf8")).toContain(
      "Object-level authorization missing",
    );
  }, 60_000);

  it("--fail-on re-judges the combined report; a single combined report keeps its run id", async () => {
    const r = await cli(["--fail-on", "never", "report", "combined/report.json", "--json"]);
    expect(r.exitCode).toBe(0);
    const rep = JSON.parse(r.stdout);
    const before = JSON.parse(readFileSync(tmp.join("combined", "report.json"), "utf8"));
    expect(rep.runId).toBe(before.runId);
    expect(rep.failOn).toBe("never");
    expect(rep.verdict.passed).toBe(true);
    expect(rep.results).toHaveLength(2);
  }, 60_000);

  it("counts a result passed twice once", async () => {
    const r = await cli(["report", "bugs.json", "bugs.json", "combined/report.json", "--json"]);
    const rep = JSON.parse(r.stdout);
    expect(rep.results.map((x: EngineResult) => x.runId).sort()).toEqual([
      archResult.runId,
      bugsResult.runId,
    ]);
  }, 60_000);

  it("bad input exits 2 with a hint", async () => {
    for (const args of [
      ["report"],
      ["report", "missing.json"],
      ["report", "broken.json"],
      ["report", "other.json"],
      ["report", "--last"],
      ["report", "--run", "01ZZZZ"],
    ]) {
      const r = await cli(args);
      expect(r.exitCode, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("SW_CONFIG_REPORT");
    }
  }, 120_000);

  it("--last and --run read history runs", async () => {
    const world = await createWorld({
      config: tmp.join("sw.config.json"),
      cwd: tmp.path,
      probe: false,
      auditFile: false,
      userConfig: false,
    });
    let firstId: string;
    try {
      const a = await world.history.save([archResult], { label: "a" });
      await world.history.save([bugsResult], { label: "b" });
      firstId = (a as { id: string }).id;
    } finally {
      await world.close();
    }
    const last = await cli(["report", "--last", "--json"]);
    expect(last.exitCode).toBe(1);
    expect(JSON.parse(last.stdout).results.map((x: EngineResult) => x.engine)).toEqual(["bugs"]);
    const both = await cli(["report", "--run", firstId.slice(0, 10), "--last", "--json"]);
    expect(JSON.parse(both.stdout).results.map((x: EngineResult) => x.engine)).toEqual([
      "architecture",
      "bugs",
    ]);
  }, 60_000);
});
