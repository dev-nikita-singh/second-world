/**
 * `sw agent` — Adversarial Test Agent (QA test-case generator). See docs/09-cli-and-api.md §1 and
 * docs/03-engines/adversarial-test-agent.md; wiring per CONTRACTS.md "sw-agent".
 * Every proposed scenario is validated by the agent's allow-list policy before execution; mutating
 * requests follow the Bug Hunter gates, destructive operations additionally need --allow-destructive
 * together with --yes. Exit codes and history as for `sw bugs`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseDuration } from "../../core/config/units.js";
import { ConfigError, SafetyError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";

type Obj = Record<string, unknown>;

const BUDGET_KEYS: Record<string, string> = {
  requests: "maxRequests",
  iterations: "maxIterations",
  time: "maxDuration",
  duration: "maxDuration",
  patience: "patience",
  rps: "maxRps",
  concurrency: "maxConcurrency",
};

/** `--budget requests=500,iterations=100,time=2m,patience=30` → budget object (durations in ms). */
export function parseBudget(spec: string): Obj {
  const out: Obj = {};
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const key = eq > 0 ? part.slice(0, eq).trim().toLowerCase() : "";
    const raw = eq > 0 ? part.slice(eq + 1).trim() : "";
    const target = BUDGET_KEYS[key];
    if (!target || raw === "") {
      throw new ConfigError("SW_CONFIG_FLAG", `Invalid --budget entry "${part}"`, {
        hint: "Use --budget requests=N,iterations=N,time=30s,patience=N (also rps=N, concurrency=N)",
      });
    }
    if (target === "maxDuration") out[target] = parseDuration(raw, `--budget ${key}`);
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new ConfigError("SW_CONFIG_FLAG", `--budget ${key} must be a positive integer, got "${raw}"`);
      out[target] = n;
    }
  }
  return out;
}

function list(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

/** Maps `sw agent` flags to a loose agent input. */
export function agentInputFromFlags(o: Obj, cwd: string): Obj {
  const input: Obj = {};
  if (o.target) input.target = o.target;
  if (o.openapi) input.openapi = resolve(cwd, String(o.openapi));
  if (o.bandit) input.bandit = o.bandit;
  const tech = list(o.techniques);
  if (tech) input.techniques = tech;
  if (typeof o.budget === "string") input.budget = parseBudget(o.budget);
  if (o.allowMutations === true) input.allowMutations = true;
  if (o.allowDestructive === true) input.allowDestructive = true;
  const include = list(o.include);
  const exclude = list(o.exclude);
  if (include || exclude) input.operations = { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
  const ctx = o.context as string[] | undefined;
  if (ctx?.length) input.context = { files: ctx.map((f) => resolve(cwd, f)) };
  return input;
}

interface SuggestedTestLike {
  filename: string;
  vitest: string;
  config?: string;
  title?: string;
}

/** Writes suggested Vitest files into `dir` (basename only: no path traversal). Returns written paths. */
export function exportSuggestedTests(dir: string, tests: readonly SuggestedTestLike[]): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const t of tests) {
    const name = basename(t.filename).replace(/[^\w.-]/g, "_");
    const p = join(dir, name.endsWith(".ts") ? name : `${name}.test.ts`);
    writeFileSync(p, t.vitest, "utf8");
    written.push(p);
  }
  return written;
}

export async function agentCommand(o: Obj, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  if (o.allowDestructive === true && !g.yes && !g.approveDisruptive) {
    throw new SafetyError("SW_SAFETY_APPROVAL_REQUIRED", "--allow-destructive requires explicit approval", {
      hint: "Add --yes (logged to the audit trail). Destructive operations (DELETE, …) are only run against test accounts you configured",
    });
  }
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const flags = agentInputFromFlags(o, world.config.invocationCwd ?? world.config.cwd);
    const plan = world.buildInput("agent", flags);
    if (typeof plan.target !== "string") {
      throw new ConfigError("SW_CONFIG_NO_TARGET", "No agent target given", { hint: "Pass --target, or set agent.target / bugs.target / targets in sw.config" });
    }
    await world.safety.preflight(plan.target);
    if (g.dryRun) {
      const { parseAgentInput } = await import("../../engines/agent/index.js");
      const parsed = parseAgentInput(plan);
      const view = { ...parsed, auth: parsed.auth ? { ...parsed.auth, roles: Object.keys(parsed.auth.roles ?? {}) } : undefined };
      out(JSON.stringify(world.redactor.redactObject({ dryRun: true, target: plan.target, input: view }), null, 2));
      process.exitCode = 0;
      return;
    }
    attachProgress(world, g, { json: o.json === true });
    if (!g.quiet && !o.json) {
      world.on("agent.done", (p) => {
        const d = p as { iterations?: number; findings?: number; defects?: number; stopReason?: string };
        err(s.dim(`agent: ${d.iterations ?? 0} iterations, ${d.findings ?? 0} finding(s), ${d.defects ?? 0} reproduced defect(s); stop: ${d.stopReason ?? "?"}`));
      });
    }
    const result = (await world.agent.run(flags)) as EngineResult<{ suggestedTests?: SuggestedTestLike[] }>;
    if (typeof o.exportTests === "string") {
      const dir = resolve(world.config.invocationCwd ?? world.config.cwd, o.exportTests);
      const tests = result.data?.suggestedTests ?? [];
      const files = exportSuggestedTests(dir, tests);
      if (!g.quiet) {
        err(s.dim(`exported ${files.length} suggested test(s) to ${dir}`));
        for (const t of tests) if (t.config) err(s.dim(`  agent.regression snippet for ${t.filename}:\n${t.config}`));
      }
    }
    await finishRun(world, result as EngineResult, g, { json: o.json === true, history: o.history as boolean | undefined, label: "agent" });
  } finally {
    removeSignals();
    await world.close();
  }
}
