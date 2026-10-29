/**
 * System test: performance regression detection across runs via the CLI
 * (docs/03-engines/evidence-and-history.md, docs/09-cli-and-api.md `sw history`).
 * Baseline = shop-fastify FIXED=1 (indexed search), current = seeded variant (full scan with one
 * query per product). With one run per side `sw history diff` reports the movement without
 * statistics (exit 0, by design); with ≥ 5 runs per side the statistical comparison must call the
 * p95 change "regressed", both through the public history store and through
 * `sw history diff label:fixed:5 label:seeded:5` (exit 1).
 * Owner: sw-qa.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld } from "../../src/index.js";
import { runCli } from "../helpers/cli.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { parseJson } from "./helpers.js";

let tmp: TmpDir;
let userCfg: TmpDir;
let fixed: RunningExample;
let seeded: RunningExample;

const sw = (args: string[], timeoutMs = 60_000) =>
  runCli(args, { cwd: tmp.path, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs });

async function perfRun(target: string): Promise<string> {
  const r = await sw(["--label", target, "perf", "--target", target, "--json"]);
  expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
  const m = /history: saved run (\S+)/.exec(r.stderr);
  if (m?.[1]) return m[1];
  const list = parseJson((await sw(["history", "list", "--json", "--limit", "1"])).stdout, "history list");
  return list[0].id as string;
}

beforeAll(async () => {
  tmp = await makeTmpDir("sw-sys-reg-");
  userCfg = await makeTmpDir("sw-sys-usercfg-");
  mkdirSync(tmp.join(".git"));
  fixed = await startExample("shop-fastify", { fixed: true });
  seeded = await startExample("shop-fastify", { fixed: false });
  writeFileSync(
    tmp.join("sw.config.json"),
    JSON.stringify({
      targets: { fixed: { url: fixed.url }, seeded: { url: seeded.url } },
      safety: { allowHosts: ["127.0.0.1"] },
      performance: {
        model: "closed",
        vus: 4,
        duration: "2s",
        warmup: "0s",
        seed: 42,
        scenarios: [
          {
            name: "search",
            steps: [{ method: "GET", path: "/products/search?q=red", expect: { status: 200 } }],
          },
        ],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await fixed?.close();
  await seeded?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

const REPS = 5; // compareSamples minRuns default (src/shared/stats/compare.ts)

describe("regression flow: baseline → slower variant → sw history diff", () => {
  const baseIds: string[] = [];
  const slowIds: string[] = [];

  it("records repeated baseline runs (FIXED=1) and names one as baseline", async () => {
    for (let i = 0; i < REPS; i++) baseIds.push(await perfRun("fixed"));
    expect(new Set(baseIds).size).toBe(REPS);
    const set = await sw(["history", "baseline", "set", "main", baseIds[0] as string]);
    expect(set.exitCode, set.stderr).toBe(0);
    const show = await sw(["history", "show", "baseline:main", "--json"]);
    expect(show.exitCode, show.stderr).toBe(0);
    expect(JSON.stringify(parseJson(show.stdout, "history show"))).toContain(baseIds[0]);
  }, 120_000);

  it("sw history diff baseline:main vs one slow run → p95 'moved worse' (single run: no statistics, exit 0)", async () => {
    for (let i = 0; i < REPS; i++) slowIds.push(await perfRun("seeded"));
    const r = await sw(["history", "diff", "baseline:main", slowIds[0] as string, "--json"]);
    const cmp = parseJson(r.stdout, "history diff");
    const p95 = cmp.metrics.find((m: any) => m.metric === "performance.http.p95");
    expect(p95, JSON.stringify(cmp.metrics)).toBeDefined();
    expect(p95.method).toBe("single-run");
    expect(p95.movement).toBe("worse");
    expect(p95.relativeChange).toBeGreaterThan(1); // seeded full scan is many times slower
    // documented behaviour: a single run per side never yields a statistical regression
    expect(cmp.regressions).toEqual([]);
    expect(r.exitCode).toBe(0);
    const tty = await sw(["history", "diff", "baseline:main", slowIds[0] as string]);
    expect(tty.stdout).toMatch(/p95/);
    expect(tty.stdout.toLowerCase()).toMatch(/worse/);
  }, 120_000);

  it("statistical diff over 5 vs 5 runs (public history store) → p95 regressed", async () => {
    const world = await createWorld({ cwd: tmp.path, probe: false, auditFile: false, userConfig: false });
    try {
      const store = (await world.history.store()) as unknown as {
        diff(a: string[], b: string[]): Promise<{ regressions: string[]; metrics: any[] }>;
      };
      const cmp = await store.diff(baseIds, slowIds);
      const p95 = cmp.metrics.find((m) => m.metric === "performance.http.p95");
      expect(p95?.method).toBe("statistical");
      expect(p95?.verdict, JSON.stringify(p95)).toBe("regressed");
      expect(cmp.regressions).toContain("performance.http.p95");
      // and the reverse direction is an improvement, never a regression
      const rev = await store.diff(slowIds, baseIds);
      expect(rev.regressions).toEqual([]);
      expect(rev.metrics.find((m) => m.metric === "performance.http.p95")?.verdict).toBe("improved");
    } finally {
      await world.close();
    }
  }, 60_000);

  it("sw history diff label:fixed:5 label:seeded:5 → statistical p95 regression, exit 1 (and 0 in reverse)", async () => {
    const r = await sw(["history", "diff", `label:fixed:${REPS}`, `label:seeded:${REPS}`, "--json"]);
    expect(r.exitCode, r.stdout.slice(0, 3000) + r.stderr).toBe(1);
    const cmp = parseJson(r.stdout, "history diff label");
    expect(cmp.regressions).toContain("performance.http.p95");
    const ids = `${slowIds.join(",")}`;
    const rev = await sw(["history", "diff", ids, baseIds.join(","), "--json"]);
    expect(rev.exitCode, rev.stdout.slice(0, 3000) + rev.stderr).toBe(0);
  }, 60_000);

  it("history trend and verify work over the recorded runs", async () => {
    const t = await sw(["history", "trend", "--metric", "p95", "--json"]);
    expect(t.exitCode, t.stderr).toBe(0);
    const v = await sw(["history", "verify", "--json"]);
    expect(v.exitCode, v.stdout + v.stderr).toBe(0);
  }, 30_000);
});
