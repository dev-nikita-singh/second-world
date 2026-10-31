/**
 * `sw doctor` — environment & capability checklist. See docs/06-environments-and-portability.md §3.
 */
import { resolve } from "node:path";
import { doctorChecks, probeEnvironment } from "../../core/probe/probe.js";
import { projectChecks } from "../../core/probe/project.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, out, style } from "../output.js";

export async function doctorCommand(o: { json?: boolean; quick?: boolean }, g: GlobalOptions): Promise<void> {
  const cwd = process.cwd();
  const [report, project] = await Promise.all([
    probeEnvironment({ full: !o.quick }),
    projectChecks({ cwd, ...(g.config ? { configPath: resolve(cwd, g.config) } : {}) }),
  ]);
  const checks = [...doctorChecks(report), ...project];
  if (o.json) {
    out(JSON.stringify({ ...report, checks }, null, 2));
    process.exitCode = 0;
    return;
  }
  const s = style(colorEnabled(g), report.terminal.unicode);
  const sym = { ok: s.ok, warn: s.warn, fail: s.fail, info: s.info } as const;
  out(s.bold("SECOND WORLD doctor"));
  for (const c of checks) {
    out(`${sym[c.status]} ${c.label}${c.fix ? ` ${s.dim("→")} ${c.fix}` : ""}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  out(s.dim(`\n${fails} problem(s), ${warns} warning(s)`));
  // A failing check (unsupported runtime) is a missing capability.
  process.exitCode = fails > 0 ? 4 : 0;
}
