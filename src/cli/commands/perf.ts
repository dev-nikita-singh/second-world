/**
 * `sw perf` — Performance Lab from the CLI. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/performance-lab.md. Ctrl+C once = graceful stop + partial report;
 * twice = hard exit 130 (SIGINT, SIGTERM, SIGBREAK on Windows).
 */
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import { buildPerformanceInput } from "../../core/world.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, out, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";
import { parseSeed } from "./config.js";

export function int(name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new ConfigError("SW_CONFIG_FLAG", `--${name} must be a positive integer, got "${String(v)}"`);
  return n;
}

/** Maps perf flags to a (loose) performance input. */
export function perfInputFromFlags(
  target: string | undefined,
  o: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const t = (o.target as string | undefined) ?? target;
  if (t) input.target = t;
  if (o.model) input.model = o.model;
  if (o.rate !== undefined) input.rate = /^\d+(\.\d+)?$/.test(String(o.rate)) ? Number(o.rate) : o.rate;
  const vus = int("vus", o.vus);
  if (vus !== undefined) input.vus = vus;
  const it = int("iterations", o.iterations);
  if (it !== undefined) input.iterations = it;
  const mif = int("max-in-flight", o.maxInFlight);
  if (mif !== undefined) input.maxInFlight = mif;
  if (o.workers !== undefined) input.workers = o.workers === "auto" ? "auto" : int("workers", o.workers);
  for (const [flag, key] of [
    ["duration", "duration"],
    ["rampUp", "rampUp"],
    ["warmup", "warmup"],
    ["timeout", "timeout"],
  ] as const) {
    if (o[flag] !== undefined) input[key] = o[flag];
  }
  if (o.arrival) input.arrival = o.arrival;
  const th = o.threshold as string[] | undefined;
  if (th?.length) input.thresholds = { http: th };
  return input;
}

export async function perfCommand(
  target: string | undefined,
  o: Record<string, unknown>,
  g: GlobalOptions,
): Promise<void> {
  const s = style(colorEnabled(g));
  const seed = parseSeed(g);
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const flags = perfInputFromFlags(target, o);
    const plan = buildPerformanceInput(world.config, flags, seed !== undefined ? { seed } : {});
    if (typeof plan.target !== "string") {
      throw new ConfigError("SW_CONFIG_NO_TARGET", "No performance target given", {
        hint: "Pass a URL (`sw perf http://127.0.0.1:3000/api`), --target, or set performance.target / targets in sw.config",
      });
    }
    // Safety pre-flight (may prompt interactively; throws SafetyError → exit 3).
    await world.safety.preflight(plan.target);

    if (g.dryRun) {
      const { parsePerformanceInput } = await import("../../engines/performance/index.js");
      const parsed = parsePerformanceInput(plan);
      const payload = {
        dryRun: true,
        target: plan.target,
        safety: "allowed",
        input: parsed,
        environment: { cpus: world.env.resources.cpus },
      };
      if (o.json) out(JSON.stringify(world.redactor.redactObject(payload), null, 2));
      else {
        out(`${s.ok} config valid, ${s.ok} safety check passed for ${plan.target}`);
        out(JSON.stringify(world.redactor.redactObject(parsed), null, 2));
        out(s.dim("dry run: nothing was sent"));
      }
      process.exitCode = 0;
      return;
    }
    attachProgress(world, g, { json: o.json === true });
    const result = (await world.performance.run(flags)) as EngineResult;
    await finishRun(world, result, g, {
      json: o.json === true,
      history: o.history as boolean | undefined,
      label: "perf",
    });
  } finally {
    removeSignals();
    await world.close();
  }
}
