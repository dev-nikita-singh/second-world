import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

// Regression (wave 7, sw-design7 report): `--dry-run` printed "config valid" (exit 0) for inputs the
// real run rejects with exit 2 — threshold expressions, extract paths, unknown reliability
// scenarios/dependencies. A dry run must fail exactly where the real run would fail on config.

describe("--dry-run validates what the real run validates", () => {
  let dir: TmpDir;
  let badCfg: string;
  beforeAll(async () => {
    dir = await makeTmpDir("sw-dryrun-val-");
    await writeFile(
      join(dir.path, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: "http://127.0.0.1:3000" } },
        reliability: { dependencies: { db: { injector: "builtin", upstream: "http://127.0.0.1:5432" } } },
      }),
    );
    badCfg = dir.join("bad.config.json");
    await writeFile(
      badCfg,
      JSON.stringify({
        targets: { api: { url: "http://127.0.0.1:3000" } },
        performance: { thresholds: { http: ["p95 < banana"] } },
      }),
    );
  });
  afterAll(() => dir.cleanup());

  const env = () => ({ SW_USER_CONFIG_DIR: dir.join("no-user-config") });
  const run = (args: string[]) => runCli(args, { cwd: dir.path, env: env(), timeoutMs: 60_000 });

  it("perf: valid input still passes (control)", async () => {
    const r = await run(["--dry-run", "perf", "--threshold", "p95 < 300ms"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("config valid");
  });

  it.each([
    ["perf --threshold", ["--dry-run", "perf", "--threshold", "p95 < banana"], "banana"],
    ["perf --json --threshold", ["--dry-run", "perf", "--json", "--threshold", "p95 < banana"], "banana"],
    [
      "stress --threshold",
      ["--dry-run", "stress", "--steps", "1,2", "--hold", "1s", "--threshold", "p95<banana"],
      "banana",
    ],
    [
      "reliability unknown scenario",
      ["--dry-run", "reliability", "run", "no-such-scenario", "--dependency", "db"],
      "no-such-scenario",
    ],
    [
      "reliability unknown dependency",
      ["--dry-run", "reliability", "run", "dependency-latency", "--dependency", "nope"],
      "nope",
    ],
    [
      "reliability bad --steady",
      [
        "--dry-run",
        "reliability",
        "run",
        "dependency-latency",
        "--dependency",
        "db",
        "--steady",
        "p95 < banana",
      ],
      "banana",
    ],
  ])("%s exits 2 instead of 'config valid'", async (_n, args, needle) => {
    const r = await run(args);
    expect(r.stdout).not.toContain("config valid");
    expect(r.exitCode, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain(needle);
  });

  it("perf: plan errors (extract path) fail the dry run too", async () => {
    const cfg = dir.join("extract.config.json");
    await writeFile(
      cfg,
      JSON.stringify({
        targets: { api: { url: "http://127.0.0.1:3000" } },
        performance: {
          scenarios: [{ name: "a", steps: [{ method: "GET", path: "/x", extract: { id: "no-dollar" } }] }],
        },
      }),
    );
    const r = await run(["-c", cfg, "--dry-run", "perf"]);
    expect(r.stdout).not.toContain("config valid");
    expect(r.exitCode, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("extract path");
  });

  it("perf: thresholds from the config file are validated (and the error names the section)", async () => {
    const r = await run(["-c", badCfg, "--dry-run", "perf"]);
    expect(r.stdout).not.toContain("config valid");
    expect(r.exitCode, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("performance.thresholds.http");
  });
});
