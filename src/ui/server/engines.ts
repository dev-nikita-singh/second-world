/**
 * `sw ui` engine catalogue: what the "New test" screen offers, and the ONLY way a browser request becomes a
 * command line. The client sends `{ engine, options }`; every option is checked against the spec below
 * (type, range, choices, a strict character set for text) and the server builds argv itself. A value can
 * never start with "-" and can never contain whitespace, so it cannot become a flag or a second argument.
 * docs/09-cli-and-api.md §1 "sw ui", docs/11-safety-security-privacy.md "Local UI server".
 */
import type { Config } from "../../core/config/schema.js";
import type { EngineInfo, JobRequest, OptionSpec, UiEngineId } from "../shared/api-types.js";

/** A scenario row for the reliability picker (from src/engines/reliability/scenarios.ts). */
export interface ScenarioRow {
  id: string;
  title: string;
}

interface Spec extends OptionSpec {
  /** CLI flag; `undefined` = positional argument (in spec order). */
  flag?: string;
  /** For `multi`: joined with "," into one flag value. */
}

interface EngineDef {
  id: UiEngineId;
  title: string;
  summary: string;
  typicalDuration: string;
  /** argv before the options, e.g. ["reliability", "run"]. */
  command: string[];
  needs: Array<"mutations" | "disruptive">;
  options: Spec[];
}

const DURATION_RE = /^\d{1,6}(\.\d{1,3})?(ms|s|m|h)$/;
/** Text values: names, lists of names, simple expressions. No spaces, no leading "-". */
const TEXT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:,/<>=%@+-]{0,127}$/;
const LABEL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

const BUGS_TECHNIQUES = [
  "contract",
  "boundary",
  "equivalence",
  "pairwise",
  "property",
  "negative",
  "stateful",
  "concurrency",
  "auth",
];
const AGENT_TECHNIQUES = [
  "status-gap",
  "param-gap",
  "boundary",
  "idempotency",
  "idempotency-concurrent",
  "ownership",
  "privilege",
  "lifecycle",
  "concurrency",
  "history",
  "arch-risk",
];

function defs(cfg: Config, scenarios: ScenarioRow[]): EngineDef[] {
  const raw = cfg as unknown as Record<string, Record<string, unknown> | undefined>;
  const experiments = Object.keys((raw.whatif?.experiments as Record<string, unknown> | undefined) ?? {});
  const deps = Object.keys((raw.reliability?.dependencies as Record<string, unknown> | undefined) ?? {});
  const targets = Object.keys(cfg.targets ?? {});
  const targetOpt: Spec = {
    name: "target",
    label: "Target",
    help: "Which app to test (from `targets` in the config). Empty = the engine's default.",
    kind: "enum",
    choices: targets,
    flag: "--target",
    advanced: targets.length <= 1,
  };
  const withTarget = (o: Spec[]): Spec[] => (targets.length > 0 ? [targetOpt, ...o] : o);

  return [
    {
      id: "inspect",
      title: "Code inspection",
      summary:
        "Reads the source code without running it and flags risky patterns (missing timeouts, N+1 queries, cycles…).",
      typicalDuration: "a few seconds",
      command: ["inspect"],
      needs: [],
      options: [
        {
          name: "noCache",
          label: "Ignore the analysis cache",
          help: "Re-analyse every file (slower).",
          kind: "boolean",
          flag: "--no-cache",
          advanced: true,
        },
      ],
    },
    {
      id: "bugs",
      title: "API bug hunt",
      summary:
        "Sends hundreds of tricky requests (edge values, other users' data, duplicates, races) and checks every answer against the API contract.",
      typicalDuration: "15 s – 2 min",
      command: ["bugs"],
      needs: [],
      options: withTarget([
        {
          name: "techniques",
          label: "Techniques",
          help: "Which kinds of tests to run. Empty = all.",
          kind: "multi",
          choices: BUGS_TECHNIQUES,
          flag: "--techniques",
        },
        {
          name: "allowMutations",
          label: "Allow create / change / delete requests",
          help: "Needed for ownership, duplicate and race tests. The app's data will change.",
          kind: "boolean",
          flag: "--allow-mutations",
          confirms: "mutations",
        },
        {
          name: "propertyRuns",
          label: "Property runs per operation",
          help: "More runs find rarer bugs but take longer.",
          kind: "number",
          min: 1,
          max: 1000,
          flag: "--property-runs",
          advanced: true,
        },
      ]),
    },
    {
      id: "perf",
      title: "Load test",
      summary: "Acts like many users at once and measures speed (p50/p95/p99), throughput and errors.",
      typicalDuration: "about the duration you set",
      command: ["perf"],
      needs: [],
      options: withTarget([
        {
          name: "model",
          label: "Load model",
          help: "open = a fixed number of requests per second; closed = a fixed number of users.",
          kind: "enum",
          choices: ["open", "closed", "iterations"],
          flag: "--model",
        },
        {
          name: "rate",
          label: "Requests per second",
          help: "For the open model.",
          kind: "number",
          min: 1,
          max: 100000,
          flag: "--rate",
        },
        {
          name: "vus",
          label: "Virtual users",
          help: "For the closed and iterations models.",
          kind: "number",
          min: 1,
          max: 10000,
          flag: "--vus",
        },
        {
          name: "duration",
          label: "Duration",
          help: "e.g. 20s, 2m.",
          kind: "duration",
          flag: "--duration",
        },
        {
          name: "warmup",
          label: "Warm-up",
          help: "Excluded from the results, e.g. 2s.",
          kind: "duration",
          flag: "--warmup",
          advanced: true,
        },
        {
          name: "workers",
          label: "Generator threads",
          help: "auto or a number. More threads for very high rates.",
          kind: "text",
          flag: "--workers",
          advanced: true,
        },
      ]),
    },
    {
      id: "stress",
      title: "Stress test",
      summary: "Increases the load step by step to find how much the app can take before it breaks.",
      typicalDuration: "steps × hold time",
      command: ["stress"],
      needs: [],
      options: withTarget([
        {
          name: "mode",
          label: "Mode",
          help: "step = fixed levels; ramp = gradual; spike = sudden burst; soak = long steady load; breakpoint = search the limit.",
          kind: "enum",
          choices: ["step", "ramp", "spike", "soak", "breakpoint"],
          flag: "--mode",
        },
        {
          name: "steps",
          label: "Levels",
          help: "Comma-separated, e.g. 10,25,50,100 (users).",
          kind: "text",
          flag: "--steps",
        },
        {
          name: "hold",
          label: "Hold per level",
          help: "e.g. 10s.",
          kind: "duration",
          flag: "--hold",
        },
        {
          name: "duration",
          label: "Soak duration",
          help: "Only for soak, e.g. 5m.",
          kind: "duration",
          flag: "--duration",
          advanced: true,
        },
      ]),
    },
    {
      id: "reliability",
      title: "Failure test",
      summary:
        "Breaks a dependency on purpose (errors, slowness, timeouts) while users are active, and checks the app copes and recovers.",
      typicalDuration: "20 s – 1 min",
      command: ["reliability", "run"],
      needs: ["disruptive"],
      options: [
        {
          name: "scenario",
          label: "Failure",
          help: "What goes wrong.",
          kind: "enum",
          choices: scenarios.map((s) => s.id),
          choiceLabels: Object.fromEntries(scenarios.map((s) => [s.id, s.title])),
          required: true,
        },
        ...(deps.length > 0
          ? [
              {
                name: "dependency",
                label: "Dependency",
                help: "Which dependency to break (from reliability.dependencies).",
                kind: "enum" as const,
                choices: deps,
                flag: "--dependency",
              },
            ]
          : []),
        {
          name: "duration",
          label: "Failure duration",
          help: "How long the failure lasts, e.g. 5s.",
          kind: "duration",
          flag: "--duration",
        },
        {
          name: "repeat",
          label: "Repetitions",
          help: "Run the experiment N times; a defect is 'reproduced' only when it shows up at least twice.",
          kind: "number",
          min: 1,
          max: 10,
          flag: "--repeat",
          advanced: true,
        },
        {
          name: "rate",
          label: "Requests per second",
          help: "Workload during the experiment.",
          kind: "number",
          min: 1,
          max: 10000,
          flag: "--rate",
          advanced: true,
        },
      ],
    },
    {
      id: "agent",
      title: "Attack ideas (agent)",
      summary:
        "Generates and runs extra test cases from what it learns (other users' data, wrong step order, privilege), within a budget. Deterministic, no AI.",
      typicalDuration: "up to the time budget",
      command: ["agent"],
      needs: [],
      options: withTarget([
        {
          name: "time",
          label: "Time budget",
          help: "e.g. 60s.",
          kind: "duration",
        },
        {
          name: "requests",
          label: "Request budget",
          help: "Maximum requests.",
          kind: "number",
          min: 10,
          max: 100000,
        },
        {
          name: "techniques",
          label: "Techniques",
          help: "Empty = all.",
          kind: "multi",
          choices: AGENT_TECHNIQUES,
          flag: "--techniques",
          advanced: true,
        },
        {
          name: "allowMutations",
          label: "Allow create / change requests",
          help: "The app's data will change.",
          kind: "boolean",
          flag: "--allow-mutations",
          confirms: "mutations",
        },
        {
          name: "allowDestructive",
          label: "Allow delete requests",
          help: "The agent may delete data.",
          kind: "boolean",
          flag: "--allow-destructive",
          confirms: "mutations",
          advanced: true,
        },
      ]),
    },
    {
      id: "whatif",
      title: "What-if comparison",
      summary:
        "Runs two versions of the app (e.g. before/after a change) several times in turn and says, with statistics, which is faster.",
      typicalDuration: "a few minutes",
      command: ["whatif"],
      needs: [],
      options: [
        {
          name: "experiment",
          label: "Experiment",
          help: "From whatif.experiments in the config.",
          kind: "enum",
          choices: experiments,
          required: true,
        },
        {
          name: "repetitions",
          label: "Runs per version",
          help: "At least 5 recommended.",
          kind: "number",
          min: 2,
          max: 50,
          flag: "--repetitions",
        },
        {
          name: "aa",
          label: "A/A check",
          help: "Compare the baseline with itself to measure how noisy this machine is.",
          kind: "boolean",
          flag: "--aa",
          advanced: true,
        },
      ],
    },
    {
      id: "model",
      title: "System map",
      summary: "Builds one picture of the system from code, the API contract, config files and telemetry.",
      typicalDuration: "a few seconds",
      command: ["model", "build"],
      needs: [],
      options: [
        {
          name: "noArchitecture",
          label: "Skip code analysis",
          help: "Only use the contract and config files.",
          kind: "boolean",
          flag: "--no-architecture",
          advanced: true,
        },
      ],
    },
  ];
}

function publicSpec(s: Spec): OptionSpec {
  const { flag: _flag, ...rest } = s;
  return rest;
}

/** The engine cards for `/api/session`. */
export function engineCatalogue(cfg: Config, scenarios: ScenarioRow[]): EngineInfo[] {
  const raw = cfg as unknown as Record<string, Record<string, unknown> | undefined>;
  return defs(cfg, scenarios).map((d) => {
    let configured = true;
    let notConfiguredReason: string | undefined;
    if (
      d.id === "whatif" &&
      Object.keys((raw.whatif?.experiments as object | undefined) ?? {}).length === 0
    ) {
      configured = false;
      notConfiguredReason = "No experiments in whatif.experiments (docs/03-engines/experiments.md).";
    }
    return {
      id: d.id,
      title: d.title,
      summary: d.summary,
      typicalDuration: d.typicalDuration,
      configured,
      ...(notConfiguredReason ? { notConfiguredReason } : {}),
      needs: d.needs,
      options: d.options.map(publicSpec),
    };
  });
}

export class JobRequestError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "CONFIRM_REQUIRED",
    message: string,
    readonly issues: string[] = [],
    readonly needs: Array<"mutations" | "disruptive"> = [],
  ) {
    super(message);
  }
}

export interface BuiltCommand {
  /** argv after the CLI entry (global flags first). */
  args: string[];
  /** For display: "sw …". */
  display: string;
}

function checkValue(
  spec: Spec,
  v: unknown,
): { ok: true; value: string | boolean | null } | { ok: false; why: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  switch (spec.kind) {
    case "boolean":
      if (typeof v !== "boolean") return { ok: false, why: "must be true or false" };
      return { ok: true, value: v };
    case "number": {
      const n =
        typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false, why: "must be a number" };
      if (spec.min !== undefined && n < spec.min) return { ok: false, why: `must be ≥ ${spec.min}` };
      if (spec.max !== undefined && n > spec.max) return { ok: false, why: `must be ≤ ${spec.max}` };
      return { ok: true, value: String(n) };
    }
    case "duration":
      if (typeof v !== "string" || !DURATION_RE.test(v))
        return { ok: false, why: "must be a duration like 500ms, 20s, 2m" };
      return { ok: true, value: v };
    case "enum":
      if (typeof v !== "string" || !(spec.choices ?? []).includes(v))
        return {
          ok: false,
          why: `must be one of: ${(spec.choices ?? []).join(", ") || "(none configured)"}`,
        };
      return { ok: true, value: v };
    case "multi": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !(spec.choices ?? []).includes(x)))
        return { ok: false, why: `must be a list of: ${(spec.choices ?? []).join(", ")}` };
      if (v.length === 0) return { ok: true, value: null };
      return { ok: true, value: [...new Set(v as string[])].join(",") };
    }
    case "text":
      if (typeof v !== "string" || !TEXT_RE.test(v))
        return { ok: false, why: "may only contain letters, digits and . , : / < > = % @ + - _ (no spaces)" };
      return { ok: true, value: v };
  }
}

function quote(a: string): string {
  return /^[A-Za-z0-9_./:=,@%+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`;
}

/**
 * Validates a job request against the catalogue and builds the CLI argv. Throws JobRequestError
 * (400 BAD_REQUEST with the issues, or 428 CONFIRM_REQUIRED with what must be confirmed).
 * `globals` are the flags `sw ui` itself was started with that every child must repeat (--config, --profile).
 */
export function buildCommand(
  req: JobRequest,
  cfg: Config,
  scenarios: ScenarioRow[],
  globals: string[],
): BuiltCommand {
  const def = defs(cfg, scenarios).find((d) => d.id === req.engine);
  if (!def) throw new JobRequestError("BAD_REQUEST", `Unknown test type "${String(req.engine)}"`);
  const options = req.options ?? {};
  if (typeof options !== "object" || Array.isArray(options))
    throw new JobRequestError("BAD_REQUEST", "options must be an object");
  const issues: string[] = [];
  for (const k of Object.keys(options))
    if (!def.options.some((o) => o.name === k)) issues.push(`${k}: unknown option for ${def.title}`);

  const positional: string[] = [];
  const flags: string[] = [];
  const needs = new Set(def.needs);
  let budget: string[] = [];
  for (const spec of def.options) {
    const r = checkValue(spec, (options as Record<string, unknown>)[spec.name]);
    if (!r.ok) {
      issues.push(`${spec.label}: ${r.why}`);
      continue;
    }
    if (r.value === null || r.value === false) {
      if (spec.required) issues.push(`${spec.label}: required`);
      continue;
    }
    if (spec.confirms) needs.add(spec.confirms);
    if (def.id === "agent" && (spec.name === "time" || spec.name === "requests")) {
      budget = [...budget, `${spec.name}=${r.value}`];
      continue;
    }
    if (!spec.flag) positional.push(String(r.value));
    else if (r.value === true) flags.push(spec.flag);
    else flags.push(spec.flag, String(r.value));
  }
  if (budget.length) flags.push("--budget", budget.join(","));
  if (
    req.label !== undefined &&
    req.label !== "" &&
    (typeof req.label !== "string" || !LABEL_RE.test(req.label))
  )
    issues.push("Label: letters, digits, . _ : - only (max 64)");
  if (issues.length) throw new JobRequestError("BAD_REQUEST", "Some options are not valid", issues);

  const missing = [...needs].filter((n) => !req.confirm?.[n]);
  if (missing.length && !req.dryRun) {
    const what = missing
      .map((n) =>
        n === "disruptive"
          ? "it injects failures into the app's dependencies"
          : "it creates, changes or deletes data in the app",
      )
      .join(" and ");
    throw new JobRequestError("CONFIRM_REQUIRED", `This test needs your confirmation: ${what}.`, [], missing);
  }

  const g = [...globals];
  if (req.label) g.push("--label", req.label);
  if (req.dryRun) g.push("--dry-run");
  // Confirmations given in the UI are passed exactly like on the command line (and logged to the audit log).
  if (needs.has("mutations") && req.confirm?.mutations) g.push("--yes");
  if (needs.has("disruptive") && req.confirm?.disruptive) g.push("--approve-disruptive");
  const args = [...g, ...def.command, ...positional, ...flags];
  return { args, display: ["sw", ...args].map(quote).join(" ") };
}

/** `sw replay <fingerprint>` for a Bug Hunter finding. */
export function buildReplayCommand(fingerprint: string, globals: string[]): BuiltCommand {
  if (!/^[A-Za-z0-9:_-]{6,128}$/.test(fingerprint))
    throw new JobRequestError("BAD_REQUEST", "Not a finding fingerprint");
  const args = [...globals, "replay", fingerprint];
  return { args, display: ["sw", ...args].map(quote).join(" ") };
}
