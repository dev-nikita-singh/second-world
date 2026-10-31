/**
 * `sw analyze` wiring: a quick `sw perf` writes report.json, then analyze prints the deterministic
 * summary (no AI, no network) as text and JSON.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";

const baseEnv = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

describe("sw analyze (subprocess)", () => {
  let server: Server;
  let dir: string;
  const report = () => join(dir, ".second-world", "reports", "report.json");
  const run = (args: string[]) => runCli(args, { cwd: dir, env: baseEnv, timeoutMs: 60_000 });

  beforeAll(async () => {
    server = createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    dir = mkdtempSync(join(tmpdir(), "sw-analyze-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "sw.config.json"), JSON.stringify({}));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const r = await runCli(
      [
        "-f",
        "json",
        "perf",
        url,
        "--iterations",
        "20",
        "--vus",
        "2",
        "--threshold",
        "p95<0.001ms",
        "--no-history",
      ],
      {
        cwd: dir,
        env: baseEnv,
      },
    );
    expect(r.exitCode, r.stderr).toBe(1); // impossible threshold → a finding to summarise
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("prints the deterministic summary, exit 0", async () => {
    const r = await run(["analyze", report()]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/1 run\(s\) \(performance\) produced \d+ finding\(s\)/);
    expect(r.stdout).toMatch(/threshold-breach/);
  });

  it("--json gives counts and top findings", async () => {
    const r = await run(["analyze", report(), "--json", "--top", "1"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { counts: { runs: number; findings: number }; topFindings: unknown[] };
    expect(j.counts.runs).toBe(1);
    expect(j.counts.findings).toBeGreaterThan(0);
    expect(j.topFindings).toHaveLength(1);
  });

  it("--last does not double-count a run also passed as a file", async () => {
    // A run saved to history; its report.json is the same result.
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const p = await run(["-f", "json", "perf", url, "--iterations", "10", "--vus", "1"]);
    expect(p.exitCode, p.stderr).toBe(0);
    const r = await run(["analyze", report(), "--last", "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { counts: { runs: number } }).counts.runs).toBe(1);
  });

  it("bad --top → exit 2", async () => {
    expect((await run(["analyze", report(), "--top", "x"])).exitCode).toBe(2);
  });

  it("unreadable report → exit 2", async () => {
    expect((await run(["analyze", join(dir, "missing.json")])).exitCode).toBe(2);
  });

  it("no reports → exit 2", async () => {
    expect((await run(["analyze"])).exitCode).toBe(2);
  });
});
