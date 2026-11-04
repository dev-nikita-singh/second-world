/**
 * Wave 5 QA regressions (owner: sw-qa): bugs found by running the CLI as a user would.
 * Each test names the bug it locks in (all fixed by main in wave 5). docs/09-cli-and-api.md §1 (exit codes),
 * README "Exit codes", docs/08-configuration.md §1 (relative paths).
 *
 * Runs the real CLI from source (tests/helpers/cli.ts) in temp dirs, against an in-process
 * HTTP server on 127.0.0.1:0 or a refused port. No example app is needed.
 */
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { EXAMPLES_DIR, freePort, parseJson, portRefuses } from "../system/helpers.js";

const CONTRACT = path.join(EXAMPLES_DIR, "shop-express", "openapi.yaml");

let server: http.Server;
let url: string;
let deadUrl: string;
let userCfg: TmpDir;
let tmp: TmpDir;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dead = await freePort();
  expect(await portRefuses(dead)).toBe(true);
  deadUrl = `http://127.0.0.1:${dead}`;
  userCfg = await makeTmpDir("sw-qa5-usercfg-");
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await userCfg?.cleanup();
});
beforeEach(async () => {
  tmp = await makeTmpDir("sw-qa5 e2e "); // space on purpose: paths with spaces must work
});
afterEach(async () => {
  await tmp.cleanup();
});

const sw = (args: string[], timeoutMs = 90_000) =>
  runCli(args, { cwd: tmp.path, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs });

function writeConfig(extra: Record<string, unknown> = {}): void {
  const cfg = {
    targets: { api: { url } },
    safety: { allowHosts: ["127.0.0.1"] },
    performance: {
      target: "api",
      warmup: "2s",
      scenarios: [{ name: "root", steps: [{ method: "GET", path: "/" }] }],
      thresholds: { "http.error_rate": "< 1%" },
    },
    ...extra,
  };
  writeFileSync(path.join(tmp.path, "sw.config.json"), JSON.stringify(cfg, null, 2));
}

describe("sw doctor --quick", () => {
  // Fixed (main f0ca054): quick mode reported unprobed git/docker as "not found" warnings.
  it("does not claim tools are missing when it did not probe them", async () => {
    const r = await sw(["doctor", "--quick"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/(git|docker) not found/);
    expect(r.stdout).toMatch(/not probed/);
    expect(r.stdout).toMatch(/0 warning\(s\)/);
  });
});

describe("sw perf --model iterations with a configured warmup", () => {
  // Fixed (main a159296): all iterations ran inside the warmup → 0 measured, 2 threshold breaches on n/a, exit 1.
  it("measures every requested iteration and keeps thresholds on real data", async () => {
    writeConfig();
    const r = await sw([
      "perf",
      "--model",
      "iterations",
      "--iterations",
      "40",
      "--vus",
      "2",
      "--json",
      "--no-history",
    ]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const res = parseJson(r.stdout).results[0];
    expect(res.data.totals.iterations).toBe(40);
    expect(res.data.totals.requests).toBe(40);
    expect(res.limitations.map((l: { code: string }) => l.code)).toContain("warmup-ignored-iterations");
    expect(
      res.findings.filter((f: { classification: string }) => f.classification === "threshold-breach"),
    ).toEqual([]);
  });
});

describe("unreachable target (README exit table: 5 = target unreachable)", () => {
  // The dead port was free in beforeAll; in a long full-suite run another test's server can be
  // given the same ephemeral port, so check it still refuses before every test.
  beforeEach(async () => {
    for (let i = 0; i < 5 && !(await portRefuses(Number(new URL(deadUrl).port))); i++)
      deadUrl = `http://127.0.0.1:${await freePort()}`;
    expect(await portRefuses(Number(new URL(deadUrl).port))).toBe(true);
  });

  // Fixed (main, wave 5; was reported by sw-qa 2026-10-29): sw bugs against a dead port → "✔ PASS (exit 0)", 168 transport errors,
  // coverage 100%, every operation "pass" (bugs/cases.ts:561, bugs/engine.ts:537).
  it("sw bugs against a refused port does not pass (exit 5)", async () => {
    const r = await sw(["bugs", "--target", deadUrl, "--openapi", CONTRACT, "--no-history"]);
    expect(r.exitCode).toBe(5);
  });

  // Fixed (main, wave 5; was reported by sw-qa 2026-10-29): same false PASS from the Adversarial Test Agent.
  it("sw agent against a refused port does not pass (exit 5)", async () => {
    const r = await sw(["agent", "--target", deadUrl, "--openapi", CONTRACT, "--no-history"]);
    expect(r.exitCode).toBe(5);
  });

  // Fixed (main, wave 5; was reported by sw-qa 2026-10-29): perf exits 70 ("bug in SECOND WORLD") instead of 5 (reporting/model.ts:122).
  it("sw perf against a refused port exits 5, not 70", async () => {
    const r = await sw(["perf", deadUrl, "--duration", "1s", "--no-history"]);
    expect(r.stdout + r.stderr).toMatch(/target-unreachable|unreachable/i);
    expect(r.exitCode).toBe(5);
  });

  // Fixed (main, wave 5; was reported by sw-qa 2026-10-29): stress exits 70 "engine error: stress" for a dead target.
  it("sw stress against a refused port exits 5, not 70", async () => {
    const r = await sw(["stress", deadUrl, "--steps", "2", "--hold", "1s", "--no-history"]);
    expect(r.exitCode, `timedOut=${r.timedOut}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`).toBe(5);
  });
});

describe("invalid paths and outputs", () => {
  // Fixed (main, wave 5; was reported by sw-qa 2026-10-29): inspect of a non-existent directory exits 0 with an ARCH_NO_FILES limitation.
  it("sw inspect <missing dir> is an argument error (exit 2)", async () => {
    const r = await sw(["inspect", path.join(tmp.path, "does-not-exist"), "--no-history"]);
    expect(r.exitCode).toBe(2);
  });

  // Fixed (main c7b391e): an unwritable -o dir gave "Internal error ENOTDIR" + stack, exit 70, after the whole
  // load test had run, and the run was not saved to history. Now a pre-run check refuses it (exit 2, no load).
  it("an unwritable -o dir is refused before any load (exit 2, clear message)", async () => {
    writeConfig();
    writeFileSync(path.join(tmp.path, "afile"), "x");
    const r = await sw(["perf", "--duration", "1s", "-o", "afile/sub", "-f", "json"]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(2);
    expect(r.stderr).not.toMatch(/Internal error|\n\s+at /);
    expect(r.stderr).toMatch(/SW_CONFIG_OUTDIR|afile/);
    expect(r.stdout).not.toMatch(/requests/); // nothing was measured
  });
});

describe("one run, one id", () => {
  // Fixed (main, src/core/world.ts history.save): the header/report.json runId differed from the id history
  // stored, so `sw history show <runId from report>` → "No run … in history".
  it("sw history show accepts the runId printed in the report", async () => {
    writeConfig();
    const r = await sw(["perf", "--duration", "1s", "--json"]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const runId = parseJson(r.stdout).runId as string;
    expect(existsSync(path.join(tmp.path, ".second-world", "history"))).toBe(true);
    const show = await sw(["history", "show", runId]);
    expect(show.exitCode, show.stderr).toBe(0);
  });
});
