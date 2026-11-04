/**
 * `sw run <workflow>` / `sw run --list` — runs a config workflow (`workflows.<name>`: a DAG of engine
 * steps) through `world.run(name)`. docs/09-cli-and-api.md §1 "sw run", docs/02-architecture.md §4.2.
 *
 * Same plumbing as the single-engine commands (src/cli/run-common.ts): global flags, report dir check,
 * Ctrl+C (graceful, then abort → 130), one combined report of every step's result, one history run.
 * Exit code: 130 if cancelled; otherwise the exit code of the first required step (topological order)
 * that threw (2 config, 3 safety, 4 capability, 5 target, 70 only for an unexpected error); otherwise
 * the combined report's verdict (0 / 1 / 3 / 5 / 70 for an engine error result). Optional steps never
 * change the exit code. `--dry-run` plans the DAG and validates every step's input and target; sends nothing.
 */
import { ConfigError, ExitCode, isSecondWorldError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { StepOutcome, WorkflowStep } from "../../core/orchestrator.js";
import type { World } from "../../core/world.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, type Style, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";

export interface RunFlags {
  list?: boolean;
  json?: boolean;
  /** commander `--no-history` → false */
  history?: boolean;
}

type Workflows = Record<string, { steps: Record<string, WorkflowStep>; concurrency?: number }>;

function workflowsOf(world: World): Workflows {
  return (world.config.config.workflows ?? {}) as Workflows;
}

function listWorkflows(world: World, o: RunFlags): void {
  const wfs = workflowsOf(world);
  const names = Object.keys(wfs).sort();
  if (o.json) {
    out(
      JSON.stringify(
        names.map((name) => {
          const wf = wfs[name] as Workflows[string];
          return {
            name,
            ...(wf.concurrency !== undefined ? { concurrency: wf.concurrency } : {}),
            steps: Object.entries(wf.steps).map(([id, st]) => ({
              id,
              engine: st.engine,
              after: st.after ?? [],
              optional: st.optional === true,
              continueOnError: st.continueOnError === true,
            })),
          };
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (names.length === 0) {
    out("no workflows defined (add `workflows: { <name>: { steps: { … } } }` to sw.config)");
    return;
  }
  for (const name of names) {
    const wf = wfs[name] as Workflows[string];
    const steps = Object.entries(wf.steps);
    out(
      `${name}  (${steps.length} step(s)${wf.concurrency !== undefined ? `, concurrency ${wf.concurrency}` : ""})`,
    );
    for (const [id, st] of steps) {
      const flags = [st.optional ? "optional" : "", st.continueOnError ? "continueOnError" : ""].filter(
        Boolean,
      );
      const after = st.after?.length ? ` after ${st.after.join(", ")}` : "";
      out(`  ${id}: ${st.engine}${after}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
    }
  }
}

/** Static checks shared by the dry run and the real run: DAG is valid, every required engine exists. */
async function planOf(
  world: World,
  name: string,
): Promise<{ order: string[]; steps: Record<string, WorkflowStep> }> {
  const wf = workflowsOf(world)[name];
  if (!wf) {
    const known = Object.keys(workflowsOf(world));
    throw new ConfigError("SW_CONFIG_WORKFLOW", `Unknown workflow "${name}"`, {
      hint: known.length
        ? `Defined workflows: ${known.join(", ")} (see \`sw run --list\`)`
        : "No workflows in the config: add `workflows.<name>.steps`",
    });
  }
  const { planWorkflow } = await import("../../core/orchestrator.js");
  const order = planWorkflow(wf.steps);
  if (order.length === 0) {
    throw new ConfigError("SW_CONFIG_WORKFLOW", `Workflow "${name}" has no steps`);
  }
  for (const id of order) {
    const st = wf.steps[id] as WorkflowStep;
    if (!st.optional && !world.registry.has(st.engine)) {
      throw new ConfigError(
        "SW_CONFIG_WORKFLOW",
        `Workflow step "${id}" uses unknown engine "${st.engine}"`,
        {
          hint: `Engines: ${world.registry.ids().join(", ")}`,
        },
      );
    }
  }
  return { order, steps: wf.steps };
}

const PARSE_ALIASES: Record<string, string> = {
  whatif: "parseExperimentInput",
  evolution: "parseEvolutionInput",
};

/** Validates one step as the engine run would before its first request (input, target, contract…). */
async function dryRunStep(world: World, step: WorkflowStep): Promise<Record<string, unknown>> {
  const id = step.engine;
  const plan = world.buildInput(id, step.input ?? {});
  const target = typeof plan.target === "string" ? plan.target : undefined;
  if (target !== undefined) await world.safety.preflight(target);
  const { engine, module } = await world.registry.load(id);
  const parseName = PARSE_ALIASES[id] ?? `parse${id.charAt(0).toUpperCase()}${id.slice(1)}Input`;
  const parseFn = (module as Record<string, unknown>)[parseName];
  let parsed: unknown;
  if (typeof parseFn === "function") parsed = (parseFn as (x: unknown) => unknown)(plan);
  else {
    const r = engine.inputSchema.safeParse(plan);
    if (!r.success) {
      const issues = r.error.issues.map((i) => `${[id, ...i.path].join(".")}: ${i.message}`);
      throw new ConfigError("SW_CONFIG_INVALID", `Invalid ${id} input: ${issues.join("; ")}`);
    }
    parsed = r.data;
  }
  // The same deeper checks the single-engine commands run under --dry-run.
  if (id === "performance") {
    const perf = await import("../../engines/performance/index.js");
    perf.checkPerformancePlan(parsed as never);
  } else if (id === "stress") {
    const perf = await import("../../engines/performance/index.js");
    const stress = await import("../../engines/stress/index.js");
    const p = parsed as { base: never; loadType: never };
    perf.checkPerformancePlan(
      perf.parsePerformanceInput(stress.stagePerfInput(p.base, p.loadType, 1, 1000, 0, 0)),
    );
  } else if (id === "reliability") {
    const rel = await import("../../engines/reliability/index.js");
    rel.checkReliabilityInput(parsed as never);
  } else if (id === "bugs") {
    const { checkBugsSession } = await import("./bugs.js");
    await checkBugsSession(world, parsed as never);
  } else if (id === "agent") {
    const { checkAgentInput } = await import("./agent.js");
    await checkAgentInput(world, parsed as never);
  }
  return { engine: id, ...(target !== undefined ? { target, safety: "allowed" } : {}) };
}

function outcomeLine(s: Style, id: string, step: WorkflowStep, o: StepOutcome | undefined): string {
  const tags = [step.optional ? "optional" : "", step.continueOnError ? "continueOnError" : ""].filter(
    Boolean,
  );
  const suffix = tags.length ? s.dim(` [${tags.join(", ")}]`) : "";
  if (!o) return `  ${s.warn} ${id} (${step.engine}): not run${suffix}`;
  if (o.status === "ok") {
    const st = o.result.status;
    const mark = st === "passed" ? s.ok : st === "failed" ? s.fail : s.warn;
    return `  ${mark} ${id} (${step.engine}): ${st}${suffix}`;
  }
  if (o.status === "skipped") return `  ${s.warn} ${id} (${step.engine}): skipped, ${o.reason}${suffix}`;
  if (o.result) return `  ${s.fail} ${id} (${step.engine}): ${o.result.status}${suffix}`;
  const e = o.error;
  const msg = isSecondWorldError(e) ? `${e.message} [${e.code}]` : e instanceof Error ? e.message : String(e);
  return `  ${s.fail} ${id} (${step.engine}): ${msg}${suffix}`;
}

function errorExitCode(e: unknown): number {
  if (isSecondWorldError(e)) return e.exitCode;
  if (e && typeof e === "object" && (e as { name?: string }).name === "AbortError") return ExitCode.Cancelled;
  return ExitCode.Internal;
}

export async function runCommand(name: string | undefined, o: RunFlags, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  if (o.list) {
    try {
      listWorkflows(world, o);
      process.exitCode = 0;
    } finally {
      await world.close();
    }
    return;
  }
  if (!name) {
    await world.close();
    const known = Object.keys((world.config.config.workflows ?? {}) as Workflows);
    throw new ConfigError("SW_CONFIG_WORKFLOW", "Missing workflow name", {
      hint: known.length
        ? `Run one of: ${known.join(", ")} (\`sw run --list\`)`
        : "No workflows in the config: add `workflows.<name>.steps`",
    });
  }
  const removeSignals = installSignals(world, g, { reports: g.dryRun !== true });
  try {
    const { order, steps } = await planOf(world, name);
    if (g.dryRun) {
      const planned: Array<Record<string, unknown>> = [];
      for (const id of order) {
        const st = steps[id] as WorkflowStep;
        if (st.optional && !world.registry.has(st.engine)) {
          planned.push({
            step: id,
            engine: st.engine,
            optional: true,
            note: "engine not available: will fail (optional)",
          });
          continue;
        }
        try {
          planned.push({ step: id, after: st.after ?? [], ...(await dryRunStep(world, st)) });
        } catch (e) {
          if (!st.optional || !isSecondWorldError(e)) throw e;
          planned.push({
            step: id,
            engine: st.engine,
            optional: true,
            note: `invalid (optional): ${e.message}`,
          });
        }
      }
      const payload = { dryRun: true, workflow: name, order, steps: planned };
      if (o.json) out(JSON.stringify(world.redactor.redactObject(payload), null, 2));
      else {
        out(`${s.ok} workflow "${name}" valid: ${order.length} step(s), order ${order.join(" → ")}`);
        for (const p of planned) {
          const target = typeof p.target === "string" ? `, ${s.ok} safety check passed for ${p.target}` : "";
          const note = typeof p.note === "string" ? ` ${s.warn} ${p.note}` : "";
          out(`  ${s.ok} ${String(p.step)} (${String(p.engine)}): input valid${target}${note}`);
        }
        out(s.dim("dry run: nothing was sent"));
      }
      process.exitCode = 0;
      return;
    }

    attachProgress(world, g, { json: o.json === true });
    if (!g.quiet && !o.json) {
      world.on("run.started", (p) => err(s.dim(`step: ${(p as { engine?: string }).engine ?? "?"} started`)));
      world.on("run.completed", (p) => {
        const t = p as { engine?: string; status?: string; durationMs?: number };
        err(s.dim(`step: ${t.engine ?? "?"} ${t.status ?? ""} ${((t.durationMs ?? 0) / 1000).toFixed(1)}s`));
      });
    }
    const wf = await world.run(name);
    const results: EngineResult[] = [];
    for (const id of wf.order) {
      const oc = wf.steps[id];
      if (oc && "result" in oc && oc.result) results.push(oc.result);
    }
    if (!g.quiet && !o.json) {
      err(
        `workflow "${name}": ${wf.ok ? "all required steps completed" : "a required step failed or was skipped"}`,
      );
      for (const id of wf.order) err(outcomeLine(s, id, steps[id] as WorkflowStep, wf.steps[id]));
    }
    // The first required step that threw (no result) decides the exit code, unless the run was cancelled.
    let thrown: number | undefined;
    for (const id of wf.order) {
      const oc = wf.steps[id];
      const st = steps[id] as WorkflowStep;
      if (st.optional || !oc || oc.status !== "failed" || oc.result) continue;
      thrown = errorExitCode(oc.error);
      if (thrown === ExitCode.Internal && !g.quiet) {
        err(
          `${s.fail} step "${id}" failed with an internal error: this is a bug in SECOND WORLD; please report it`,
        );
        if (oc.error instanceof Error && oc.error.stack) err(s.dim(oc.error.stack));
      }
      break;
    }
    const cancelled = world.signal.aborted || results.some((r) => r.status === "cancelled");
    if (results.length > 0) {
      await finishRun(world, results, g, {
        json: o.json === true,
        history: cancelled ? false : o.history,
        label: name,
      });
    } else if (o.json) {
      out(JSON.stringify({ workflow: name, ok: wf.ok, order: wf.order, results: [] }, null, 2));
    }
    if (cancelled) process.exitCode = ExitCode.Cancelled;
    else if (thrown !== undefined && process.exitCode !== ExitCode.ConfigInvalid) process.exitCode = thrown;
    else if (results.length === 0) process.exitCode = wf.ok ? ExitCode.Ok : ExitCode.Failures;
  } finally {
    removeSignals();
    await world.close();
  }
}
