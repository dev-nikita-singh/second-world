/**
 * Evolution engine. docs/03-engines/experiments.md Part B.
 *
 * candidates (branch:/commit:/patch:) ─► git worktree per candidate (detached, temp dir) ─► install (cached)
 * ─► build ─► test (user command) ─► invariants ─► start app + regression replays ─► benchmark interleaved
 * with the baseline via the What-If engine ─► stop ─► rank (Pareto over success metrics; tie-break by
 * weighted score, then diff size) ─► report. Never pushes, merges, commits or edits the user's working
 * tree (verified with a checksum of HEAD + status + diffs before/after). Worktrees are removed on
 * success, error and abort.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { CapabilityError, EngineError } from "../../core/errors.js";
import type { EngineResult, Finding, Limitation } from "../../core/evidence/schemas.js";
import { createEvidenceStore, createFinding } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import { orientedChange, parseMetric } from "./analysis.js";
import { type RunningApp, startApp } from "./app.js";
import { type CommandResult, type CommandSpec, describeFailure, formatArgv } from "./command.js";
import { diffShortStat, gitOk, repoRoot, resolveCommit, type ShortStat, workingTreeChecksum } from "./git.js";
import { type InstallAction, materialize, planInstall } from "./install.js";
import { rankPareto } from "./pareto.js";
import {
  createDockerSandbox,
  createProcessSandbox,
  defaultDockerUser,
  dockerReachable,
  SANDBOX_LABELS,
  type Sandbox,
} from "./sandbox.js";
import { type EvolutionInput, parseExperimentInput } from "./schema.js";
import type { CandidateKind, CandidateResult, EvolutionData, ExperimentData, GateResult } from "./types.js";
import { executeExperiment, type WorkloadRunner } from "./whatif.js";
import { type Worktree, WorktreeManager } from "./worktree.js";

export const EVOLUTION_ENGINE_VERSION = "0.1.0";

export type ReplayRunner = (args: {
  bugs: Record<string, unknown>;
  artifactPath: string;
  url: string;
  runs: number;
  ctx: Partial<EngineContext>;
}) => Promise<{ fingerprint: string; reproduced: boolean }>;

export interface EvolutionDeps {
  /** Replace the sandbox (tests). */
  sandbox?: Sandbox;
  /** Replace the Docker reachability probe (tests). */
  dockerCheck?: () => Promise<{ ok: boolean; reason?: string }>;
  /** Replace the regression replay runner (default: Bug Hunter replayFinding). */
  replay?: ReplayRunner;
  /** Replace the workload executor of the embedded experiment (tests). */
  runWorkload?: WorkloadRunner;
}

interface Arm {
  name: string;
  ref: string;
  kind: CandidateKind | "baseline";
  value: string;
  wt?: Worktree;
  commit?: string;
  diff: ShortStat;
  gates: GateResult[];
  rejected: string[];
  mounts: { host: string; container: string }[];
  error?: string;
}

const EMPTY_DIFF: ShortStat = { files: 0, insertions: 0, deletions: 0, lines: 0, stat: "" };

const defaultReplay: ReplayRunner = async ({ bugs, artifactPath, url, runs, ctx }) => {
  const { replayFinding } = await import("../bugs/index.js");
  const r = await replayFinding({ ...bugs, target: url } as never, { artifactPath }, ctx, { runs });
  return { fingerprint: r.fingerprint, reproduced: r.failures > 0 };
};

function parseCandidate(ref: string): { kind: CandidateKind; value: string; name: string } {
  const i = ref.indexOf(":");
  const kind = ref.slice(0, i) as CandidateKind;
  const value = ref.slice(i + 1);
  const name =
    kind === "patch"
      ? path.basename(value).replace(/\.(diff|patch)$/i, "")
      : kind === "commit"
        ? value.slice(0, 12)
        : value;
  return { kind, value, name };
}

export async function executeEvolution(
  input: EvolutionInput,
  ctx: EngineContext,
  deps: EvolutionDeps = {},
): Promise<EngineResult<EvolutionData>> {
  const runId = ctx.newId();
  const startedAt = ctx.clock.isoNow();
  const log = ctx.log.child({ engine: "evolution" });
  const limitations: Limitation[] = [];
  const warnings: string[] = [];
  const repo = await repoRoot(path.resolve(input.repo ?? process.cwd()));
  const before = await workingTreeChecksum(repo);
  const baseCommit = await resolveCommit(repo, input.baseline);
  const isCancelled = () => ctx.signal.aborted || ctx.safety.killSwitch.aborted;

  // ---- sandbox
  let sandbox: Sandbox | undefined = deps.sandbox;
  const image = input.sandbox.image ?? `node:${process.versions.node.split(".")[0]}-slim`;
  if (!sandbox) {
    const kind = input.sandbox.kind;
    if (kind === "process") {
      await ctx.safety.requireApproval(
        "evolution-execution",
        `run build/test/start of ${input.candidates.length} candidate(s) from ${repo} on the host (process sandbox)`,
      );
      sandbox = createProcessSandbox();
    } else {
      const reach = await (deps.dockerCheck ?? dockerReachable)();
      if (reach.ok) {
        sandbox = createDockerSandbox({
          image,
          cpus: input.sandbox.cpus,
          memory: input.sandbox.memory,
          network: input.sandbox.network,
          user: defaultDockerUser(input.sandbox.user),
          namePrefix: "sw-evolve",
          labels: { [SANDBOX_LABELS.sandbox]: "evolution", "io.second-world.run": runId },
        });
      } else if (kind === "docker") {
        throw new CapabilityError(
          "SW_CAP_DOCKER",
          `Docker sandbox requested but Docker is not reachable: ${reach.reason ?? "unknown"}`,
          {
            hint: 'Start Docker, or opt in to the host process sandbox with sandbox.kind "process" (requires approval)',
          },
        );
      } else {
        const data = emptyData(input, repo, baseCommit, before, { kind: "process" });
        limitations.push({
          code: "EVOLUTION-NO-SANDBOX",
          message: `Docker is not reachable (${reach.reason ?? "unknown"}); candidates were not executed. Opt in to the host process sandbox with sandbox.kind "process" (requires approval).`,
          impact: "invalidates",
        });
        return {
          schemaVersion: 1,
          engine: "evolution",
          runId,
          status: "skipped",
          startedAt,
          endedAt: ctx.clock.isoNow(),
          findings: [],
          limitations,
          artifacts: [],
          data,
        };
      }
    }
  }
  if (sandbox.kind === "docker") {
    limitations.push({
      code: "EVOLUTION-START-NETWORK",
      message:
        "While benchmarking, app containers run on the default bridge network (port publishing); egress is restricted only for build/test/invariants",
      impact: "informational",
    });
  }
  ctx.safety.audit({
    action: "evolution.start",
    detail: { repo, baseline: baseCommit, candidates: input.candidates, sandbox: sandbox.label },
  });

  if (sandbox.prepare) {
    try {
      await sandbox.prepare(ctx.signal);
    } catch (e) {
      throw new CapabilityError(
        "SW_CAP_DOCKER",
        `Docker sandbox could not be prepared: ${(e as Error).message}`,
        {
          hint: `Pull the image manually (docker pull ${image}) or set sandbox.image`,
        },
      );
    }
  }
  // Docker runs Linux: check out with LF line endings regardless of core.autocrlf (CRLF breaks sh scripts).
  const mgr = new WorktreeManager(repo, input.tmpDir, { lf: sandbox.kind === "docker" });
  const installCache = new Map<string, string>();
  const installStats = { reused: 0, installed: 0, lockfileHash: undefined as string | undefined };
  const env = { CI: "1", ...input.env };
  const baseline: Arm = {
    name: "baseline",
    ref: input.baseline,
    kind: "baseline",
    value: input.baseline,
    commit: baseCommit,
    diff: EMPTY_DIFF,
    gates: [],
    rejected: [],
    mounts: [],
  };
  const arms: Arm[] = input.candidates.map((ref) => {
    const c = parseCandidate(ref);
    return {
      name: c.name,
      ref,
      kind: c.kind,
      value: c.value,
      diff: EMPTY_DIFF,
      gates: [],
      rejected: [],
      mounts: [],
    };
  });
  // Unique arm names (two patches with the same basename …).
  const seen = new Set(["baseline"]);
  for (const a of arms) {
    let n = a.name;
    for (let i = 2; seen.has(n); i++) n = `${a.name}-${i}`;
    a.name = n;
    seen.add(n);
  }

  const gate = async (
    arm: Arm,
    g: GateResult["gate"],
    name: string,
    fn: () => Promise<{ ok: boolean; detail?: string; skipped?: boolean }>,
  ): Promise<boolean> => {
    const t0 = ctx.clock.now();
    let r: { ok: boolean; detail?: string; skipped?: boolean };
    try {
      r = await fn();
    } catch (e) {
      r = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    arm.gates.push({
      gate: g,
      name,
      ok: r.ok,
      durationMs: ctx.clock.now() - t0,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.skipped ? { skipped: true } : {}),
    });
    if (!r.ok) arm.rejected.push(`${name}: ${r.detail ?? "failed"}`);
    ctx.events.emit("evolution.gate", { runId, arm: arm.name, gate: g, name, ok: r.ok });
    return r.ok;
  };
  const cmdGate =
    (
      arm: Arm,
      phase: "build" | "test" | "invariant",
      cmd: CommandSpec,
      extraEnv: Record<string, string> = {},
    ) =>
    async () => {
      const res: CommandResult = await (sandbox as Sandbox).run(cmd, {
        cwd: (arm.wt as Worktree).dir,
        env: { ...env, ...extraEnv },
        timeoutMs: input.gateTimeout,
        signal: ctx.signal,
        phase,
        mounts: arm.mounts,
      });
      ctx.safety.audit({
        action: "evolution.command",
        detail: { arm: arm.name, phase, argv: formatArgv(res.argv), exitCode: res.exitCode },
      });
      return res.ok ? { ok: true } : { ok: false, detail: describeFailure(res) };
    };

  const prepare = async (arm: Arm, full: boolean): Promise<boolean> => {
    // worktree
    const okWt = await gate(arm, "worktree", "worktree", async () => {
      if (arm.kind === "baseline") {
        arm.wt = await mgr.add("baseline", baseCommit);
      } else if (arm.kind === "patch") {
        arm.wt = await mgr.add(arm.name, baseCommit);
        arm.commit = baseCommit;
        const file = path.resolve(arm.value);
        await gitOk(arm.wt.dir, ["apply", "--index", "--whitespace=nowarn", file]).catch((e: Error) => {
          throw new Error(`patch does not apply: ${e.message}`);
        });
        arm.diff = await diffShortStat(arm.wt.dir);
      } else {
        const commit =
          arm.kind === "branch"
            ? await resolveCommit(repo, `refs/heads/${arm.value}`).catch(() => resolveCommit(repo, arm.value))
            : await resolveCommit(repo, arm.value);
        arm.commit = commit;
        arm.wt = await mgr.add(arm.name, commit);
        arm.diff = await diffShortStat(repo, `${baseCommit}...${commit}`);
      }
      return { ok: true, detail: arm.diff.stat || undefined };
    });
    if (!okWt || isCancelled()) return false;
    // install
    const wt = arm.wt as Worktree;
    const okInstall = await gate(arm, "install", "install", async () => {
      const action: InstallAction = await planInstall({
        worktree: wt.dir,
        strategy: input.install.strategy,
        command: input.install.command,
        sandbox: (sandbox as Sandbox).kind,
        repo,
        cache: installCache,
      });
      if (action.kind === "skip") return { ok: true, skipped: true, detail: action.reason };
      installStats.lockfileHash ??= action.key?.split(":")[1];
      if (action.kind !== "install") {
        if (action.kind === "mount") {
          arm.mounts.push({ host: action.source, container: "/work/node_modules" });
          installStats.reused++;
          return { ok: true, detail: `mounted ${action.source} (lockfile ${action.key})` };
        }
        const dest = await materialize(action.kind, action.source, wt.dir);
        if (action.kind === "link") mgr.registerLink(dest);
        installStats.reused++;
        return { ok: true, detail: `${action.kind} ${action.source} (lockfile ${action.key})` };
      }
      const res = await (sandbox as Sandbox).run(action.command, {
        cwd: wt.dir,
        env,
        timeoutMs: input.install.timeout,
        signal: ctx.signal,
        phase: "install",
      });
      ctx.safety.audit({
        action: "evolution.command",
        detail: { arm: arm.name, phase: "install", argv: formatArgv(res.argv), exitCode: res.exitCode },
      });
      if (!res.ok) return { ok: false, detail: describeFailure(res) };
      installStats.installed++;
      // Only cache a node_modules that exists (npm ci with zero dependencies creates none): a mount of a
      // missing host directory fails on Docker Desktop and a dangling junction breaks resolution.
      const installed = path.join(wt.dir, "node_modules");
      if (action.key && (await isDirectory(installed))) installCache.set(action.key, installed);
      return { ok: true, detail: `installed (${formatArgv(res.argv).slice(0, 80)})` };
    });
    if (!okInstall || isCancelled()) return false;
    if (input.build !== undefined && !(await gate(arm, "build", "build", cmdGate(arm, "build", input.build))))
      return false;
    if (!full || isCancelled()) return true;
    if (input.test !== undefined && !(await gate(arm, "test", "test", cmdGate(arm, "test", input.test))))
      return false;
    for (const inv of input.invariants) {
      if (isCancelled()) return false;
      if (!(await gate(arm, "invariant", `invariant ${inv.name}`, cmdGate(arm, "invariant", inv.command))))
        return false;
    }
    return true;
  };

  const readyWhen = input.readyWhen ?? { path: input.health, timeout: 30_000, interval: 200 };
  // Docker sandbox convention (docs/03-engines/experiments.md §B.3): published ports reach 0.0.0.0 only.
  const healthHint =
    (sandbox as Sandbox).kind === "docker"
      ? "docker sandbox: the app must listen on $HOST (set to 0.0.0.0 in the container), not 127.0.0.1 — e.g. server.listen(port, process.env.HOST ?? \"127.0.0.1\")"
      : undefined;
  const startArm = (arm: Arm): Promise<RunningApp> =>
    startApp({
      command: input.start,
      cwd: (arm.wt as Worktree).dir,
      env,
      portEnv: input.portEnv,
      readyWhen: {
        path: readyWhen.path,
        status: readyWhen.status,
        bodyContains: readyWhen.bodyContains,
        timeoutMs: readyWhen.timeout,
        intervalMs: readyWhen.interval,
      },
      signal: ctx.signal,
      clock: ctx.clock,
      wrap: (sandbox as Sandbox).wrapStart((arm.wt as Worktree).dir, arm.mounts),
      ...(healthHint ? { healthHint } : {}),
    });

  let experiment: ExperimentData | undefined;
  let experimentLimitations: Limitation[] = [];
  let worktreesCleaned = false;
  let after = before;
  let baselineError: string | undefined;
  let cancelled = false;
  try {
    // ---- baseline + candidates: correctness gates
    if (!(await prepare(baseline, false))) {
      baselineError = `baseline could not be prepared: ${baseline.rejected.join("; ")}`;
      throw new EngineError("SW_ENGINE_EVOLUTION_BASELINE", baselineError);
    }
    for (const arm of arms) {
      if (isCancelled()) break;
      await prepare(arm, true);
    }

    // ---- start + regression replays (baseline first to know pre-existing reproductions)
    const replay = input.replays && input.replays.artifacts.length > 0 ? input.replays : undefined;
    const replayRunner = deps.replay ?? defaultReplay;
    const pending = arms.filter((a) => a.rejected.length === 0);
    if (replay && !isCancelled()) {
      const runReplays = async (arm: Arm): Promise<Map<string, boolean>> => {
        const out = new Map<string, boolean>();
        const app = await startArm(arm);
        try {
          for (const artifactPath of replay.artifacts) {
            const r = await replayRunner({
              bugs: replay.bugs,
              artifactPath: path.resolve(artifactPath),
              url: app.url,
              runs: replay.runs,
              ctx: {
                signal: ctx.signal,
                clock: ctx.clock,
                log,
                events: ctx.events,
                evidence: createEvidenceStore(),
                safety: ctx.safety,
                env: ctx.env,
                config: ctx.config,
                newId: ctx.newId,
                rng: ctx.rng.fork(`replay-${arm.name}`),
              },
            });
            out.set(artifactPath, r.reproduced);
          }
        } finally {
          await app.stop();
        }
        return out;
      };
      let baseRepro = new Map<string, boolean>();
      try {
        baseRepro = await runReplays(baseline);
      } catch (e) {
        warnings.push(`baseline replays failed: ${(e as Error).message}`);
      }
      for (const arm of pending) {
        if (isCancelled()) break;
        await gate(arm, "replay", "regression replays", async () => {
          const res = await runReplays(arm);
          const regressions = [...res.entries()]
            .filter(([p, r]) => r && !baseRepro.get(p))
            .map(([p]) => path.basename(p));
          const fixed = [...res.entries()]
            .filter(([p, r]) => !r && baseRepro.get(p))
            .map(([p]) => path.basename(p));
          if (regressions.length > 0) return { ok: false, detail: `reintroduces ${regressions.join(", ")}` };
          return {
            ok: true,
            detail: `${res.size} replay(s) clean${fixed.length ? `; fixes ${fixed.join(", ")}` : ""}`,
          };
        });
      }
    }

    // ---- benchmark: baseline vs accepted candidates, interleaved (What-If engine)
    const accepted = arms.filter((a) => a.rejected.length === 0);
    if (accepted.length > 0 && !isCancelled()) {
      const expInput = parseExperimentInput({
        name: `evolution:${path.basename(repo)}@${baseCommit.slice(0, 8)}`,
        hypothesis: input.finding ? `candidates improve on finding ${input.finding}` : undefined,
        baseline: {
          name: "baseline",
          start: input.start,
          cwd: (baseline.wt as Worktree).dir,
          env,
          portEnv: input.portEnv,
          readyWhen,
        },
        variants: accepted.map((a) => ({ name: a.name, cwd: (a.wt as Worktree).dir })),
        workload: input.workload,
        metrics: input.metrics,
        success: input.success,
        design: input.design,
        alpha: input.alpha,
        bootstrap: input.bootstrap,
        commandTimeout: input.gateTimeout,
      });
      const armByName = new Map([baseline, ...accepted].map((a) => [a.name, a]));
      const res = await executeExperiment(expInput, ctx, {
        engineId: "evolution",
        sandboxLabel: sandbox.label,
        ...(deps.runWorkload ? { runWorkload: deps.runWorkload } : {}),
        wrap: (name) => {
          const a = armByName.get(name);
          return a?.wt ? (sandbox as Sandbox).wrapStart(a.wt.dir, a.mounts) : undefined;
        },
        ...(healthHint ? { healthHint } : {}),
      });
      experiment = res.data;
      experimentLimitations = res.limitations;
      if (res.status === "cancelled") cancelled = true;
      for (const a of accepted) {
        const runs = experiment?.runs.filter((r) => r.arm === a.name) ?? [];
        const ok = runs.filter((r) => r.status === "ok").length;
        const okGate = runs.length > 0 && ok > 0;
        a.gates.push({
          gate: "benchmark",
          name: "benchmark",
          ok: okGate,
          durationMs: runs.reduce((s, r) => s + r.durationMs, 0),
          detail: `${ok}/${runs.length} runs ok${runs.find((r) => r.error) ? ` (${runs.find((r) => r.error)?.error})` : ""}`,
        });
        if (!okGate && !cancelled)
          a.rejected.push(`start/benchmark: ${runs.find((r) => r.error)?.error ?? "no successful run"}`);
      }
      if (
        (experiment?.runs.filter((r) => r.arm === "baseline" && r.status === "ok").length ?? 0) === 0 &&
        !cancelled
      ) {
        baselineError = `baseline app could not be benchmarked: ${experiment?.runs.find((r) => r.arm === "baseline" && r.error)?.error ?? "no successful run"}`;
      }
    }
  } catch (e) {
    if (!baselineError && !isCancelled()) throw e;
  } finally {
    // Containers whose `docker run` client was killed before `--rm`/`rm -f` could act (cancel, timeout).
    const leaked = await sandbox.cleanup?.().catch(() => 0);
    if (leaked) warnings.push(`removed ${leaked} leftover sandbox container(s)`);
    if (!input.keepWorktrees) worktreesCleaned = await mgr.cleanupAll();
    else warnings.push(`worktrees kept: ${mgr.active.map((w) => w.dir).join(", ")}`);
    after = await workingTreeChecksum(repo).catch(() => "unavailable");
  }
  if (isCancelled()) cancelled = true;

  // ---- ranking
  const rankMetrics = (
    input.rankBy ?? (Object.keys(input.success).length > 0 ? Object.keys(input.success) : input.metrics)
  ).flatMap((m) => {
    const def = parseMetric(m);
    return def ? [def] : [];
  });
  const hasWeights = Object.keys(input.weights).length > 0;
  const rankBy = rankMetrics.map((m) => ({
    metric: m.name,
    direction: m.direction,
    weight: hasWeights ? (input.weights[m.name] ?? 0) : 1,
  }));
  const results: CandidateResult[] = arms.map((a) => {
    const comps = experiment?.comparisons.filter((c) => c.variant === a.name) ?? [];
    const improvement: Record<string, number> = {};
    const verdicts: Record<string, string> = {};
    for (const c of comps) {
      verdicts[c.metric] = c.verdict;
      // Significance-filtered: changes that are not significant count as 0 (equal to the baseline).
      improvement[c.metric] =
        c.verdict === "improved" || c.verdict === "regressed"
          ? orientedChange(c.relativeChange, c.direction)
          : 0;
    }
    const arm = experiment?.arms.find((x) => x.name === a.name);
    const status: CandidateResult["status"] =
      a.rejected.length > 0 ? "rejected" : experiment ? "accepted" : "error";
    return {
      ref: a.ref,
      name: a.name,
      kind: a.kind as CandidateKind,
      commit: a.commit,
      diff: {
        files: a.diff.files,
        insertions: a.diff.insertions,
        deletions: a.diff.deletions,
        lines: a.diff.lines,
        stat: a.diff.stat,
      },
      gates: a.gates,
      status,
      rejectionReasons: a.rejected,
      improvement,
      medians: arm?.medians ?? {},
      verdicts,
      pareto: false,
      dominatedBy: [],
    };
  });
  const acceptedResults = results.filter((r) => r.status === "accepted");
  const items = [
    { name: "baseline", values: rankBy.map(() => 0), score: 0, diffSize: 0 },
    ...acceptedResults.map((r) => {
      const values = rankBy.map((m) => r.improvement[m.metric] ?? Number.NaN);
      const score = rankBy.reduce(
        (s, m, i) => s + m.weight * (Number.isFinite(values[i]) ? (values[i] as number) : 0),
        0,
      );
      r.score = score;
      // Raw observed change (inconclusive comparisons included): only orders otherwise-tied candidates.
      const comps = experiment?.comparisons.filter((c) => c.variant === r.name) ?? [];
      const observed = rankBy.reduce((s, m) => {
        const c = comps.find((x) => x.metric === m.metric);
        const v = c ? orientedChange(c.relativeChange, c.direction) : Number.NaN;
        return s + m.weight * (Number.isFinite(v) ? v : 0);
      }, 0);
      return { name: r.name, values, score, diffSize: r.diff.lines, observed };
    }),
  ];
  const ranked = rankPareto(items);
  let rank = 0;
  const paretoFront: string[] = [];
  for (const it of ranked) {
    if (it.name === "baseline") continue;
    const r = acceptedResults.find((x) => x.name === it.name) as CandidateResult;
    r.rank = ++rank;
    r.dominatedBy = it.dominatedBy;
    r.pareto = it.layer === 1 && !it.dominatedBy.includes("baseline");
    if (r.pareto) paretoFront.push(r.name);
  }

  const unchanged = before === after;
  if (!unchanged) {
    limitations.push({
      code: "EVOLUTION-WORKING-TREE-CHANGED",
      message:
        "The repository working tree checksum changed during the run (another process may have modified it)",
      impact: "invalidates",
    });
  }
  if (!worktreesCleaned && !input.keepWorktrees) {
    limitations.push({
      code: "EVOLUTION-WORKTREE-CLEANUP",
      message: "Some worktrees could not be removed; run `git worktree prune`",
      impact: "informational",
    });
  }
  limitations.push(...experimentLimitations.filter((l) => !limitations.some((x) => x.code === l.code)));

  const data: EvolutionData = {
    schema: 1,
    repo,
    baseline: { ref: input.baseline, commit: baseCommit },
    finding: input.finding,
    sandbox:
      sandbox.kind === "docker"
        ? {
            kind: "docker",
            image,
            cpus: input.sandbox.cpus,
            memory: input.sandbox.memory,
            network: input.sandbox.network,
          }
        : { kind: "process" },
    install: {
      strategy: input.install.strategy,
      lockfileHash: installStats.lockfileHash,
      reused: installStats.reused,
      installed: installStats.installed,
    },
    candidates: results.sort((x, y) => (x.rank ?? 1e9) - (y.rank ?? 1e9)),
    rankBy,
    paretoFront,
    rejected: results
      .filter((r) => r.status === "rejected")
      .map((r) => ({ name: r.name, reasons: r.rejectionReasons })),
    experiment,
    workingTree: { before, after, unchanged },
    worktreesCleaned,
    warnings,
    methods: {
      isolation:
        "git worktree add --detach per arm in a temp dir from the baseline commit; removed with git worktree remove --force (+ prune) on success, error and abort",
      gates:
        "worktree/patch apply → install → build → test → invariants → regression replays (only new reproductions vs the baseline reject) → start/benchmark",
      benchmark:
        "What-If engine: baseline vs accepted candidates, interleaved, per-run app processes, Holm across metrics × candidates",
      ranking:
        "Pareto dominance over significance-filtered oriented improvements vs the baseline (non-significant changes count as 0; candidates dominated by the baseline are not on the front); ties by weighted score, then diff size (git diff --shortstat lines)",
      install: `strategy ${input.install.strategy}: lockfile-hash cache, node_modules reused via junction/symlink (process) or read-only mount (docker)`,
    },
  };

  const findings: Finding[] = [];
  const fctx = { newId: ctx.newId, clock: ctx.clock };
  for (const name of paretoFront) {
    const r = results.find((x) => x.name === name) as CandidateResult;
    const best = Object.entries(r.improvement).filter(([, v]) => v > 0);
    if (best.length === 0) continue;
    findings.push(
      createFinding(
        {
          engine: "evolution",
          ruleId: "EVOLUTION-PARETO-CANDIDATE",
          category: "performance",
          title: `Candidate ${r.ref} is on the Pareto front (${best.map(([m, v]) => `${m} ${(v * 100).toFixed(1)}% better`).join(", ")})`,
          description: `Benchmarked against ${baseCommit.slice(0, 12)} in isolation; passed ${r.gates
            .filter((g) => g.ok)
            .map((g) => g.name)
            .join(", ")}. Diff: ${r.diff.stat || "n/a"}. Review and merge manually.`,
          severity: "info",
          classification: "observation",
          confidence: 0.8,
          evidence: (experiment?.comparisons ?? [])
            .filter((c) => c.variant === r.name)
            .map((c) => ({
              kind: "comparison" as const,
              metric: c.metric,
              change: c.relativeChange,
              ci95: [c.ci.lower, c.ci.upper] as [number, number],
              pValue: c.pAdjusted,
            })),
          affected: [r.ref],
          ...(input.finding ? { related: [{ id: input.finding, relation: "related" as const }] } : {}),
          tags: ["evolution"],
        },
        fctx,
      ),
    );
  }
  for (const f of findings) ctx.evidence.addFinding(f);

  let status: EngineResult["status"];
  if (cancelled) status = "cancelled";
  else if (baselineError || !unchanged) status = "error";
  else if (paretoFront.length === 0) status = "failed";
  else status = "passed";
  if (baselineError)
    limitations.push({ code: "EVOLUTION-BASELINE-FAILED", message: baselineError, impact: "invalidates" });
  log.info("evolution done", { status, front: paretoFront, rejected: data.rejected.length });

  return {
    schemaVersion: 1,
    engine: "evolution",
    runId,
    status,
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings,
    limitations,
    artifacts: [],
    data,
  };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function emptyData(
  input: EvolutionInput,
  repo: string,
  commit: string,
  checksum: string,
  sandbox: EvolutionData["sandbox"],
): EvolutionData {
  return {
    schema: 1,
    repo,
    baseline: { ref: input.baseline, commit },
    finding: input.finding,
    sandbox,
    install: { strategy: input.install.strategy, reused: 0, installed: 0 },
    candidates: [],
    rankBy: [],
    paretoFront: [],
    rejected: [],
    workingTree: { before: checksum, after: checksum, unchanged: true },
    worktreesCleaned: true,
    warnings: [],
    methods: {},
  };
}
