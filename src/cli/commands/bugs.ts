/**
 * `sw bugs` (API Bug Hunter) and `sw replay <fingerprint>`. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/api-bug-hunter.md; wiring notes in CONTRACTS.md "sw-bugs".
 * Mutating requests need --allow-mutations / safety.allowMutations, or approval (--yes) through
 * ctx.safety.requireApproval("mutating-requests"); otherwise they are blocked (BUGS_MUTATIONS_BLOCKED).
 * Reproductions are persisted under .second-world/artifacts/<runId>/bugs-<fingerprint>.json.
 */
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ulid } from "ulid";
import { ConfigError, ExitCode, SecondWorldError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";
import { attachProgress, finishRun, installSignals, worldFromGlobals } from "../run-common.js";
import { int } from "./perf.js";

const ARTIFACTS_DIR = join(".second-world", "artifacts");

function list(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr
    .flatMap((x) => String(x).split(","))
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

/** `--invariant` → built-in spec or module path. Built-ins: linearizable:<model>[:initial], max-success:<n>, same-response. */
export function parseInvariant(spec: string): Record<string, unknown> | string {
  const parts = spec.split(":");
  const kind = parts[0];
  if (kind === "linearizable") {
    const model = parts[1] ?? "stock";
    if (!["stock", "counter", "register", "set"].includes(model)) {
      throw new ConfigError(
        "SW_CONFIG_FLAG",
        `--invariant linearizable model must be stock|counter|register|set, got "${model}"`,
      );
    }
    const inv: Record<string, unknown> = { kind: "linearizable", model };
    if (parts[2] !== undefined) {
      const n = Number(parts[2]);
      if (!Number.isFinite(n))
        throw new ConfigError(
          "SW_CONFIG_FLAG",
          `--invariant initial value must be a number, got "${parts[2]}"`,
        );
      inv.initial = n;
    }
    return inv;
  }
  if (kind === "max-success") {
    const n = Number(parts[1]);
    if (!Number.isInteger(n) || n < 0)
      throw new ConfigError("SW_CONFIG_FLAG", `--invariant max-success:<n> needs an integer, got "${spec}"`);
    return { kind: "max-success", max: n };
  }
  if (kind === "same-response") return { kind: "same-response" };
  return spec; // module path (resolved by the engine against cwd)
}

export const MIX_FORM =
  '"<METHOD> <path>[:<count>] [as=<op>] [count=<n>] [phase=before|during|after] [pointer=/json/ptr] [value=<v>] [role=<name>] [<pathParam>=<v>] [query.<k>=<v>] [header.<k>=<v>] [body=<json>]"';
const MIX_AS = ["take", "read", "inc", "dec", "write", "add", "remove", "has"];
const MIX_PHASES = ["before", "during", "after"];

function mixError(spec: string, why: string): ConfigError {
  return new ConfigError("SW_CONFIG_FLAG", `--mix "${spec}": ${why}`, {
    hint: `Expected ${MIX_FORM}, e.g. --mix "GET /products/{id} id=20 as=read pointer=/stock count=2"`,
  });
}

/** Path/query values: numbers stay numbers (the contract decides), true/false → boolean for query. */
function scalar(v: string, booleans: boolean): string | number | boolean {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (booleans && (v === "true" || v === "false")) return v === "true";
  return v;
}

/**
 * `--mix` → one ConcurrencyTest.mix entry (docs/03-engines/api-bug-hunter.md §6). Whitespace-separated
 * `key=value` tokens after "METHOD /path"; `body=` takes the rest of the string (JSON, may contain
 * spaces). `as` defaults to `read` for GET/HEAD and is required otherwise.
 */
export function parseMix(spec: string): Record<string, unknown> {
  const text = spec.trim();
  const head = /^([A-Za-z]+)\s+(\S+)/.exec(text);
  if (!head) throw mixError(spec, 'must start with an operation, "METHOD /path"');
  const method = (head[1] as string).toUpperCase();
  let path = head[2] as string;
  const entry: Record<string, unknown> = {};
  const shorthand = /^(.*\S):(\d+)$/.exec(path);
  if (shorthand) {
    path = shorthand[1] as string;
    entry.count = Number(shorthand[2]);
  }
  if (!path.startsWith("/")) throw mixError(spec, `path must start with "/", got "${path}"`);
  entry.operation = `${method} ${path}`;
  const pathNames = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string));
  const pathParams: Record<string, string | number> = {};
  const query: Record<string, string | number | boolean> = {};
  const headers: Record<string, string> = {};
  let rest = text.slice(head[0].length).trim();
  while (rest.length > 0) {
    const bodyAt = /^body=/.exec(rest);
    if (bodyAt) {
      try {
        entry.body = JSON.parse(rest.slice(5));
      } catch {
        throw mixError(spec, "body= must be valid JSON (and the last token)");
      }
      break;
    }
    const tok = /^(\S+)\s*/.exec(rest) as RegExpExecArray;
    rest = rest.slice(tok[0].length);
    const t = tok[1] as string;
    const eq = t.indexOf("=");
    if (eq <= 0) throw mixError(spec, `"${t}" is not key=value`);
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    if (k === "count") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 64)
        throw mixError(spec, `count must be an integer 1..64, got "${v}"`);
      entry.count = n;
    } else if (k === "as") {
      if (!MIX_AS.includes(v)) throw mixError(spec, `as must be ${MIX_AS.join("|")}, got "${v}"`);
      entry.as = v;
    } else if (k === "phase") {
      if (!MIX_PHASES.includes(v)) throw mixError(spec, `phase must be before|during|after, got "${v}"`);
      entry.phase = v;
    } else if (k === "pointer") {
      if (v !== "" && !v.startsWith("/"))
        throw mixError(spec, `pointer must be a JSON pointer ("/stock"), got "${v}"`);
      entry.pointer = v;
    } else if (k === "value" || k === "role") {
      entry[k] = v;
    } else if (k.startsWith("query.") && k.length > 6) {
      query[k.slice(6)] = scalar(v, true);
    } else if (k.startsWith("header.") && k.length > 7) {
      headers[k.slice(7)] = v;
    } else if (pathNames.has(k)) {
      pathParams[k] = scalar(v, false) as string | number;
    } else {
      const known = [
        "as",
        "count",
        "phase",
        "pointer",
        "value",
        "role",
        "body",
        "query.<k>",
        "header.<k>",
        ...pathNames,
      ];
      throw mixError(spec, `unknown key "${k}" (known: ${known.join(", ")})`);
    }
  }
  if (entry.as === undefined) {
    if (method !== "GET" && method !== "HEAD")
      throw mixError(spec, `as=<${MIX_AS.join("|")}> is required for ${method}`);
    entry.as = "read";
  }
  if (Object.keys(pathParams).length) entry.pathParams = pathParams;
  if (Object.keys(query).length) entry.query = query;
  if (Object.keys(headers).length) entry.headers = headers;
  return entry;
}

/** Maps `sw bugs` flags to a loose Bug Hunter input. */
/** `cwd`: directory the command was run from (flag paths are relative to it). */
export function bugsInputFromFlags(o: Record<string, unknown>, cwd = process.cwd()): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (o.target) input.target = o.target;
  if (o.openapi) input.openapi = resolve(cwd, String(o.openapi));
  const tech = list(o.techniques);
  if (tech) input.techniques = tech;
  for (const [flag, key] of [
    ["replays", "replays"],
    ["maxReplays", "maxReplays"],
    ["propertyRuns", "propertyRuns"],
  ] as const) {
    const n = int(
      flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
      o[flag],
    );
    if (n !== undefined) input[key] = n;
  }
  const include = list(o.include);
  const exclude = list(o.exclude);
  if (include || exclude)
    input.operations = { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
  if (o.allowMutations === true) input.allowMutations = true;
  if (o.timeout !== undefined) input.timeout = o.timeout;
  const ops = list(o.concurrencyTest);
  // Not split on commas: a mix body is JSON.
  const mixSpecs = o.mix === undefined ? [] : (Array.isArray(o.mix) ? o.mix : [o.mix]).map(String);
  if (ops) {
    const mix = mixSpecs.map(parseMix);
    const burst = int("burst", o.burst) ?? 10;
    let body: unknown;
    if (o.body !== undefined) {
      try {
        body = JSON.parse(String(o.body));
      } catch {
        throw new ConfigError("SW_CONFIG_FLAG", "--body must be valid JSON");
      }
    }
    input.concurrency = ops.map((operation) => ({
      operation,
      burst,
      ...(o.role ? { role: o.role } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(o.invariant ? { invariant: parseInvariant(String(o.invariant)) } : {}),
      ...(mix.length ? { mix } : {}),
    }));
  } else if (o.burst !== undefined || o.invariant !== undefined || mixSpecs.length > 0) {
    throw new ConfigError(
      "SW_CONFIG_FLAG",
      '--burst/--invariant/--mix require --concurrency-test "METHOD /path"',
    );
  }
  return input;
}

/**
 * Rewrites every artifact path under `from` to the same path under `to`, wherever the result
 * references it: result.artifacts, findings[].reproduction.artifacts and findings[].evidence[].artifact.
 * Called after the pending artifacts dir is renamed to the runId, so no reference points at a gone path.
 */
export function relocateArtifacts(result: EngineResult, from: string, to: string): void {
  const move = (p: string): string =>
    p === from || p.startsWith(from + sep) || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
  result.artifacts = result.artifacts.map((a) => ({ ...a, path: move(a.path) }));
  for (const f of result.findings) {
    if (f.reproduction) f.reproduction = { ...f.reproduction, artifacts: f.reproduction.artifacts.map(move) };
    f.evidence = f.evidence.map((e) =>
      "artifact" in e && typeof e.artifact === "string" ? { ...e, artifact: move(e.artifact) } : e,
    );
  }
}

export async function bugsCommand(o: Record<string, unknown>, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const flags = bugsInputFromFlags(o, world.config.invocationCwd ?? world.config.cwd);
    const plan = world.buildInput("bugs", flags);
    if (typeof plan.target !== "string") {
      throw new ConfigError("SW_CONFIG_NO_TARGET", "No Bug Hunter target given", {
        hint: "Pass --target http://127.0.0.1:3000, or set bugs.target / targets in sw.config",
      });
    }
    await world.safety.preflight(plan.target);
    if (g.dryRun) {
      const { parseBugsInput } = await import("../../engines/bugs/index.js");
      const parsed = parseBugsInput(plan);
      const view = {
        ...parsed,
        auth: parsed.auth ? { ...parsed.auth, roles: Object.keys(parsed.auth.roles ?? {}) } : undefined,
      };
      if (o.json)
        out(
          JSON.stringify(
            world.redactor.redactObject({
              dryRun: true,
              target: plan.target,
              safety: "allowed",
              input: view,
            }),
            null,
            2,
          ),
        );
      else {
        out(`${s.ok} config valid, ${s.ok} safety check passed for ${plan.target}`);
        out(JSON.stringify(world.redactor.redactObject(view), null, 2));
        out(s.dim("dry run: nothing was sent"));
      }
      process.exitCode = 0;
      return;
    }
    // Reproductions go to a pending dir, renamed to the engine's runId afterwards.
    const artifactsRoot = resolve(world.config.cwd, ARTIFACTS_DIR);
    const pending = join(artifactsRoot, `pending-${ulid()}`);
    flags.artifactsDir = pending;
    attachProgress(world, g, { json: o.json === true });
    if (!g.quiet && !o.json) {
      world.on("bugs.technique", (p) => {
        const t = p as { technique?: string; requests?: number; findings?: number; ms?: number };
        err(
          s.dim(
            `technique ${t.technique ?? "?"}: ${t.requests ?? 0} requests, ${t.findings ?? 0} finding(s), ${((t.ms ?? 0) / 1000).toFixed(1)}s`,
          ),
        );
      });
    }
    const result = (await world.bugs.run(flags)) as EngineResult;
    if (existsSync(pending)) {
      const final = join(artifactsRoot, result.runId);
      try {
        renameSync(pending, final);
        relocateArtifacts(result, pending, final);
      } catch {
        // keep the pending dir; replay searches every artifacts subdir
      }
    }
    await finishRun(world, result, g, {
      json: o.json === true,
      history: o.history as boolean | undefined,
      label: "bugs",
    });
  } finally {
    removeSignals();
    await world.close();
  }
}

interface FoundArtifact {
  fingerprint: string;
  path?: string;
  data?: unknown;
}

/** Finds reproductions by fingerprint prefix: artifacts dirs first (newest first), then history. */
async function findReproduction(
  world: Awaited<ReturnType<typeof worldFromGlobals>>,
  prefix: string,
): Promise<FoundArtifact> {
  const matches = new Map<string, FoundArtifact>();
  const root = resolve(world.config.cwd, ARTIFACTS_DIR);
  if (existsSync(root)) {
    const dirs = readdirSync(root)
      .map((d) => join(root, d))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const d of dirs) {
      for (const f of readdirSync(d)) {
        const m = /^bugs-([0-9a-f]+)\.json$/i.exec(f);
        if (m && (m[1] as string).startsWith(prefix.toLowerCase()) && !matches.has(m[1] as string)) {
          matches.set(m[1] as string, { fingerprint: m[1] as string, path: join(d, f) });
        }
      }
    }
  }
  if (matches.size === 0) {
    try {
      const store = (await world.history.store()) as unknown as {
        list(o: { engine?: string; limit?: number }): Promise<Array<{ id: string }>>;
        get(id: string): Promise<{ results: EngineResult[] } | null>;
      };
      for (const e of await store.list({ engine: "bugs", limit: 50 })) {
        const run = await store.get(e.id);
        for (const r of run?.results ?? []) {
          const reps =
            (r.data as { reproductions?: Record<string, unknown> } | undefined)?.reproductions ?? {};
          for (const fp of Object.keys(reps)) {
            if (fp.startsWith(prefix.toLowerCase()) && !matches.has(fp))
              matches.set(fp, { fingerprint: fp, data: r.data });
          }
        }
        if (matches.size > 0) break;
      }
    } catch {
      // no history
    }
  }
  if (matches.size === 0) {
    throw new SecondWorldError(
      "SW_REPLAY_NOT_FOUND",
      `No recorded reproduction matches "${prefix}"`,
      ExitCode.ConfigInvalid,
      {
        hint: "Run `sw bugs` first; reproductions are stored in .second-world/artifacts/<runId>/ and in history",
      },
    );
  }
  if (matches.size > 1) {
    throw new SecondWorldError(
      "SW_REPLAY_AMBIGUOUS",
      `"${prefix}" matches ${matches.size} findings: ${[...matches.keys()].slice(0, 5).join(", ")}`,
      ExitCode.ConfigInvalid,
      {
        hint: "Use a longer fingerprint prefix",
      },
    );
  }
  return [...matches.values()][0] as FoundArtifact;
}

export async function replayCommand(
  fingerprint: string,
  o: Record<string, unknown>,
  g: GlobalOptions,
): Promise<void> {
  const s = style(colorEnabled(g));
  if (!/^[0-9a-f]{4,}$/i.test(fingerprint)) {
    throw new ConfigError("SW_CONFIG_FLAG", `Invalid fingerprint "${fingerprint}"`, {
      hint: "Use the hex fingerprint (or a ≥ 4-char prefix) shown in the report",
    });
  }
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g);
  try {
    const found = await findReproduction(world, fingerprint);
    const input = world.buildInput(
      "bugs",
      bugsInputFromFlags(o, world.config.invocationCwd ?? world.config.cwd),
    );
    if (typeof input.target !== "string") {
      throw new ConfigError("SW_CONFIG_NO_TARGET", "No target to replay against", {
        hint: "Pass --target or set bugs.target / targets in sw.config",
      });
    }
    await world.safety.preflight(input.target);
    const runs = int("runs", o.runs);
    const bugs = await import("../../engines/bugs/index.js");
    const source = found.path
      ? { artifactPath: found.path }
      : ({ fingerprint: found.fingerprint, data: found.data } as Parameters<typeof bugs.replayFinding>[1]);
    const r = await bugs.replayFinding(input as never, source, world.context("bugs"), runs ? { runs } : {});
    const summary = {
      fingerprint: r.fingerprint,
      ruleId: r.ruleId,
      operation: r.operation,
      classification: r.classification,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      failures: r.failures,
      runs: r.runs,
      flaky: r.flaky,
      rate: r.rate,
      wilson: r.wilson,
    };
    if (o.json) out(JSON.stringify(summary, null, 2));
    else if (r.classification === "inconclusive") {
      out(
        `${s.fail} ${r.ruleId} ${r.operation}: replay inconclusive (${r.reason ?? "check could not be evaluated"})`,
      );
    } else {
      const repro = r.classification === "reproduced-defect";
      out(
        `${repro ? s.fail : s.ok} ${r.ruleId} ${r.operation}: ${repro ? "still reproduces" : "does not reproduce"} (${r.failures}/${r.runs} failing${r.flaky ? ", flaky" : ""})`,
      );
      out(
        s.dim(
          `rate ${(r.rate * 100).toFixed(0)}%  Wilson 95% [${(r.wilson.lower * 100).toFixed(0)}%, ${(r.wilson.upper * 100).toFixed(0)}%]  source: ${found.path ?? "history"}`,
        ),
      );
    }
    // 1 = still reproduces, 2 = inconclusive (never report "fixed" when the check was not evaluated), 0 = does not reproduce.
    process.exitCode =
      r.classification === "reproduced-defect"
        ? 1
        : r.classification === "inconclusive"
          ? ExitCode.ConfigInvalid
          : 0;
  } finally {
    removeSignals();
    await world.close();
  }
}
