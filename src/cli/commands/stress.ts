/**
 * `sw stress` — Stress & Capacity Lab. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/stress-capacity-lab.md. Flag mapping per CONTRACTS.md "sw-stress".
 * Breakpoint mode reports status "passed" even with a breach (by design of the engine).
 */
import { parseRate } from "../../core/config/units.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import { buildStressInput } from "../../core/world.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, out, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";
import { parseSeed } from "./config.js";
import { perfInputFromFlags } from "./perf.js";

function rate(flag: string, v: unknown): number {
  try {
    return parseRate(String(v), `--${flag}`);
  } catch {
    throw new ConfigError("SW_CONFIG_FLAG", `--${flag} must be a rate like 200 or 200/s, got "${String(v)}"`);
  }
}

/** Maps `sw stress` flags to a loose stress input. */
export function stressInputFromFlags(
  target: string | undefined,
  o: Record<string, unknown>,
): Record<string, unknown> {
  const input = perfInputFromFlags(target, o);
  delete input.model; // stress decides the load model per stage
  if (o.mode) input.mode = o.mode;
  if (o.steps !== undefined) {
    const parts = String(o.steps)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const nums = parts.map(Number);
    if (parts.length === 0 || nums.some((n) => !(n > 0) || !Number.isFinite(n))) {
      throw new ConfigError(
        "SW_CONFIG_FLAG",
        `--steps must be a comma-separated list of positive numbers, got "${String(o.steps)}"`,
      );
    }
    input.stages = nums;
  }
  if (o.hold !== undefined) input.hold = o.hold;
  if (o.settle !== undefined) input.settle = o.settle;

  const bp = o.rateFrom !== undefined || o.rateTo !== undefined || o.step !== undefined;
  if (bp) {
    if (o.rateFrom === undefined || o.rateTo === undefined || o.step === undefined) {
      throw new ConfigError("SW_CONFIG_FLAG", "breakpoint search needs --rate-from, --rate-to and --step");
    }
    const b: Record<string, number> = {
      from: rate("rate-from", o.rateFrom),
      to: rate("rate-to", o.rateTo),
      step: rate("step", o.step),
    };
    if (o.minStep !== undefined) b.minStep = rate("min-step", o.minStep);
    input.breakpoint = b;
    input.loadType = "rate";
    input.mode ??= "breakpoint";
  }
  if (input.mode === "soak" && input.rate !== undefined) {
    const soak: Record<string, unknown> = { level: input.rate };
    if (input.duration !== undefined) soak.duration = input.duration;
    input.soak = soak;
    input.loadType = "rate";
    delete input.rate;
    delete input.duration;
  }
  return input;
}

export async function stressCommand(
  target: string | undefined,
  o: Record<string, unknown>,
  g: GlobalOptions,
): Promise<void> {
  const s = style(colorEnabled(g));
  const seed = parseSeed(g);
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const flags = stressInputFromFlags(target, o);
    const plan = buildStressInput(world.config, flags, seed !== undefined ? { seed } : {});
    if (typeof plan.target !== "string") {
      throw new ConfigError("SW_CONFIG_NO_TARGET", "No stress target given", {
        hint: "Pass a URL (`sw stress http://127.0.0.1:3000/api --steps 10,25,50`), --target, or set targets in sw.config",
      });
    }
    await world.safety.preflight(plan.target);
    if (g.dryRun) {
      const { checkPerformancePlan, parsePerformanceInput } = await import(
        "../../engines/performance/index.js"
      );
      const { parseStressInput, stagePerfInput } = await import("../../engines/stress/index.js");
      const parsed = parseStressInput(plan);
      // Same extract/template/step checks the first stage's Performance Lab run would do.
      checkPerformancePlan(
        parsePerformanceInput(stagePerfInput(parsed.base, parsed.loadType, 1, 1000, 0, 0)),
      );
      if (o.json)
        out(
          JSON.stringify(
            world.redactor.redactObject({
              dryRun: true,
              target: plan.target,
              safety: "allowed",
              input: parsed,
            }),
            null,
            2,
          ),
        );
      else {
        out(`${s.ok} config valid, ${s.ok} safety check passed for ${plan.target}`);
        out(JSON.stringify(world.redactor.redactObject(parsed), null, 2));
        out(s.dim("dry run: nothing was sent"));
      }
      process.exitCode = 0;
      return;
    }
    attachProgress(world, g, { json: o.json === true });
    const result = (await world.stress.run(flags)) as EngineResult;
    await finishRun(world, result, g, {
      json: o.json === true,
      history: o.history as boolean | undefined,
      label: "stress",
    });
  } finally {
    removeSignals();
    await world.close();
  }
}
