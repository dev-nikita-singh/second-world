/**
 * API Bug Hunter public entry. docs/03-engines/api-bug-hunter.md §6 (usage), §3 (replay).
 */
import { readFile } from "node:fs/promises";
import { zodIssueLines } from "../../core/config/loader.js";
import { type CreateEngineContextOptions, createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult, Finding } from "../../core/evidence/schemas.js";
import type { Engine, EngineContext } from "../../core/types.js";
import { hydrateForReplay } from "./artifact.js";
import type { BugCase } from "./cases.js";
import { type BugsDeps, ENGINE_VERSION, executeBugs, replayCase } from "./engine.js";
import { type BugsInput, type BugsInputLoose, BugsInputSchema } from "./schema.js";
import { openSession } from "./session.js";
import type { BugsData, ReproductionArtifact } from "./types.js";

export { ddmin } from "./algorithms/ddmin.js";
export { ipog } from "./algorithms/ipog.js";
export {
  checkLinearizable,
  counterModel,
  registerModel,
  setModel,
  stockModel,
} from "./algorithms/linearizability.js";
export { embedContext, hydrateForReplay } from "./artifact.js";
export type { BugCase, CaseStep, Check } from "./cases.js";
export { classifyReplays } from "./classify.js";
export { loadContract } from "./contract.js";
export { type LoadedInvariant, loadInvariant } from "./invariants.js";
export type {
  Assertion,
  BugsInput,
  BugsInputLoose,
  ConcurrencyTest,
  Credential,
  Hook,
  ResourceSpec,
  Technique,
} from "./schema.js";
export { BugsInputSchema, TECHNIQUES } from "./schema.js";
export type * from "./types.js";

export const bugsEngine: Engine<BugsInput, BugsData> = {
  id: "bugs",
  version: ENGINE_VERSION,
  inputSchema: BugsInputSchema,
  requires: [{ cap: "network.target" }],
  run: (input, ctx) => executeBugs(input, ctx),
};

export function parseBugsInput(input: BugsInputLoose | unknown): BugsInput {
  const r = BugsInputSchema.safeParse(input);
  if (!r.success) {
    const issues = zodIssueLines(r.error, { prefix: ["bugs"], schema: BugsInputSchema });
    throw new ConfigError(
      "SW_CONFIG_BUGS",
      `Invalid bugs input: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      {
        hint: "See docs/03-engines/api-bug-hunter.md for the input fields",
        details: { issues },
      },
    );
  }
  return r.data;
}

/** Runs the Bug Hunter standalone. Missing context members get test-friendly defaults. */
export async function runBugHunt(
  input: BugsInputLoose,
  ctx?: CreateEngineContextOptions,
): Promise<EngineResult<BugsData>> {
  const parsed = parseBugsInput(input);
  return executeBugs(parsed, createEngineContext(ctx ?? {}));
}

export type { BugsDeps };
/** Engine run with extra contributions (plugin assertions, docs/10 §2); used by the world. */
export function runBugsWith(
  input: BugsInput,
  ctx: EngineContext,
  deps: BugsDeps,
): Promise<EngineResult<BugsData>> {
  return executeBugs(input, ctx, deps);
}

export interface ReplayResult {
  fingerprint: string;
  ruleId: string;
  operation: string;
  /**
   * "inconclusive": the replay could not evaluate the check (unresolvable invariant module,
   * missing role/contract, every run inconclusive). Never treat it as "fixed".
   */
  classification: "reproduced-defect" | "observation" | "inconclusive";
  /** Why the replay is inconclusive. */
  reason?: string;
  flaky: boolean;
  failures: number;
  runs: number;
  inconclusive: number;
  rate: number;
  wilson: { lower: number; upper: number };
  /** Redacted exchanges of the last replay. */
  lastExchanges: { method: string; url: string; status: number; error?: string }[];
}

export type ReplaySource =
  | ReproductionArtifact
  | { artifactPath: string }
  | { finding: Finding; data: BugsData }
  | { fingerprint: string; data: BugsData };

async function resolveArtifact(src: ReplaySource): Promise<ReproductionArtifact> {
  if ("artifactPath" in src) {
    const raw = JSON.parse(await readFile(src.artifactPath, "utf8")) as ReproductionArtifact;
    if (!raw.case || !raw.fingerprint)
      throw new ConfigError(
        "SW_CONFIG_BUGS_REPLAY",
        `${src.artifactPath} is not a Bug Hunter reproduction artifact`,
      );
    return raw;
  }
  if ("case" in src && "fingerprint" in src && !("data" in src)) return src;
  const fp = "finding" in src ? src.finding.fingerprint : (src as { fingerprint: string }).fingerprint;
  const a = (src as { data: BugsData }).data.reproductions[fp];
  if (!a) throw new ConfigError("SW_CONFIG_BUGS_REPLAY", `No reproduction recorded for ${fp}`);
  return a;
}

/**
 * Replays a recorded failing case (`sw replay`): same target/contract/roles from `input`, reset
 * hook before every run, `runs` replays (default input.replays), Wilson classification.
 */
export async function replayFinding(
  input: BugsInputLoose,
  source: ReplaySource,
  ctx?: CreateEngineContextOptions,
  opts: { runs?: number; maxReplays?: number } = {},
): Promise<ReplayResult> {
  const parsed = parseBugsInput(input);
  const full = createEngineContext(ctx ?? {});
  const art = await resolveArtifact(source);
  const s = await openSession(parsed, full, { forReplay: true });
  try {
    const hyd = await hydrateForReplay(art.case as BugCase, s);
    if (!hyd.ok) {
      full.safety.audit({
        action: "bugs.replay",
        target: parsed.target,
        detail: { fingerprint: art.fingerprint, inconclusive: hyd.reason },
      });
      return {
        fingerprint: art.fingerprint,
        ruleId: art.ruleId,
        operation: art.operation,
        classification: "inconclusive",
        reason: hyd.reason,
        flaky: false,
        failures: 0,
        runs: 0,
        inconclusive: 0,
        rate: 0,
        wilson: { lower: 0, upper: 1 },
        lastExchanges: [],
      };
    }
    await s.hooks.run("setup");
    const runs = opts.runs ?? parsed.replays;
    const stats = await replayCase(s, hyd.case, art.fingerprint, {
      replays: runs,
      maxReplays: opts.maxReplays ?? Math.max(runs, parsed.maxReplays),
    });
    full.safety.audit({
      action: "bugs.replay",
      target: parsed.target,
      detail: { fingerprint: art.fingerprint, failures: stats.failures, runs: stats.runs },
    });
    return {
      fingerprint: art.fingerprint,
      ruleId: art.ruleId,
      operation: art.operation,
      classification: stats.runs === 0 ? "inconclusive" : stats.classification,
      ...(stats.runs === 0 ? { reason: stats.lastRun?.reason ?? "no conclusive replay run" } : {}),
      flaky: stats.flaky,
      failures: stats.failures,
      runs: stats.runs,
      inconclusive: stats.inconclusive,
      rate: stats.rate,
      wilson: stats.wilson,
      lastExchanges: (stats.lastRun?.exchanges ?? []).map((e) => ({
        method: e.method,
        url: e.url,
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
      })),
    };
  } finally {
    await s.close();
  }
}
