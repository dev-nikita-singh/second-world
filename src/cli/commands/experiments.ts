/**
 * `sw whatif <experiment|file>` and `sw evolve`. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/experiments.md (Part A What-If, Part B Evolution); wiring per CONTRACTS.md
 * "sw-experiments". Commands from flags are split WITHOUT a shell (sw-experiments' splitCommand).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadObjectFile } from "../../core/config/loader.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";
import { int } from "./perf.js";

type Obj = Record<string, unknown>;

/** Applies `sw whatif` flags to an experiment definition (returns a new object). */
export function applyWhatIfFlags(def: Obj, o: Obj, seed?: number): Obj {
  const out: Obj = { ...def };
  const design: Obj = { ...((def.design as Obj | undefined) ?? {}) };
  const reps = int("repetitions", o.repetitions);
  if (reps !== undefined) design.repetitions = reps;
  if (o.order !== undefined) design.order = o.order;
  if (o.lifecycle !== undefined) design.lifecycle = o.lifecycle;
  if (seed !== undefined) design.seed = seed;
  if (Object.keys(design).length) out.design = design;
  if (o.aa === true) out.mode = "aa";
  const metrics = o.metric as string[] | undefined;
  if (metrics?.length) out.metrics = metrics.flatMap((m) => m.split(",")).map((m) => m.trim()).filter(Boolean);
  return out;
}

/**
 * Absolute paths where SECOND WORLD itself writes during a run, for evolution's working-tree checksum:
 * `<config dir>/.second-world`, report.outDir, history.dir, the architecture/model caches and the
 * config's evolution.ignorePaths (all relative to the config dir).
 * Paths outside the repository are ignored by the engine. docs/03-engines/experiments.md §B.3.
 */
export function ownStatePaths(cfg: { cwd: string; config: { report: { outDir: string }; history: { dir: string } } & Obj }): string[] {
  const paths = [resolve(cfg.cwd, ".second-world"), resolve(cfg.cwd, cfg.config.report.outDir), resolve(cfg.cwd, cfg.config.history.dir)];
  for (const sec of ["architecture", "model"]) {
    const c = (cfg.config[sec] as Obj | undefined)?.cacheDir;
    if (typeof c === "string") paths.push(resolve(cfg.cwd, c));
  }
  // The call input replaces (not merges) config arrays: keep evolution.ignorePaths from the config too.
  const extra = (cfg.config.evolution as Obj | undefined)?.ignorePaths;
  if (Array.isArray(extra)) for (const p of extra) if (typeof p === "string") paths.push(resolve(cfg.cwd, p));
  return [...new Set(paths)];
}

/** Maps `sw evolve` flags to a loose Evolution input. `split` = sw-experiments' splitCommand. */
/** `cwd`: directory the command was run from (flag paths are relative to it). */
export function evolveInputFromFlags(o: Obj, split: (cmd: string) => string[], cwd = process.cwd()): Obj {
  const input: Obj = {};
  const cands = ((o.candidates as string[] | undefined) ?? []).flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
  if (cands.length) {
    for (const c of cands) {
      if (!/^(branch|commit|patch):.+/.test(c)) {
        throw new ConfigError("SW_CONFIG_FLAG", `Invalid candidate "${c}"`, { hint: "Use branch:<name>, commit:<sha> or patch:<file.diff>" });
      }
    }
    input.candidates = cands;
  }
  for (const k of ["test", "start", "build"] as const) if (typeof o[k] === "string") input[k] = split(o[k] as string);
  if (o.health !== undefined) input.health = o.health;
  if (typeof o.repo === "string") input.repo = resolve(cwd, o.repo);
  if (o.baseline !== undefined) input.baseline = o.baseline;
  if (o.finding !== undefined) input.finding = o.finding;
  const reps = int("repetitions", o.repetitions);
  if (reps !== undefined) input.design = { repetitions: reps };
  if (o.sandbox !== undefined) input.sandbox = { kind: o.sandbox };
  const replays = o.replay as string[] | undefined;
  if (replays?.length) input.replays = { artifacts: replays.map((r) => resolve(cwd, r)) };
  const metrics = o.metric as string[] | undefined;
  if (metrics?.length) input.metrics = metrics;
  return input;
}

export async function whatifCommand(target: string, o: Obj, g: GlobalOptions): Promise<void> {
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const named = world.config.config.whatif?.experiments ?? {};
    let def: Obj;
    if (named[target]) def = { name: target, ...(named[target] as Obj) };
    else {
      const file = resolve(world.config.invocationCwd ?? world.config.cwd, target);
      if (!existsSync(file)) {
        throw new ConfigError("SW_CONFIG_WHATIF", `No experiment "${target}" in whatif.experiments and no such file`, {
          hint: `Defined experiments: ${Object.keys(named).join(", ") || "(none)"}; or pass a .ts/.js/.json/.yaml file exporting experiment({...})`,
        });
      }
      def = await loadObjectFile(file, { noConfigCode: g.configCode === false });
    }
    const input = applyWhatIfFlags(def, o, g.seed !== undefined ? Number(g.seed) : undefined);
    if (g.dryRun) {
      const { parseExperimentInput } = await import("../../engines/experiments/index.js");
      out(JSON.stringify(world.redactor.redactObject({ dryRun: true, input: parseExperimentInput(world.buildInput("whatif", input)) }), null, 2));
      process.exitCode = 0;
      return;
    }
    attachProgress(world, g, { json: o.json === true });
    const s = style(colorEnabled(g));
    if (!g.quiet && !o.json) {
      world.on("whatif.run.end", (p) => {
        const r = p as { index?: number; total?: number; arm?: string; rep?: number; status?: string };
        err(s.dim(`run ${(r.index ?? 0) + 1}/${r.total ?? "?"} ${r.arm ?? ""} rep ${r.rep ?? ""}: ${r.status ?? ""}`));
      });
    }
    const result = (await world.whatif.run(input)) as EngineResult;
    await finishRun(world, result, g, { json: o.json === true, history: o.history as boolean | undefined, label: "whatif" });
  } finally {
    removeSignals();
    await world.close();
  }
}

export async function evolveCommand(o: Obj, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const exp = await import("../../engines/experiments/index.js");
    const input = evolveInputFromFlags(o, exp.splitCommand, world.config.invocationCwd ?? world.config.cwd);
    // SECOND WORLD's own files (audit log, reports, history, caches) are not a change of the user's tree.
    input.ignorePaths = [...ownStatePaths(world.config), ...((input.ignorePaths as string[] | undefined) ?? [])];
    if (g.seed !== undefined) input.design = { ...((input.design as Obj | undefined) ?? {}), seed: Number(g.seed) };
    if (g.dryRun) {
      out(JSON.stringify(world.redactor.redactObject({ dryRun: true, input: exp.parseEvolutionInput(world.buildInput("evolution", input)) }), null, 2));
      process.exitCode = 0;
      return;
    }
    attachProgress(world, g, { json: o.json === true });
    if (!g.quiet && !o.json) {
      world.on("evolution.gate", (p) => {
        const e = p as { arm?: string; gate?: string; name?: string; ok?: boolean };
        err(s.dim(`${e.arm ?? "?"} ${e.gate ?? ""}${e.name && e.name !== e.gate ? ` (${e.name})` : ""}: ${e.ok ? "ok" : "FAILED"}`));
      });
    }
    const result = (await world.evolution.run(input)) as EngineResult;
    await finishRun(world, result, g, { json: o.json === true, history: o.history as boolean | undefined, label: "evolve" });
    const noSandbox = result.limitations.find((l) => l.code === "EVOLUTION-NO-SANDBOX");
    if (result.status === "skipped" && noSandbox) {
      err(`${s.fail} ${noSandbox.message}`);
      err(`  ${s.dim("hint:")} start Docker, or use --sandbox process --yes (runs candidate code on this machine without isolation)`);
      process.exitCode = 4;
    }
  } finally {
    removeSignals();
    await world.close();
  }
}
