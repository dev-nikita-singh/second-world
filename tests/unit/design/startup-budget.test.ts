/**
 * CLI startup budget (docs/05-optimization.md, docs/02-architecture.md §4.1 lazy engines,
 * docs/16-system-design.md §1). `sw --version` and `sw --help` must stay cheap: no engine, adapter
 * or heavy dependency may be loaded before a command actually runs.
 *
 * Two checks:
 *  1. Deterministic: the modules statically reachable (value imports) from src/cli/main.ts contain
 *     no engine and no adapter, and stay few.
 *  2. Measured: wall time and peak RSS (process.resourceUsage().maxRSS) of a cold
 *     `node --import tsx src/cli/main.ts --version|--help` (from source, as the e2e tests run it).
 *
 * Measured on the reference machine (Windows 11, Node 24, 2026-11-01), from source via tsx:
 *   --version ≈ 285–325 ms, maxRSS ≈ 53–55 MB;  --help ≈ 280–300 ms, maxRSS ≈ 55–57 MB
 *   (built dist/cli.mjs: ≈ 155–205 ms, ≈ 51 MB; bare `node -e 0` ≈ 75 ms).
 * Budget ≈ 3× measured: best of 3 runs ≤ 1000 ms and maxRSS ≤ 170 MB.
 * Override on slow CI: SW_STARTUP_BUDGET_MS / SW_STARTUP_BUDGET_RSS_MB, or skip the measured part
 * with SW_SKIP_STARTUP_BUDGET=1 (the deterministic part always runs).
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImportGraph, layerOf } from "./import-graph.js";

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "../../..");
const ENTRY = path.join(REPO, "src", "cli", "main.ts");
const TSX = pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;

const BUDGET_MS = Number(process.env.SW_STARTUP_BUDGET_MS ?? 1000);
const BUDGET_RSS_MB = Number(process.env.SW_STARTUP_BUDGET_RSS_MB ?? 170);
const SKIP = process.env.SW_SKIP_STARTUP_BUDGET === "1";

describe("CLI entry loads nothing heavy (deterministic)", () => {
  it("src/cli/main.ts statically reaches no engine or adapter module", () => {
    const value = buildImportGraph().filter((e) => e.kind === "value");
    const seen = new Set(["cli/main.ts"]);
    const queue = ["cli/main.ts"];
    while (queue.length > 0) {
      const f = queue.pop() as string;
      for (const e of value) {
        if (e.from === f && !seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    const heavy = [...seen].filter((m) =>
      ["engines", "adapters"].includes(layerOf(m).split("/")[0] as string),
    );
    expect(heavy).toEqual([]);
    // Measured 1 (main.ts only; every command is a dynamic import). Generous ceiling.
    expect(seen.size).toBeLessThanOrEqual(15);
  });
});

describe.skipIf(SKIP)("CLI startup time and memory budget (measured)", () => {
  let dir: string;
  let probe: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sw-budget-"));
    probe = path.join(dir, "rss-probe.mjs");
    await writeFile(
      probe,
      [
        'import { writeSync } from "node:fs";',
        'process.on("exit", () => { writeSync(2, "\\nSW_MAXRSS_KB=" + process.resourceUsage().maxRSS + "\\n"); });',
        "",
      ].join("\n"),
    );
  });
  afterAll(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  async function measure(arg: string): Promise<{ ms: number; rssMb: number; stdout: string }> {
    const t0 = performance.now();
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", TSX, "--import", pathToFileURL(probe).href, ENTRY, arg],
      { cwd: REPO, env: { ...process.env, NO_COLOR: "1", CI: "1" }, timeout: 30_000, windowsHide: true },
    );
    const ms = performance.now() - t0;
    const m = /SW_MAXRSS_KB=(\d+)/.exec(stderr);
    if (m === null) throw new Error(`rss probe did not report; stderr: ${stderr}`);
    return { ms, rssMb: Number(m[1]) / 1024, stdout };
  }

  for (const arg of ["--version", "--help"]) {
    it(`sw ${arg}: best of 3 ≤ ${BUDGET_MS} ms, peak RSS ≤ ${BUDGET_RSS_MB} MB`, async () => {
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await measure(arg));
      expect(runs[0]?.stdout.length).toBeGreaterThan(0);
      const best = Math.min(...runs.map((r) => r.ms));
      const rss = Math.max(...runs.map((r) => r.rssMb));
      expect(best, `startup ${arg} took ${best.toFixed(0)} ms`).toBeLessThanOrEqual(BUDGET_MS);
      expect(rss, `peak RSS ${arg} ${rss.toFixed(1)} MB`).toBeLessThanOrEqual(BUDGET_RSS_MB);
    }, 120_000);
  }
});
