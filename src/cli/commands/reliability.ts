/**
 * `sw reliability list|run|cleanup` — Reliability Lab. See docs/09-cli-and-api.md §1,
 * docs/03-engines/reliability-lab.md and docs/11 §1 (leftover faults). Fault injection is a
 * disruptive action: it needs --approve-disruptive / --yes (or an interactive confirmation).
 * Ctrl+C aborts the world signal first, so the engine reverts its faults before exiting.
 */

import { coerceValue } from "../../core/config/loader.js";
import { parsePercent } from "../../core/config/units.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";
import { int } from "./perf.js";

/** `--param k=v` (repeatable) → { k: coerced v }. */
export function parseParams(params: string[] | undefined): Record<string, unknown> | undefined {
  if (!params?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq <= 0)
      throw new ConfigError("SW_CONFIG_FLAG", `Invalid --param "${p}"`, {
        hint: "Use --param latencyMs=500",
      });
    out[p.slice(0, eq).trim()] = coerceValue(p.slice(eq + 1));
  }
  return out;
}

/** `--route name=METHOD /path` (repeatable) → workload routes. */
export function parseRoutes(routes: string[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!routes?.length) return undefined;
  return routes.map((r) => {
    const m = /^([^=]+)=\s*([A-Za-z]+)\s+(\S+)$/.exec(r.trim());
    if (!m)
      throw new ConfigError("SW_CONFIG_FLAG", `Invalid --route "${r}"`, {
        hint: 'Use --route orders="POST /orders"',
      });
    return { name: (m[1] as string).trim(), method: (m[2] as string).toUpperCase(), path: m[3] as string };
  });
}

/** Maps `sw reliability run` flags to a loose reliability input. */
export function reliabilityInputFromFlags(
  scenario: string,
  o: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { scenario };
  if (o.target) input.target = o.target;
  if (o.dependency) input.dependency = o.dependency;
  if (o.duration !== undefined) input.duration = o.duration;
  if (o.steadyPhase !== undefined) input.steady = o.steadyPhase;
  if (o.recovery !== undefined) input.recovery = o.recovery;
  const steady = o.steady as string[] | undefined;
  if (steady?.length) input.steadyState = steady;
  const hyp = o.hypothesis as string[] | undefined;
  if (hyp?.length) input.hypothesis = hyp;
  const params = parseParams(o.param as string[] | undefined);
  if (params) input.params = params;
  const workload: Record<string, unknown> = {};
  if (o.rate !== undefined) {
    const n = Number(o.rate);
    if (!(n > 0))
      throw new ConfigError("SW_CONFIG_FLAG", `--rate must be a positive number, got "${String(o.rate)}"`);
    workload.rate = n;
  }
  const routes = parseRoutes(o.route as string[] | undefined);
  if (routes) workload.routes = routes;
  if (Object.keys(workload).length) input.workload = workload;
  const repeat = int("repeat", o.repeat);
  if (repeat !== undefined) input.repeat = repeat;
  if (o.abortErrorRate !== undefined)
    input.abort = { errorRate: parsePercent(String(o.abortErrorRate), "--abort-error-rate") };
  if (o.allowProduction === true) input.allowProduction = true;
  return input;
}

export async function reliabilityList(o: { json?: boolean }, _g: GlobalOptions): Promise<void> {
  const { listScenarios } = await import("../../engines/reliability/index.js");
  const list = listScenarios();
  if (o.json) out(JSON.stringify(list, null, 2));
  else {
    for (const s of list) {
      out(`${s.id.padEnd(22)} ${s.title}`);
      out(
        `${"".padEnd(22)} injectors: ${s.injectors.join(", ")}; params: ${Object.keys(s.params ?? {}).join(", ") || "-"}`,
      );
    }
  }
  process.exitCode = 0;
}

export async function reliabilityRun(
  scenario: string,
  o: Record<string, unknown>,
  g: GlobalOptions,
): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const flags = reliabilityInputFromFlags(scenario, o);
    const plan = world.buildInput("reliability", flags);
    if (typeof plan.target !== "string") {
      throw new ConfigError("SW_CONFIG_NO_TARGET", "No reliability target given", {
        hint: "Pass --target http://127.0.0.1:3000 or set targets in sw.config",
      });
    }
    await world.safety.preflight(plan.target);
    if (g.dryRun) {
      const { checkReliabilityInput, parseReliabilityInput } = await import(
        "../../engines/reliability/index.js"
      );
      const parsed = parseReliabilityInput(plan);
      checkReliabilityInput(parsed);
      // The CLI never passes injectors, so the real run needs a declared dependency.
      if (!parsed.dependencies[parsed.dependency]) {
        throw new ConfigError("SW_CONFIG_RELIABILITY", `Unknown dependency "${parsed.dependency}"`, {
          hint: "Declare it under reliability.dependencies.<name> (injector + upstream/listen, toxiproxy or container)",
        });
      }
      if (o.json)
        out(
          JSON.stringify(
            world.redactor.redactObject({ dryRun: true, target: plan.target, input: parsed }),
            null,
            2,
          ),
        );
      else {
        out(`${s.ok} config valid, ${s.ok} safety check passed for ${plan.target}`);
        out(JSON.stringify(world.redactor.redactObject(parsed), null, 2));
        out(s.dim("dry run: no fault injected, nothing sent"));
      }
      process.exitCode = 0;
      return;
    }
    attachProgress(world, g, { json: o.json === true });
    if (!g.quiet && !o.json) {
      world.on("reliability.fault", (p) => {
        const f = p as { run?: number; phase?: string };
        err(s.dim(`fault ${f.phase ?? "?"}${f.run !== undefined ? ` (run ${f.run})` : ""}`));
      });
    }
    const result = (await world.reliability.run(flags)) as EngineResult;
    await finishRun(world, result, g, {
      json: o.json === true,
      history: o.history as boolean | undefined,
      label: "reliability",
    });
  } finally {
    removeSignals();
    await world.close();
  }
}

export async function reliabilityCleanup(
  o: { json?: boolean; ledger?: string },
  g: GlobalOptions,
): Promise<void> {
  const s = style(colorEnabled(g));
  const { cleanupAll } = await import("../../engines/reliability/index.js");
  const r = await cleanupAll(o.ledger ? { ledgerPath: o.ledger } : {});
  if (o.json) out(JSON.stringify(r, null, 2));
  else {
    const errors = (r.errors ?? []) as unknown[];
    out(
      `${errors.length ? s.fail : s.ok} cleanup: ${JSON.stringify(r.inProcess)} in-process, ${JSON.stringify(r.ledger)} from ledger, ${errors.length} error(s)`,
    );
    for (const e of errors) out(`  ${s.fail} ${typeof e === "string" ? e : JSON.stringify(e)}`);
  }
  process.exitCode = ((r.errors ?? []) as unknown[]).length > 0 ? 1 : 0;
}
