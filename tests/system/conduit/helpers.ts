/**
 * Helpers for the conduit-api system tests (owner: sw-real7, wave 7 Plan §C).
 * docs/12-testing-and-quality.md §3 (ground truth, recall/precision).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type EngineReport,
  type GroundTruth,
  type Score,
  scoreCommand,
} from "../../integration/examples/from-config.js";
import { EXAMPLES_DIR } from "../helpers.js";

export const CONDUIT_DIR = path.join(EXAMPLES_DIR, "conduit-api");
/** Demo tokens of the seeded accounts: must never appear in CLI output or reports. */
export const CONDUIT_TOKENS = [
  "alice-token",
  "bob-token",
  "carol-token",
  "dave-token",
  "erin-token",
  "frank-token",
];

export function conduitTruth(): GroundTruth {
  return JSON.parse(readFileSync(path.join(CONDUIT_DIR, "expected-findings.json"), "utf8")) as GroundTruth;
}

/**
 * Copy examples/conduit-api to `dest` (the user's project) and point its sw.config.ts at the running
 * app (`apiUrl` replaces http://127.0.0.1:3100) and at a free port for the reliability edge proxy
 * (replaces 3101). A `.git` folder stops config discovery at the copy.
 */
export function copyConduit(dest: string, apiUrl: string, proxyPort: number): string {
  cpSync(CONDUIT_DIR, dest, { recursive: true });
  const cfgPath = path.join(dest, "sw.config.ts");
  const cfg = readFileSync(cfgPath, "utf8")
    .split("http://127.0.0.1:3100")
    .join(apiUrl)
    .replace(/\b3101\b/g, String(proxyPort));
  writeFileSync(cfgPath, cfg);
  if (!existsSync(path.join(dest, ".git"))) mkdirSync(path.join(dest, ".git"));
  return cfgPath;
}

/** First engine result of a `--json` report on stdout. */
export function engineResult(stdout: string, what: string): EngineReport {
  let parsed: { results?: EngineReport[] };
  try {
    parsed = JSON.parse(stdout) as { results?: EngineReport[] };
  } catch {
    throw new Error(`${what}: stdout is not JSON:\n${stdout.slice(0, 2000)}`);
  }
  const r = parsed.results?.[0];
  if (!r) throw new Error(`${what}: no engine result`);
  return r;
}

export function score(command: string, report: EngineReport): Score {
  return scoreCommand(conduitTruth(), command, report.findings);
}

export function describeScore(command: string, s: Score, report: EngineReport): string {
  const lines = report.findings.map(
    (f) =>
      `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0] ?? ""} ${f.locations[0] ? `${f.locations[0].file}:${f.locations[0].line}` : ""} :: ${f.title}`,
  );
  return `[conduit] ${command}: recall ${s.matched.length}/${s.expected.length} precision ${s.precision.toFixed(2)} missed ${JSON.stringify(s.missed)} FP ${JSON.stringify(s.falsePositives)}\n${lines.join("\n")}`;
}
