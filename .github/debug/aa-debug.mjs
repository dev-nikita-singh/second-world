// macOS debug only (branch ci-macos-w9): run the A/A CLI test command N times and print per-run data.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const N = Number(process.argv[2] ?? 6);
const loader = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
let bad = 0;
for (let i = 0; i < N; i++) {
  const dir = mkdtempSync(join(tmpdir(), "sw-aa-dbg-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(
    join(dir, "aa.json"),
    JSON.stringify({
      name: "aa-tiny",
      baseline: {
        start: [process.execPath, join(ROOT, "tests", "fixtures", "experiments", "tiny-server.mjs")],
        env: { DELAY_MS: "20" },
        readyWhen: { path: "/healthz" },
      },
      workload: { vus: 2, duration: "800ms", warmup: "200ms", scenarios: [{ name: "w", steps: [{ path: "/work" }] }] },
      metrics: ["p50", "p95"],
    }),
  );
  const r = spawnSync(
    process.execPath,
    ["--import", loader, join(ROOT, "src", "cli", "main.ts"), "--seed", "3", "-f", "json", "whatif", "aa.json", "--aa", "--repetitions", "5", "--json"],
    { cwd: dir, env: { ...process.env, NO_COLOR: "1", CI: "1", SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") }, encoding: "utf8" },
  );
  if (r.status !== 0) bad++;
  console.log(`\n=== iteration ${i} exit ${r.status}`);
  try {
    const res = JSON.parse(r.stdout).results[0];
    console.log("status", res.status, "limitations", res.limitations.map((l) => l.code).join(","));
    for (const c of res.data.comparisons)
      console.log(c.metric, c.verdict, "rel", c.relativeChange.toFixed(4), "ci", c.ci.lower.toFixed(4), c.ci.upper.toFixed(4), "p", c.p.toFixed(4), "pAdj", c.pAdjusted.toFixed(4), "med", c.medians.baseline.toFixed(3), c.medians.variant.toFixed(3));
    for (const run of res.data.runs)
      console.log(`  #${run.index} ${run.arm} rep${run.rep} ${run.status} start ${run.startupMs?.toFixed(0)}ms p50 ${run.metrics.p50?.toFixed(3)} p95 ${run.metrics.p95?.toFixed(3)} sat ${run.generatorSaturated}`);
  } catch (e) {
    console.log("parse failed", String(e), r.stdout.slice(0, 500), r.stderr.slice(-2000));
  }
}
console.log(`\n${bad}/${N} non-zero exits`);
