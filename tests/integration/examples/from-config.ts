/**
 * Run the `sw` CLI against an example app with exactly its own `sw.config.ts`
 * (docs/12-testing-and-quality.md §3, docs/08-configuration.md §1).
 *
 * - The example folder is copied to a temp dir and the CLI gets `--config <copy>/sw.config.ts`,
 *   so config-relative paths (openapi, reports, history) resolve inside the copy and examples/
 *   stays untouched.
 * - The config's fixed ports are replaced the way a user would: with SW_* environment overrides
 *   (docs/08 §1 precedence 2) pointing at the random ports `startExample` picked.
 * - Scoring: every defect in expected-findings.json lists `detectedBy` entries (command + ruleId +
 *   operation or location). Recall is over `detectableFromConfig !== false` defects; a finding is a
 *   false positive unless it matches a detection entry or a documented `observations` entry.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";
import type { ExampleName, RunningExample } from "../../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

export interface Detection {
  /** CLI command that finds the defect from the example config, e.g. "sw bugs". */
  command: string;
  ruleId: string;
  /** Finding's first affected operation ("POST /orders"). */
  operation?: string;
  /** Match by location (file + line ±3) instead of operation. */
  location?: boolean;
  /** Substring of the finding title (disambiguates two checks with the same rule + operation). */
  titleIncludes?: string;
}

export interface Defect {
  id: string;
  engine: string;
  ruleId: string;
  endpoint?: string;
  detectableFromConfig?: boolean;
  detectableFromConfigReason?: string;
  detectedBy?: Detection[];
  location: { file: string; line: number };
}

export interface Observation {
  /** Command, or a command prefix ("sw reliability run" covers every scenario). */
  command: string;
  ruleId: string;
  operation?: string;
  /** Location file of the finding (static findings). */
  file?: string;
  reason: string;
}

/** Finding classifications that are not defect claims (may be documented as observations). */
const OBSERVATION_LEVELS = new Set(["observation", "suspected-risk"]);

export interface GroundTruth {
  app: ExampleName;
  defects: Defect[];
  observations?: Observation[];
}

export interface ReportFinding {
  ruleId: string;
  title: string;
  severity: string;
  classification: string;
  affected: string[];
  locations: { file: string; line: number; endLine?: number }[];
}

export interface EngineReport {
  engine: string;
  status: string;
  findings: ReportFinding[];
  limitations?: { code: string; message?: string }[];
  data?: unknown;
}

export function groundTruth(app: ExampleName): GroundTruth {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "examples", app, "expected-findings.json"), "utf8"),
  ) as GroundTruth;
}

/** Copy examples/<app> to a fresh temp dir (examples/ is never written by the CLI). */
export async function copyExample(app: ExampleName): Promise<TmpDir> {
  const tmp = await makeTmpDir(`sw-ex-${app}-`);
  await cp(join(REPO_ROOT, "examples", app), tmp.path, { recursive: true });
  // stop config discovery / git-root walking at the copy
  await mkdir(tmp.join(".git"), { recursive: true });
  return tmp;
}

/** SW_* overrides that point the example config at the running example's random ports. */
export function portOverrides(ex: RunningExample, opts: { proxyPort?: number } = {}): Record<string, string> {
  const env: Record<string, string> = {
    SW_TARGETS__API__URL: ex.url,
    SW_TARGETS__PAYMENTS__URL: ex.payments.url,
    SW_HOOKS__RESET__HTTP__URL: `${ex.url}/__test/reset`,
  };
  if (opts.proxyPort !== undefined)
    env.SW_RELIABILITY__DEPENDENCIES__PAYMENTS__PROXY_LISTEN = String(opts.proxyPort);
  return env;
}

export interface FromConfigRun {
  exitCode: number;
  stderr: string;
  report: EngineReport;
}

/**
 * `sw --config <copy>/sw.config.ts <args…> --json` with port overrides.
 * Returns the single engine result of the combined JSON report.
 */
export async function runFromConfig(
  dir: TmpDir,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 120_000,
): Promise<FromConfigRun> {
  const r = await runCli(["--config", dir.join("sw.config.ts"), ...args, "--json"], {
    cwd: dir.path,
    timeoutMs,
    env: {
      SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config"),
      SW_FAULT_LEDGER: dir.join("fault-ledger.json"),
      ...env,
    },
  });
  let parsed: { results?: EngineReport[] };
  try {
    parsed = JSON.parse(r.stdout) as { results?: EngineReport[] };
  } catch {
    throw new Error(
      `sw ${args.join(" ")} printed no JSON (exit ${r.exitCode}):\n${r.stderr.slice(-3000)}\n${r.stdout.slice(0, 2000)}`,
    );
  }
  const report = parsed.results?.[0];
  if (!report)
    throw new Error(`sw ${args.join(" ")}: no engine result (exit ${r.exitCode})\n${r.stderr.slice(-2000)}`);
  return { exitCode: r.exitCode, stderr: r.stderr, report };
}

function norm(op: string): string {
  return op.replace(/\?.*$/, "").trim();
}

function matchesDetection(f: ReportFinding, d: Detection, defect: Defect): boolean {
  if (f.ruleId !== d.ruleId) return false;
  if (d.titleIncludes !== undefined && !f.title.includes(d.titleIncludes)) return false;
  if (d.location) {
    const l = f.locations[0];
    if (!l || path.posix.normalize(l.file.replaceAll("\\", "/")) !== defect.location.file) return false;
    return defect.location.line >= l.line - 3 && defect.location.line <= (l.endLine ?? l.line) + 3;
  }
  if (d.operation !== undefined) return norm(f.affected[0] ?? "") === norm(d.operation);
  return true;
}

export interface Score {
  recall: number;
  precision: number;
  /** Detectable defects this command should find. */
  expected: string[];
  matched: string[];
  missed: string[];
  falsePositives: string[];
  /** Findings explained by a documented observation entry. */
  observations: string[];
}

/**
 * Scores one command's findings. Defects count for recall when they are detectable from config
 * and list a `detectedBy` entry for `command`. Every finding must match one of the app's
 * detection entries for `command` (any defect) or a documented observation for `command`.
 */
export function scoreCommand(truth: GroundTruth, command: string, findings: ReportFinding[]): Score {
  const forCmd = truth.defects.flatMap((defect) =>
    (defect.detectedBy ?? []).filter((d) => d.command === command).map((d) => ({ defect, d })),
  );
  const expected = [
    ...new Set(forCmd.filter((x) => x.defect.detectableFromConfig !== false).map((x) => x.defect.id)),
  ];
  const obs = (truth.observations ?? []).filter(
    (o) => command === o.command || command.startsWith(`${o.command} `),
  );
  const matched = new Set<string>();
  const fps: string[] = [];
  const observed: string[] = [];
  for (const f of findings) {
    const hits = forCmd.filter((x) => matchesDetection(f, x.d, x.defect));
    for (const h of hits) matched.add(h.defect.id);
    if (hits.length > 0) continue;
    const label = `${f.classification} ${f.ruleId} ${f.affected[0] ?? f.locations[0]?.file ?? ""}: ${f.title}`;
    const o = obs.find(
      (x) =>
        x.ruleId === f.ruleId &&
        (x.operation === undefined || norm(x.operation) === norm(f.affected[0] ?? "")) &&
        (x.file === undefined || x.file === f.locations[0]?.file.replaceAll("\\", "/")),
    );
    if (o && OBSERVATION_LEVELS.has(f.classification)) observed.push(label);
    else fps.push(label);
  }
  const hitExpected = expected.filter((id) => matched.has(id));
  const counted = findings.length - observed.length;
  return {
    recall: expected.length === 0 ? 1 : hitExpected.length / expected.length,
    precision: counted === 0 ? 1 : (counted - fps.length) / counted,
    expected,
    matched: hitExpected,
    missed: expected.filter((id) => !matched.has(id)),
    falsePositives: fps,
    observations: observed,
  };
}

export function describeFindings(r: EngineReport): string {
  return r.findings
    .map(
      (f) =>
        `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0] ?? ""} ${f.locations[0] ? `${f.locations[0].file}:${f.locations[0].line}` : ""} :: ${f.title}`,
    )
    .join("\n");
}

/** Content hash of examples/<app> (proves the tests never write into examples/). */
export function hashExample(app: ExampleName): string {
  const root = join(REPO_ROOT, "examples", app);
  const h = createHash("sha256");
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
  for (const f of files)
    h.update(`${f}:`)
      .update(readFileSync(join(root, f)))
      .update(`;${f}`);
  return h.digest("hex");
}

/** CLI arguments for a documented command ("sw reliability run dependency-5xx" → approval + args). */
export function cliArgs(command: string): string[] {
  const words = command.split(/\s+/).slice(1);
  if (words[0] === "reliability") return ["--approve-disruptive", ...words];
  return words;
}

/** Commands from `detectedBy` (deduplicated, in order of first use). */
export function documentedCommands(truth: GroundTruth): string[] {
  return [...new Set(truth.defects.flatMap((d) => (d.detectedBy ?? []).map((x) => x.command)))];
}
