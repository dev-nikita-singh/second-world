/**
 * Run the SECOND WORLD CLI from source as a user would (docs/12-testing-and-quality.md §1 E2E).
 * Spawns `node --import <tsx loader URL> src/cli/main.ts ...args` with execa:
 * no shell, no npx, works identically on Windows/macOS/Linux, and the node
 * process *is* the CLI process (so signals reach it directly).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa, type ResultPromise } from "execa";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli", "main.ts");
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the process was killed by the timeout. */
  timedOut: boolean;
}

function cliEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  // Deterministic, non-interactive defaults; caller env wins.
  return { NO_COLOR: "1", FORCE_COLOR: undefined, CI: "1", ...env };
}

/** Start the CLI and return the execa subprocess (for signal tests). */
export function spawnCli(args: string[], opts: RunCliOptions = {}): ResultPromise {
  return execa(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: cliEnv(opts.env),
    extendEnv: true,
    reject: false,
    timeout: opts.timeoutMs ?? 60_000,
    ...(opts.input === undefined ? { stdin: "ignore" as const } : { input: opts.input }),
    ...(opts.signal ? { cancelSignal: opts.signal } : {}),
    stripFinalNewline: false,
    windowsHide: true,
  });
}

/** Run the CLI to completion and collect exit code and output. Never throws on non-zero exit. */
export async function runCli(args: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const r = await spawnCli(args, opts);
  return {
    exitCode: typeof r.exitCode === "number" ? r.exitCode : -1,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    timedOut: Boolean(r.timedOut),
  };
}
