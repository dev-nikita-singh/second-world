/**
 * API Bug Hunter run loop. docs/03-engines/api-bug-hunter.md.
 *
 * 1. Session (safety, mutation gate, budget lease, contract, roles, hooks, invariants).
 * 2. setup hook; per technique: reset hook, generate cases per operation, run, record matrix.
 * 3. Failures are deduplicated by fingerprint (rule + operation + pointer + keyword) with counts.
 * 4. Reproducibility protocol per unique failure: reset → replay n times (→ maxReplays when
 *    flaky) → Wilson classification; ddmin over multi-step sequences; redacted artifact + curl.
 * 5. Findings: reproduced-defect (n/n or flaky k/n) or observation. Discovery mode (no contract)
 *    only emits observations plus a draft contract.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { EngineResult, Evidence, Finding, Limitation } from "../../core/evidence/schemas.js";
import { createFinding } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import { ddmin } from "./algorithms/ddmin.js";
import { embedContext } from "./artifact.js";
import { type BugCase, type CaseRun, type EvalEnv, type Failure, runCase } from "./cases.js";
import { classifyReplays, type ReplayClassification } from "./classify.js";
import { matchesPattern, type Operation } from "./contract.js";
import {
  authCases,
  boundaryCases,
  concurrencyCases,
  contractCases,
  deriveResources,
  equivalenceCases,
  negativeCases,
  pairwiseCases,
  statefulCases,
} from "./generate.js";
import { toHar } from "./har.js";
import { BudgetExhausted, type Exchange } from "./http.js";
import { inferSchema, mergeInferred } from "./json-schema.js";
import { runModelTechnique, runPropertyTechnique } from "./property.js";
import { RULES } from "./rules.js";
import type { BugsInput, Technique } from "./schema.js";
import { openSession, type Session } from "./session.js";
import type {
  BugFindingSummary,
  BugsData,
  OperationRow,
  ReproductionArtifact,
  TechniqueCell,
} from "./types.js";

export const ENGINE_VERSION = "0.1.0";

const TECHNIQUE_ORDER: Technique[] = [
  "contract",
  "boundary",
  "equivalence",
  "pairwise",
  "negative",
  "property",
  "stateful",
  "auth",
  "concurrency",
];

interface Entry {
  failure: Failure;
  case: BugCase;
  run: CaseRun;
  occurrences: number;
  /** Property technique: keep overwriting with later (more shrunk) cases. */
  replaceable: boolean;
}

function methodRank(m: string): number {
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? 0 : m === "DELETE" ? 2 : 1;
}

function selectOperations(s: Session): Operation[] {
  const ops = s.contract?.operations ?? [];
  const { include, exclude } = s.input.operations;
  return ops
    .filter(
      (o) =>
        (include.length === 0 || include.some((p) => matchesPattern(o, p))) &&
        !exclude.some((p) => matchesPattern(o, p)),
    )
    .sort((a, b) => methodRank(a.method) - methodRank(b.method));
}

function artifactExchanges(run: CaseRun): ReproductionArtifact["exchanges"] {
  return run.exchanges.slice(0, 64).map((e: Exchange, i) => {
    const x: ReproductionArtifact["exchanges"][number] = {
      step: i,
      method: e.method,
      url: e.url,
      status: e.status,
      requestHeaders: e.requestHeaders,
      responseHeaders: e.responseHeaders,
      durationMs: Math.round(e.durationMs * 100) / 100,
    };
    if (e.requestBody !== undefined) x.requestBody = e.requestBody;
    if (e.responseBody !== undefined) x.responseBody = e.responseBody;
    if (e.error !== undefined) x.error = e.error;
    return x;
  });
}

export interface ReplayStats extends ReplayClassification {
  inconclusive: number;
  lastRun?: CaseRun;
  failingRun?: CaseRun;
}

/** Reproducibility protocol §3.4: reset → replay; extend to maxReplays when flaky. */
export async function replayCase(
  s: Session,
  c: BugCase,
  fp: string,
  opts: { replays: number; maxReplays: number },
): Promise<ReplayStats> {
  let failures = 0;
  let runs = 0;
  let inconclusive = 0;
  let lastRun: CaseRun | undefined;
  let failingRun: CaseRun | undefined;
  let target = opts.replays;
  let attempts = 0;
  while (runs < target && attempts < target * 2 + 2) {
    attempts++;
    if (s.ctx.signal.aborted) break;
    await s.hooks.run("reset");
    const run = await runCase(c, s.env);
    lastRun = run;
    if (run.inconclusive) {
      inconclusive++;
      continue;
    }
    runs++;
    if (run.failures.some((f) => f.fingerprint === fp)) {
      failures++;
      failingRun ??= run;
    }
    if (runs === target && failures > 0 && failures < runs && target < opts.maxReplays)
      target = opts.maxReplays;
  }
  const cls = classifyReplays({ failures, runs });
  const out: ReplayStats = { ...cls, inconclusive };
  if (lastRun) out.lastRun = lastRun;
  if (failingRun) out.failingRun = failingRun;
  return out;
}

export async function executeBugs(input: BugsInput, ctx: EngineContext): Promise<EngineResult<BugsData>> {
  const startedAt = ctx.clock.isoNow();
  const t0 = ctx.clock.now();
  const runId = ctx.newId();
  const s = await openSession(input, ctx);
  const limitations: Limitation[] = [...s.limitations];
  const matrix = new Map<string, OperationRow>();
  const entries = new Map<string, Entry>();
  const techniqueCounts: Partial<Record<Technique | "discovery", number>> = {};
  let budgetHit = false;
  let replaysRun = 0;
  const ops = selectOperations(s);
  for (const o of ops) {
    matrix.set(o.key, {
      operation: o.key,
      verdict: "untested",
      techniques: {},
      statuses: {},
      documentedStatuses: o.responses.map((r) => r.status),
      findings: [],
    });
  }
  const cell = (op: string, t: Technique | "discovery"): TechniqueCell => {
    let row = matrix.get(op);
    if (!row) {
      row = {
        operation: op,
        verdict: "untested",
        techniques: {},
        statuses: {},
        documentedStatuses: [],
        findings: [],
      };
      matrix.set(op, row);
    }
    let c = row.techniques[t];
    if (!c) {
      c = { cases: 0, passed: 0, failed: 0, inconclusive: 0 };
      row.techniques[t] = c;
    }
    return c;
  };
  const record = (c: BugCase, run: CaseRun, replaceable = false): void => {
    techniqueCounts[c.technique] = (techniqueCounts[c.technique] ?? 0) + 1;
    const cl = cell(c.operation, c.technique);
    cl.cases++;
    for (const ex of run.exchanges) {
      if (ex.blocked || ex.error) continue;
      const row = matrix.get(ex.operation);
      if (row) row.statuses[String(ex.status)] = (row.statuses[String(ex.status)] ?? 0) + 1;
    }
    if (run.inconclusive) {
      cl.inconclusive++;
      return;
    }
    const real = run.failures.filter((f) => !f.observation);
    if (real.length > 0) cl.failed++;
    else cl.passed++;
    for (const f of run.failures) addFailure(c, run, f, replaceable);
  };
  const addFailure = (c: BugCase, run: CaseRun, f: Failure, replaceable: boolean): void => {
    const e = entries.get(f.fingerprint);
    if (!e) {
      entries.set(f.fingerprint, { failure: f, case: c, run, occurrences: 1, replaceable });
      return;
    }
    e.occurrences++;
    if (e.replaceable && replaceable) {
      e.case = c;
      e.run = run;
      e.failure = f;
    }
  };

  let draftContract: Record<string, unknown> | undefined;
  let techStart: { t: string; at: number; sent: number } | undefined;
  const emitTechnique = (): void => {
    if (!techStart) return;
    ctx.events.emit("bugs.technique", {
      runId,
      technique: techStart.t,
      ms: Math.round(ctx.clock.now() - techStart.at),
      requests: s.http.stats.sent - techStart.sent,
      findings: entries.size,
    });
    techStart = undefined;
  };
  try {
    await s.hooks.run("setup");
    if (!s.contract) {
      draftContract = await discovery(s, record);
      limitations.push({
        code: "BUGS_DISCOVERY_MODE",
        message:
          "No contract: discovery mode records a draft contract and reports observations only (bugs need an explicit expectation)",
        impact: "informational",
      });
    } else {
      const g = s.gen;
      if (!g) throw new Error("generator context missing");
      const resources = deriveResources(s.contract, input.stateful.resources);
      const enabled = new Set(input.techniques);
      for (const t of TECHNIQUE_ORDER) {
        if (!enabled.has(t)) continue;
        if (ctx.signal.aborted) break;
        if (techStart !== undefined) emitTechnique();
        techStart = { t, at: ctx.clock.now(), sent: s.http.stats.sent };
        await s.hooks.run("reset");
        const cap = input.maxCasesPerOperation;
        if (t === "property") {
          for (const [i, op] of ops.entries()) {
            const sink = (c: BugCase, run: CaseRun, f: Failure): void => addFailure(c, run, f, true);
            const r = await runPropertyTechnique(g, op, s.env, {
              numRuns: input.propertyRuns,
              seed: s.seed + i,
              timeLimitMs: 6_000,
              sink,
            });
            const cl = cell(op.key, "property");
            cl.cases += r.cases;
            techniqueCounts.property = (techniqueCounts.property ?? 0) + r.cases;
            if (r.failed) cl.failed++;
            else cl.passed += r.cases;
          }
          continue;
        }
        if (t === "stateful") {
          for (const c of statefulCases(g, resources).filter((c) => ops.some((o) => o.key === c.operation)))
            record(c, await runCase(c, s.env));
          for (const [i, r] of resources.entries()) {
            if (!r.delete && !r.update && !input.stateful.resources) continue;
            const res = await runModelTechnique(g, r, s.env, {
              runs: input.stateful.runs,
              maxCommands: input.stateful.maxCommands,
              seed: s.seed + 1000 + i,
              reset: () => s.hooks.run("reset"),
              timeLimitMs: 8_000,
            });
            const cl = cell(r.read.key, "stateful");
            cl.cases += res.executions;
            techniqueCounts.stateful = (techniqueCounts.stateful ?? 0) + res.executions;
            if (res.case) {
              await s.hooks.run("reset");
              const run = await runCase(res.case, s.env);
              record(res.case, run);
            } else cl.passed += res.executions;
          }
          continue;
        }
        let cases: BugCase[] = [];
        if (t === "auth") cases = authCases(g, ops, resources);
        else if (t === "concurrency") cases = concurrencyCases(g, input.concurrency);
        else {
          const gen = {
            contract: contractCases,
            boundary: boundaryCases,
            equivalence: equivalenceCases,
            pairwise: pairwiseCases,
            negative: negativeCases,
          }[t];
          for (const op of ops) cases.push(...gen(g, op).slice(0, cap));
        }
        for (const c of cases) {
          if (ctx.signal.aborted) break;
          record(c, await runCase(c, s.env));
        }
      }
    }

    if (techStart !== undefined) emitTechnique();
    techStart = { t: "replay", at: ctx.clock.now(), sent: s.http.stats.sent };
    // ---------------------------------------------------------------- reproduction protocol
    for (const e of entries.values()) {
      if (ctx.signal.aborted) break;
      if (e.failure.observation || !s.contract) continue;
      const stats = await replayCase(s, e.case, e.failure.fingerprint, {
        replays: input.replays,
        maxReplays: input.maxReplays,
      });
      replaysRun += stats.runs + stats.inconclusive;
      (e as Entry & { stats?: ReplayStats }).stats = stats;
      // Minimise multi-step sequences with ddmin (each test = reset + replay).
      if (
        input.minimize &&
        stats.classification === "reproduced-defect" &&
        !stats.flaky &&
        e.case.steps.length > 2 &&
        (e.case.check.kind === "conformance" || e.case.check.kind === "model")
      ) {
        const fp = e.failure.fingerprint;
        const original = e.case.steps;
        const failingRuns = new Map<string, CaseRun>();
        const dd = await ddmin(
          original,
          async (steps) => {
            await s.hooks.run("reset");
            const run = await runCase({ ...e.case, steps }, s.env);
            replaysRun++;
            const failed = !run.inconclusive && run.failures.some((f) => f.fingerprint === fp);
            if (failed) failingRuns.set(steps.map((st) => original.indexOf(st)).join(","), run);
            return failed;
          },
          { maxTests: 40 },
        );
        if (dd.result.length < e.case.steps.length) {
          // Reproduction values (ids, exchanges) must come from a run of the minimised sequence.
          const minRun = failingRuns.get(dd.indices.join(","));
          if (minRun) (e as Entry & { stats?: ReplayStats }).stats = { ...stats, failingRun: minRun };
          e.case = {
            ...e.case,
            steps: dd.result,
            label: `${e.case.label} (minimised ${e.case.steps.length}→${dd.result.length} steps)`,
          };
          (e as Entry & { minimized?: boolean }).minimized = true;
        }
      }
    }
    emitTechnique();
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) {
      await s.close();
      throw err;
    }
    budgetHit = true;
    limitations.push({
      code: "BUGS_BUDGET_EXHAUSTED",
      message: `Request budget exhausted (${input.budget.maxRequests} requests) or run cancelled; results are partial`,
      impact: "reduces-confidence",
    });
  }

  // ---------------------------------------------------------------- findings
  const findings: Finding[] = [];
  const summaries: BugFindingSummary[] = [];
  const reproductions: Record<string, ReproductionArtifact> = {};
  const artifacts: EngineResult["artifacts"] = [];
  const artifactsDir = input.artifactsDir
    ? isAbsolute(input.artifactsDir)
      ? input.artifactsDir
      : resolve(s.cwd, input.artifactsDir)
    : undefined;
  for (const e of entries.values()) {
    const f = e.failure;
    const info = RULES[f.ruleId];
    const stats = (e as Entry & { stats?: ReplayStats }).stats;
    const minimized = (e as Entry & { minimized?: boolean }).minimized === true;
    let cls: ReplayClassification;
    if (!s.contract || f.observation) cls = classifyReplays({ failures: 0, runs: 0 });
    else cls = stats ?? classifyReplays({ failures: 0, runs: 0 });
    const reproduced = cls.classification === "reproduced-defect";
    const failingRun = stats?.failingRun ?? e.run;
    const curl = s.http.curlSteps(e.case.steps, failingRun.requests);
    const artifact: ReproductionArtifact = {
      fingerprint: f.fingerprint,
      ruleId: f.ruleId,
      operation: f.operation,
      seed: e.case.seed,
      case: embedContext(e.case, s),
      exchanges: artifactExchanges(failingRun),
      curl,
      message: f.message,
    };
    reproductions[f.fingerprint] = artifact;
    const artifactPaths: string[] = [];
    if (artifactsDir) {
      await mkdir(artifactsDir, { recursive: true });
      const p = join(artifactsDir, `bugs-${f.fingerprint}.json`);
      await writeFile(p, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      artifactPaths.push(p);
      artifacts.push({ name: `bugs-${f.fingerprint}`, path: p, mediaType: "application/json" });
      // HAR 1.2 of the failing run: <artifactsDir>/bugs-<fp>/reproduction.har (credentials → $SW_AUTH_<ROLE>).
      const harDir = join(artifactsDir, `bugs-${f.fingerprint}`);
      await mkdir(harDir, { recursive: true });
      const harPath = join(harDir, "reproduction.har");
      const har = toHar(failingRun.exchanges, {
        roles: input.auth.roles,
        startedIso: ctx.clock.isoNow(),
        redactor: s.http.redactor,
        comment: `${f.ruleId} ${f.operation}: ${f.message}`.slice(0, 2000),
      });
      await writeFile(
        harPath,
        `${JSON.stringify(har, null, 2)}
`,
        "utf8",
      );
      artifactPaths.push(harPath);
      artifacts.push({ name: `bugs-${f.fingerprint}.har`, path: harPath, mediaType: "application/json" });
    }
    const failEx = failingRun.stepExchanges[f.step] ?? failingRun.exchanges[failingRun.exchanges.length - 1];
    const evidence: Evidence[] = [];
    if (failEx) {
      evidence.push({
        kind: "http-exchange",
        requestHash: f.fingerprint,
        method: failEx.method,
        url: failEx.url,
        status: failEx.status,
        ...(artifactPaths[0] ? { artifact: artifactPaths[0] } : {}),
      });
    }
    evidence.push({ kind: "note", text: f.message });
    if (stats && stats.runs > 0) {
      evidence.push({
        kind: "measurement",
        metric: "replay.failure_rate",
        value: cls.rate,
        unit: "ratio",
        runId,
      });
    }
    const severity = reproduced ? info.severity : f.observation ? "info" : "low";
    const title =
      `${info.title}: ${f.operation}${f.pointer && !f.pointer.startsWith("auth:") ? ` (${f.pointer})` : ""}`.slice(
        0,
        200,
      );
    const steps = e.case.steps.map(
      (st, i) => `${i + 1}. ${st.request.method} ${st.request.path}${st.label ? ` — ${st.label}` : ""}`,
    );
    if (s.hooks.has("reset")) steps.unshift("0. run the reset hook (known state)");
    const finding = createFinding(
      {
        engine: "bugs",
        ruleId: f.ruleId,
        category: info.category,
        title,
        description: `${f.message}. Technique: ${e.case.technique} (${e.case.label}). ${
          stats && stats.runs > 0
            ? `Replayed ${stats.runs}x after reset: failed ${stats.failures}/${stats.runs}${cls.flaky ? ` (flaky, rate ${(cls.rate * 100).toFixed(0)} %, Wilson 95 % [${(cls.wilson.lower * 100).toFixed(0)}, ${(cls.wilson.upper * 100).toFixed(0)}] %)` : ""}.`
            : f.observation
              ? "Recorded as an observation (not a contract violation)."
              : "Not replayed."
        }`,
        severity,
        classification: cls.classification,
        confidence: reproduced ? cls.confidence : f.observation ? 0.5 : 0.3,
        evidence,
        affected: [f.operation],
        reproduction: {
          steps,
          command: `sw replay ${f.fingerprint}`,
          seed: e.case.seed,
          artifacts: artifactPaths,
        },
        recommendation: info.recommendation,
        occurrences: Math.max(1, e.occurrences),
        tags: [e.case.technique, ...(cls.flaky ? ["flaky"] : []), ...(minimized ? ["minimized"] : [])],
        fingerprint: f.fingerprint,
      },
      { newId: ctx.newId, clock: ctx.clock },
    );
    findings.push(finding);
    const row = matrix.get(f.operation);
    if (row && reproduced) row.findings.push(finding.id);
    summaries.push({
      id: finding.id,
      fingerprint: f.fingerprint,
      ruleId: f.ruleId,
      operation: f.operation,
      technique: e.case.technique,
      classification: cls.classification,
      severity,
      title,
      flaky: cls.flaky,
      failures: cls.failures,
      replays: cls.runs,
      rate: cls.rate,
      wilson: cls.wilson,
      occurrences: e.occurrences,
      minimized,
    });
  }

  // ---------------------------------------------------------------- matrix / coverage
  let documented = 0;
  let observed = 0;
  let exercised = 0;
  for (const row of matrix.values()) {
    const cells = Object.values(row.techniques);
    const conclusive = cells.some((c) => c && c.passed + c.failed > 0);
    if (conclusive) exercised++;
    row.verdict = row.findings.length > 0 ? "fail" : conclusive ? "pass" : "untested";
    const docStatuses = row.documentedStatuses.filter((x) => /^\d{3}$/.test(x));
    documented += docStatuses.length;
    observed += docStatuses.filter((x) => (row.statuses[x] ?? 0) > 0).length;
  }
  const transportErrors = s.http.stats.transportErrors;
  // Every request failed at transport level: nothing was tested. Not a pass (exit 5 via target-unreachable).
  const targetUnreachable = s.http.stats.sent > 0 && transportErrors === s.http.stats.sent;
  if (targetUnreachable) {
    for (const row of matrix.values()) if (row.findings.length === 0) row.verdict = "untested";
    exercised = 0;
    limitations.push({
      code: "target-unreachable",
      message: `All ${s.http.stats.sent} requests failed at transport level (connection refused / timeout). Is ${input.target} running?`,
      impact: "invalidates",
    });
  } else if (transportErrors > 0) {
    limitations.push({
      code: "BUGS_TRANSPORT_ERRORS",
      message: `${transportErrors} requests failed at transport level (timeouts/aborts); classified as inconclusive, not as bugs`,
      impact: "reduces-confidence",
    });
  }
  if (s.http.stats.rateLimited > 0) {
    limitations.push({
      code: "BUGS_RATE_LIMITED",
      message: `${s.http.stats.rateLimited} responses were 429; backed off using Retry-After (not counted as bugs)`,
      impact: "informational",
    });
  }
  const totalOps = matrix.size;
  const data: BugsData = {
    mode: s.contract ? "contract" : "discovery",
    target: input.target,
    seed: s.seed,
    techniques: input.techniques,
    matrix: [...matrix.values()],
    coverage: {
      operations: { total: totalOps, exercised },
      statuses: { documented, observed },
      techniques: techniqueCounts,
      ratio: totalOps === 0 ? 0 : exercised / totalOps,
    },
    findings: summaries,
    reproductions,
    requests: { ...s.http.stats, replays: replaysRun, hookRuns: s.hooks.runs },
    mutationsAllowed: s.mutationsAllowed,
    dictionary: s.dict.snapshot(),
    durationMs: ctx.clock.now() - t0,
  };
  if (s.contract) {
    data.contract = {
      source: s.contract.source,
      version: s.contract.version,
      hash: s.contract.hash,
      operations: s.contract.operations.length,
    };
    if (s.contract.title !== undefined) data.contract.title = s.contract.title;
  }
  if (draftContract) data.draftContract = draftContract;
  await s.close();
  const cancelled = ctx.signal.aborted;
  const hasDefect = findings.some((f) => f.classification === "reproduced-defect");
  const status = cancelled
    ? "cancelled"
    : targetUnreachable
      ? "error"
      : hasDefect
        ? "failed"
        : budgetHit
          ? "partial"
          : "passed";
  ctx.events.emit("bugs.done", {
    runId,
    findings: findings.length,
    defects: findings.filter((f) => f.classification === "reproduced-defect").length,
  });
  return {
    schemaVersion: 1,
    engine: "bugs",
    runId,
    status,
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings,
    limitations,
    artifacts,
    data,
  };
}

/** Discovery mode: GET the configured paths, record shapes, report 5xx as observations only. */
async function discovery(
  s: Session,
  record: (c: BugCase, run: CaseRun) => void,
): Promise<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  const specs = s.input.discover?.paths ?? ["GET /"];
  const env: EvalEnv = s.env;
  for (const spec of specs) {
    const [m0, ...rest] = spec.trim().split(/\s+/);
    const method = rest.length > 0 ? (m0 ?? "GET").toUpperCase() : "GET";
    const path = rest.length > 0 ? rest.join(" ") : (m0 ?? "/");
    const c: BugCase = {
      id: `discovery-${spec}`,
      technique: "discovery",
      operation: `${method} ${path}`,
      label: "discovery",
      seed: s.seed,
      steps: [
        {
          request: {
            operation: `${method} ${path}`,
            method,
            path,
            pathParams: {},
            query: {},
            headers: {},
            body: { kind: "none" },
            secured: true,
          },
          expect: "none",
        },
      ],
      check: { kind: "conformance" },
    };
    const run = await runCase(c, env);
    const ex = run.stepExchanges[0];
    if (ex && !ex.error && !ex.blocked) {
      if (ex.status >= 500) {
        run.failures.push({
          ruleId: "bugs/server-error-observed",
          operation: c.operation,
          pointer: "",
          keyword: "status",
          message: `${c.operation} answered ${ex.status} (no contract: observation only)`,
          step: 0,
          status: ex.status,
          observation: true,
          fingerprint: `disc-${c.operation}-${ex.status}`,
        });
      }
      paths[path] ??= {};
      const item = paths[path] as Record<string, unknown>;
      item[method.toLowerCase()] ??= { responses: {} };
      const opEntry = item[method.toLowerCase()] as {
        responses: Record<string, unknown>;
      };
      const prev = opEntry.responses[String(ex.status)] as
        | { content?: Record<string, { schema: Record<string, unknown> }> }
        | undefined;
      const ct = (ex.contentType.split(";")[0] ?? "").trim() || "application/octet-stream";
      const schema = ex.json !== undefined ? inferSchema(ex.json) : { type: "string" };
      const merged = prev?.content?.[ct] ? mergeInferred(prev.content[ct].schema, schema) : schema;
      opEntry.responses[String(ex.status)] = {
        description: "observed",
        content: { [ct]: { schema: merged } },
      };
    }
    record(c, run);
  }
  return {
    openapi: "3.1.0",
    info: { title: "Draft contract (discovered by SECOND WORLD, review before use)", version: "0.0.0-draft" },
    paths,
  };
}
