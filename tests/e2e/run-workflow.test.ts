/**
 * `sw run <workflow>` / `sw run --list` end to end (docs/09-cli-and-api.md §1 "sw run",
 * docs/02-architecture.md §4.2): the real CLI in a subprocess, a config with workflows, the calibrated
 * server on 127.0.0.1:0 as the target. Exit codes: 2 config, 3 safety, 5 target-side, 1 findings,
 * 130 cancelled; one combined report + one history run per workflow.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CalibratedServer, startCalibratedServer } from "../fixtures/servers/calibrated.js";
import { REPO_ROOT, runCli, spawnCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { freePort } from "../system/helpers.js";

let srv: CalibratedServer;
let tmp: TmpDir;
let userCfg: TmpDir;
let closedPort: number;

const SHOP = path.join(REPO_ROOT, "examples", "shop-express");
const perf = (target?: string, extra: Record<string, unknown> = {}) => ({
  engine: "performance",
  input: {
    ...(target ? { target } : {}),
    model: "iterations",
    iterations: 20,
    vus: 2,
    warmup: "0s",
    scenarios: [{ name: "get", steps: [{ method: "GET", path: "/fixed/1" }] }],
    ...extra,
  },
});

beforeAll(async () => {
  srv = await startCalibratedServer();
  tmp = await makeTmpDir("sw-e2e-run-");
  userCfg = await makeTmpDir("sw-usercfg-");
  closedPort = await freePort();
  const missing = path.join(tmp.path, "missing.yaml");
  writeFileSync(
    tmp.join("sw.config.json"),
    JSON.stringify({
      project: { root: "." },
      targets: { api: { url: srv.url } },
      safety: { allowHosts: ["127.0.0.1"] },
      workflows: {
        static: {
          steps: {
            arch: { engine: "architecture", input: { project: SHOP, cacheDir: tmp.join("cache") } },
            model: { engine: "model", after: ["arch"], input: { architecture: false } },
          },
        },
        quick: { steps: { load: perf() } },
        mixed: {
          steps: {
            load: perf(),
            broken: { engine: "bugs", input: { openapi: missing } },
            after: { ...perf(), after: ["broken"] },
          },
        },
        tolerant: {
          steps: { load: perf(), broken: { engine: "bugs", optional: true, input: { openapi: missing } } },
        },
        public: { steps: { load: perf("http://93.184.216.34") } },
        down: { steps: { load: perf(`http://127.0.0.1:${closedPort}`) } },
        cyclic: { steps: { a: { ...perf(), after: ["b"] }, b: { ...perf(), after: ["a"] } } },
        long: { steps: { load: perf(undefined, { model: "open", rate: 20, duration: "30s" }) } },
      },
    }),
  );
});

afterAll(async () => {
  await srv?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

const sw = (args: string[], timeoutMs = 90_000) =>
  runCli(args, { cwd: tmp.path, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs });

describe("sw run", () => {
  it("--list prints the workflows (text and JSON)", async () => {
    const r = await sw(["run", "--list"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("static  (2 step(s))");
    expect(r.stdout).toContain("  model: model after arch");
    expect(r.stdout).toContain("  broken: bugs [optional]");
    const j = await sw(["run", "--list", "--json"]);
    const list = JSON.parse(j.stdout) as Array<{ name: string; steps: Array<{ id: string }> }>;
    expect(list.map((w) => w.name)).toEqual([
      "cyclic",
      "down",
      "long",
      "mixed",
      "public",
      "quick",
      "static",
      "tolerant",
    ]);
  }, 60_000);

  it("usage and config errors exit 2 before anything runs", async () => {
    for (const [args, text] of [
      [["run"], "Missing workflow name"],
      [["run", "nope"], 'Unknown workflow "nope"'],
      [["run", "cyclic"], "dependency cycle"],
    ] as const) {
      const before = srv.stats().requests;
      const r = await sw([...args]);
      expect(r.exitCode, `${args.join(" ")}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain(text);
      expect(srv.stats().requests).toBe(before);
    }
  }, 90_000);

  it("--dry-run validates every step and sends nothing; a blocked target exits 3", async () => {
    const before = srv.stats().requests;
    const ok = await sw(["--dry-run", "run", "mixed", "--json"]);
    // the bugs step's contract does not exist: the dry run catches it as the real run would
    expect(ok.exitCode, ok.stderr).toBe(2);
    expect(ok.stderr).toContain("missing.yaml");
    const q = await sw(["run", "quick", "--dry-run"]);
    expect(q.exitCode, q.stderr).toBe(0);
    expect(q.stdout).toContain('workflow "quick" valid: 1 step(s)');
    expect(q.stdout).toContain(`safety check passed for ${srv.url}`);
    expect(q.stdout).toContain("dry run: nothing was sent");
    const pub = await sw(["run", "public", "--dry-run"]);
    expect(pub.exitCode, pub.stderr).toBe(3);
    expect(srv.stats().requests).toBe(before);
  }, 90_000);

  it("runs a workflow: one combined report, one history run labelled with the workflow name", async () => {
    const r = await sw(["run", "static", "-f", "json", "-o", "out-static"]);
    expect(r.exitCode, r.stderr).toBe(1); // shop-express has high architecture findings
    expect(r.stderr).toContain('workflow "static": all required steps completed');
    expect(r.stderr).toMatch(/✖|XX/);
    const rep = JSON.parse(readFileSync(tmp.join("out-static", "report.json"), "utf8"));
    expect(rep.results.map((x: { engine: string }) => x.engine)).toEqual(["architecture", "model"]);
    const h = await sw(["history", "list", "--json"]);
    const runs = JSON.parse(h.stdout) as Array<{ id: string; label?: string; engines: string[] }>;
    expect(runs[0]?.label).toBe("static");
    expect(rep.runId).toBe(runs[0]?.id); // the combined report and the history run share one id
    expect(runs[0]?.engines).toEqual(expect.arrayContaining(["architecture", "model"]));
  }, 120_000);

  it("a passing workflow exits 0; --no-history saves nothing; --json prints the combined report", async () => {
    const before = JSON.parse((await sw(["history", "list", "--json"])).stdout).length;
    const r = await sw(["run", "quick", "--json", "--no-history"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(rep.kind).toBe("second-world-report");
    expect(rep.results[0].engine).toBe("performance");
    expect(JSON.parse((await sw(["history", "list", "--json"])).stdout).length).toBe(before);
  }, 90_000);

  it("a required step that throws a ConfigError exits 2 (its dependant is skipped); an optional one does not", async () => {
    const r = await sw(["run", "mixed", "-f", "json", "-o", "out-mixed"]);
    expect(r.exitCode, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/broken \(bugs\): .*missing\.yaml/);
    expect(r.stderr).toContain("after (performance): skipped, an upstream step failed");
    const rep = JSON.parse(readFileSync(tmp.join("out-mixed", "report.json"), "utf8"));
    expect(rep.results.map((x: { engine: string }) => x.engine)).toEqual(["performance"]);
    const t = await sw(["run", "tolerant", "--no-history"]);
    expect(t.exitCode, t.stderr).toBe(0);
    expect(t.stderr).toContain("[optional]");
  }, 120_000);

  it("an unreachable target exits 5, not 70", async () => {
    const r = await sw(["run", "down", "--no-history"]);
    expect(r.exitCode, r.stderr).toBe(5);
    expect(r.stderr).not.toContain("Internal error");
  }, 90_000);

  // Windows cannot deliver SIGINT to a child (see tests/e2e/cli.test.ts); covered on macOS/Linux CI.
  it.skipIf(process.platform === "win32")(
    "Ctrl+C → graceful stop, cancelled report, exit 130, nothing saved to history",
    async () => {
      const before = JSON.parse((await sw(["history", "list", "--json"])).stdout).length;
      const child = spawnCli(["run", "long", "--json"], {
        cwd: tmp.path,
        env: { SW_USER_CONFIG_DIR: userCfg.path },
        timeoutMs: 40_000,
      });
      const t0 = performance.now();
      const start = srv.stats().requests;
      while (srv.stats().requests === start && performance.now() - t0 < 15_000)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      child.kill("SIGINT");
      const r = await child;
      expect(r.exitCode).toBe(130);
      expect(performance.now() - t0).toBeLessThan(25_000);
      const rep = JSON.parse(String(r.stdout));
      expect(rep.results[0].status).toBe("cancelled");
      expect(JSON.parse((await sw(["history", "list", "--json"])).stdout).length).toBe(before);
    },
    60_000,
  );
});
