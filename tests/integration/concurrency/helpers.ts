/** Spawning helpers for real-process concurrency tests (tests/integration/concurrency). */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa, type ResultPromise } from "execa";
import { REPO_ROOT } from "../../helpers/cli.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TSX_LOADER = pathToFileURL(
  path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
).href;
export const SW_ENTRY = path.join(HERE, "fixtures", "sw-entry.ts");
export const HISTORY_WRITER = path.join(HERE, "fixtures", "history-writer.ts");

export interface SwOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Runs `sw` through the test entry (no forced exit; optional Ctrl+C emulation). Never rejects. */
export function swProc(args: string[], o: SwOptions): ResultPromise {
  return execa(process.execPath, ["--import", TSX_LOADER, SW_ENTRY, ...args], {
    cwd: o.cwd,
    env: { NO_COLOR: "1", FORCE_COLOR: undefined, CI: "1", ...o.env },
    extendEnv: true,
    reject: false,
    timeout: o.timeoutMs ?? 90_000,
    stdin: "ignore",
    windowsHide: true,
  });
}

export interface SwResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** main() resolved, i.e. the command itself finished (vs. the process being killed). */
  mainReturned: boolean;
}

export async function sw(args: string[], o: SwOptions): Promise<SwResult> {
  const r = await swProc(args, o);
  const stderr = String(r.stderr ?? "");
  return {
    exitCode: typeof r.exitCode === "number" ? r.exitCode : -1,
    stdout: String(r.stdout ?? ""),
    stderr,
    timedOut: Boolean(r.timedOut),
    mainReturned: /sw-entry: main returned/.test(stderr),
  };
}

/** Every file below `dir` (relative, forward slashes). */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(path.join(dir, rel));
    } catch {
      continue;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(path.join(dir, r)).isDirectory()) stack.push(r);
      else out.push(r);
    }
  }
  return out.sort();
}

/** Temp/lock leftovers SECOND WORLD may create while writing. */
export const LEFTOVER = /(\.tmp-|\.tmp$|\.lock$|\.break$|\.stale-|pending-)/;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
