/**
 * CLI end-to-end: the real `sw` entry (src/cli/main.ts via the tsx loader) in a
 * subprocess, as a user runs it. docs/12-testing-and-quality.md §1 (E2E),
 * docs/09-cli-and-api.md §1 (flags), docs/03-engines/evidence-and-history.md §A.6 (exit codes).
 *
 * Every test runs in an empty temp cwd with SW_USER_CONFIG_DIR pointed at an empty dir,
 * so the developer's own config never leaks in. Targets are the calibrated server on
 * 127.0.0.1:0. Runs are kept short (≤ 2 s of load).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CalibratedServer, startCalibratedServer } from "../fixtures/servers/calibrated.js";
import { CLI_ENTRY, runCli, spawnCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";

const cliExists = existsSync(CLI_ENTRY);

let srv: CalibratedServer;
let tmp: TmpDir;
let userCfg: TmpDir;

beforeAll(async () => {
  srv = await startCalibratedServer();
  userCfg = await makeTmpDir("sw-usercfg-");
});
afterAll(async () => {
  await srv?.close();
  await userCfg?.cleanup();
});
beforeEach(async () => {
  tmp = await makeTmpDir("sw-e2e-");
});
afterEach(async () => {
  await tmp.cleanup();
});

const sw = (args: string[], timeoutMs = 60_000) =>
  runCli(args, { cwd: tmp.path, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs });

function parseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not JSON:\n${stdout.slice(0, 2000)}`);
  }
}

describe.skipIf(!cliExists)("sw CLI e2e", () => {
  it("--version and --help exit 0", async () => {
    const v = await sw(["--version"]);
    expect(v.exitCode).toBe(0);
    expect(v.stdout).toMatch(/\d+\.\d+\.\d+/);
    const h = await sw(["--help"]);
    expect(h.exitCode).toBe(0);
    expect(h.stdout).toContain("perf");
  });

  it("sw doctor --json → exit 0 with a machine-readable report on stdout", async () => {
    const r = await sw(["doctor", "--json", "--quick"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const j = parseJson(r.stdout);
    expect(Array.isArray(j.checks)).toBe(true);
  });

  it("sw perf against the calibrated server → JSON report on stdout, exit 0", async () => {
    const r = await sw([
      "perf",
      `${srv.url}/fixed/5`,
      "--rate",
      "50",
      "--duration",
      "2s",
      "--warmup",
      "0s",
      "--json",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const rep = parseJson(r.stdout);
    expect(rep.kind).toBe("second-world-report");
    expect(rep.schemaVersion).toBe(1);
    expect(rep.verdict).toMatchObject({ passed: true, exitCode: 0 });
    const res = rep.results[0];
    expect(res.engine).toBe("performance");
    const d = res.data;
    expect(d.totals.requests).toBeGreaterThanOrEqual(80);
    expect(d.totals.requests).toBeLessThanOrEqual(120);
    expect(d.totals.errorRate).toBe(0);
    // ~5 ms fixed latency, generous bounds for CI machines
    expect(d.latency.corrected.p50).toBeGreaterThanOrEqual(4.5);
    expect(d.latency.corrected.p50).toBeLessThan(40);
  });

  it("writes json, md and junit report files with -f/-o", async () => {
    const r = await sw([
      "perf",
      `${srv.url}/fixed/1`,
      "--rate",
      "20",
      "--duration",
      "1s",
      "--warmup",
      "0s",
      "-f",
      "json,md,junit",
      "-o",
      "out",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const out = tmp.join("out");
    const rep = parseJson(readFileSync(path.join(out, "report.json"), "utf8"));
    expect(rep.verdict.exitCode).toBe(0);
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain("## SECOND WORLD");
    expect(readFileSync(path.join(out, "report.junit.xml"), "utf8")).toContain("<testsuites");
  });

  it("a failing threshold → exit 1, breach visible in JSON and JUnit", async () => {
    const r = await sw([
      "perf",
      `${srv.url}/fixed/20`,
      "--rate",
      "20",
      "--duration",
      "1s",
      "--warmup",
      "0s",
      "--threshold",
      "p95<1ms",
      "-f",
      "json,junit",
      "-o",
      "out",
    ]);
    expect(r.exitCode, r.stderr).toBe(1);
    const rep = parseJson(readFileSync(tmp.join("out", "report.json"), "utf8"));
    expect(rep.verdict.passed).toBe(false);
    expect(rep.results[0].data.thresholds.some((t: { passed: boolean }) => !t.passed)).toBe(true);
    expect(
      rep.results[0].findings.some(
        (f: { classification: string }) => f.classification === "threshold-breach",
      ),
    ).toBe(true);
    expect(readFileSync(tmp.join("out", "report.junit.xml"), "utf8")).toMatch(/<failure /);
  });

  it("--fail-on never turns a breach into exit 0", async () => {
    const r = await sw([
      "perf",
      `${srv.url}/fixed/20`,
      "--rate",
      "10",
      "--duration",
      "1s",
      "--warmup",
      "0s",
      "--threshold",
      "p95<1ms",
      "--fail-on",
      "never",
      "--json",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(parseJson(r.stdout).verdict.passed).toBe(true);
  });

  it("a public target is blocked by the safety guard → exit 3, nothing sent", async () => {
    const r = await sw(["perf", "https://example.com/", "--rate", "1", "--duration", "1s"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(3);
  });

  it("usage and config errors → exit 2", async () => {
    expect((await sw(["perf", `${srv.url}/`, "--vus", "abc"])).exitCode).toBe(2);
    expect((await sw(["perf", `${srv.url}/`, "--no-such-flag"])).exitCode).toBe(2);
    expect((await sw(["perf"])).exitCode).toBe(2); // no target
  });

  it("invalid config → exit 2 (config validate and the engine command)", async () => {
    writeFileSync(tmp.join("sw.config.json"), JSON.stringify({ safety: { maxRps: "lots" } }));
    expect((await sw(["config", "validate"])).exitCode).toBe(2);
    writeFileSync(tmp.join("sw.config.json"), "{not json");
    expect((await sw(["config", "validate"])).exitCode).toBe(2);
    writeFileSync(tmp.join("sw.config.json"), JSON.stringify({ performance: { rate: "not-a-rate" } }));
    expect((await sw(["perf", `${srv.url}/fixed/1`])).exitCode).toBe(2);
  });

  it("config validate rejects invalid engine sections with exit 2 (and accepts a valid one)", async () => {
    const cases: [unknown, string][] = [
      [{ performance: { rate: "not-a-rate" } }, "SW_CONFIG_UNIT"],
      [{ performance: { model: "warp" } }, "SW_CONFIG_PERFORMANCE"],
      [{ performance: { thresholds: { "http.p95": "< banana" } } }, "SW_CONFIG_THRESHOLD"],
    ];
    for (const [cfg, code] of cases) {
      writeFileSync(tmp.join("sw.config.json"), JSON.stringify(cfg));
      const r = await sw(["config", "validate", "--json"]);
      expect(r.exitCode, JSON.stringify(cfg)).toBe(2);
      expect(parseJson(r.stdout)).toMatchObject({ valid: false, code });
    }
    writeFileSync(tmp.join("sw.config.json"), JSON.stringify({ performance: { rate: 50, duration: "5s" } }));
    expect((await sw(["config", "validate"])).exitCode).toBe(0);
  });

  it("--dry-run sends nothing", async () => {
    const before = srv.stats().requests;
    const r = await sw([
      "--dry-run",
      "perf",
      `${srv.url}/fixed/1`,
      "--rate",
      "100",
      "--duration",
      "5s",
      "--json",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(parseJson(r.stdout).dryRun).toBe(true);
    expect(srv.stats().requests).toBe(before);
  });

  // Windows cannot deliver SIGINT to a child process programmatically (Node's
  // subprocess.kill("SIGINT") terminates it forcefully without running handlers, and
  // GenerateConsoleCtrlEvent needs a shared console). The graceful-stop path is covered
  // on macOS/Linux CI; on Windows it is exercised manually with Ctrl+C.
  it.skipIf(process.platform === "win32")(
    "Ctrl+C (SIGINT) → graceful stop, cancelled report, exit 130",
    async () => {
      const child = spawnCli(
        ["perf", `${srv.url}/fixed/5`, "--rate", "50", "--duration", "30s", "--warmup", "0s", "--json"],
        {
          cwd: tmp.path,
          env: { SW_USER_CONFIG_DIR: userCfg.path },
          timeoutMs: 30_000,
        },
      );
      const t0 = performance.now();
      // wait until load is actually flowing, then interrupt
      while (srv.stats().inFlight === 0 && performance.now() - t0 < 15_000)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      child.kill("SIGINT");
      const r = await child;
      expect(r.exitCode).toBe(130);
      expect(performance.now() - t0).toBeLessThan(20_000);
      const stdout = String(r.stdout ?? "");
      if (stdout.trim().startsWith("{")) {
        const rep = JSON.parse(stdout);
        expect(rep.results[0].status).toBe("cancelled");
      }
    },
  );
});
