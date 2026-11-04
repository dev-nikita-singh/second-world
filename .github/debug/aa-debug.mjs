// macOS debug only (branch ci-macos-w9): A/A runs under several variants; prints mean p95 per schedule
// parity (even/odd position) and per arm, to find the source of a position effect.
// argv: <iterations> ; env VARIANTS = comma list of: base, cooldown, semi, perarm, gcnone
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const N = Number(process.argv[2] ?? 4);
const REPS = process.env.REPS ?? "10";
const loader = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const variants = (process.env.VARIANTS ?? "base,cooldown,semi,perarm").split(",");

for (const variant of variants) {
  const acc = {};
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const dir = mkdtempSync(join(tmpdir(), "sw-aa-dbg-"));
    mkdirSync(join(dir, ".git"));
    const design = {};
    if (variant === "cooldown") design.cooldown = "500ms";
    if (variant === "perarm") design.lifecycle = "per-arm";
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
        ...(Object.keys(design).length ? { design } : {}),
      }),
    );
    const nodeArgs = variant === "semi" ? ["--max-semi-space-size=64"] : [];
    const r = spawnSync(
      process.execPath,
      [...nodeArgs, "--import", loader, join(ROOT, "src", "cli", "main.ts"), "--seed", String(3 + i), "-f", "json", "whatif", "aa.json", "--aa", "--repetitions", REPS, "--json"],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1", CI: "1", SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") }, encoding: "utf8" },
    );
    if (r.status !== 0) bad++;
    try {
      const res = JSON.parse(r.stdout).results[0];
      const c95 = res.data.comparisons.find((c) => c.metric === "p95");
      console.log(`[${variant}] it ${i} exit ${r.status} p95 ${c95.verdict} rel ${c95.relativeChange.toFixed(3)} p ${c95.p.toFixed(4)}`);
      for (const run of res.data.runs) {
        if (run.status !== "ok") continue;
        for (const k of [`parity${run.index % 2}`, `arm:${run.arm}`, `pos${run.index}`]) {
          acc[k] ??= { n: 0, p95: 0, p50: 0, start: 0 };
          acc[k].n++;
          acc[k].p95 += run.metrics.p95;
          acc[k].p50 += run.metrics.p50;
          acc[k].start += run.startupMs ?? 0;
        }
      }
    } catch (e) {
      console.log(`[${variant}] parse failed`, String(e), r.stderr.slice(-800));
    }
  }
  console.log(`[${variant}] ${bad}/${N} non-zero exits`);
  for (const [k, v] of Object.entries(acc).sort())
    console.log(`[${variant}] ${k} n ${v.n} p50 ${(v.p50 / v.n).toFixed(2)} p95 ${(v.p95 / v.n).toFixed(2)} start ${(v.start / v.n).toFixed(0)}`);
}
