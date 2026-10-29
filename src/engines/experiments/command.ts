/**
 * Safe external command execution for What-If arms and Evolution gates.
 * docs/11-safety-security-privacy.md §5 (argv, no shell, timeouts, process-tree kill) and
 * docs/06-environments-and-portability.md §2 (Windows process trees: `taskkill /T /F`; POSIX: process group).
 *
 * - Commands are argv arrays. A string is split by `splitCommand` (quotes only, no shell features).
 * - Every command has a timeout. On timeout or cancel the WHOLE process tree is killed.
 * - Output is kept as a bounded tail (never unbounded memory).
 */
import { execa } from "execa";
import { ConfigError } from "../../core/errors.js";
import type { Clock } from "../../core/types.js";

export type CommandSpec = string | readonly string[];

/**
 * Splits a command string into argv. Supports single and double quotes. Inside double quotes,
 * `\"` and `\\` are escapes; elsewhere a backslash is literal (so Windows paths like `C:\app\x.js`
 * survive). No globbing, pipes, redirection or variable expansion: those need a real shell, which
 * is never used.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new ConfigError("SW_CONFIG_EXPERIMENT_COMMAND", `Unterminated quote in command: ${cmd}`);
  if (has) out.push(cur);
  return out;
}

export function toArgv(cmd: CommandSpec): string[] {
  const argv = typeof cmd === "string" ? splitCommand(cmd) : [...cmd];
  if (argv.length === 0 || !argv[0]) {
    throw new ConfigError("SW_CONFIG_EXPERIMENT_COMMAND", "Empty command");
  }
  return argv;
}

/** Display form of an argv (for reports/audit). */
export function formatArgv(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
}

/** True while a process with this pid exists (EPERM counts as alive). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kills a process and all of its descendants.
 * win32: `taskkill /T /F /PID <pid>`. POSIX: SIGKILL to the process group (the child must have been
 * spawned with `detached: true`, which `runCommand`/`startApp` do), falling back to the pid alone.
 */
export async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    await execa("taskkill", ["/T", "/F", "/PID", String(pid)], {
      reject: false,
      windowsHide: true,
      timeout: 15_000,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export interface RunCommandOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Hard timeout (ms). Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Max characters kept from each of stdout/stderr (tail). Default 8000. */
  maxOutput?: number;
  clock?: Pick<Clock, "now">;
}

export interface CommandResult {
  argv: string[];
  exitCode: number;
  ok: boolean;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Spawn error (ENOENT …), if any. */
  error?: string;
}

function appendTail(buf: string, chunk: string, max: number): string {
  const s = buf + chunk;
  return s.length > max ? s.slice(s.length - max) : s;
}

const perfClock = { now: () => performance.now() };

/** Runs a command to completion (argv, no shell). Never throws for a non-zero exit. */
export async function runCommand(cmd: CommandSpec, opts: RunCommandOptions): Promise<CommandResult> {
  const argv = toArgv(cmd);
  const clock = opts.clock ?? perfClock;
  const max = opts.maxOutput ?? 8000;
  const t0 = clock.now();
  if (opts.signal?.aborted) {
    return {
      argv,
      exitCode: -1,
      ok: false,
      timedOut: false,
      cancelled: true,
      stdout: "",
      stderr: "",
      durationMs: 0,
    };
  }
  const [file, ...args] = argv as [string, ...string[]];
  const child = execa(file, args, {
    cwd: opts.cwd,
    env: opts.env ?? {},
    extendEnv: true,
    reject: false,
    stdin: "ignore",
    buffer: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => {
    stdout = appendTail(stdout, b.toString("utf8"), max);
  });
  child.stderr?.on("data", (b: Buffer) => {
    stderr = appendTail(stderr, b.toString("utf8"), max);
  });
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child.pid);
  }, opts.timeoutMs ?? 600_000);
  const onAbort = () => {
    cancelled = true;
    void killTree(child.pid);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await child;
    const exitCode = typeof r.exitCode === "number" ? r.exitCode : -1;
    const spawnError =
      r.failed && r.exitCode === undefined && !timedOut && !cancelled ? r.shortMessage : undefined;
    return {
      argv,
      exitCode,
      ok: exitCode === 0 && !timedOut && !cancelled,
      timedOut,
      cancelled,
      stdout,
      stderr,
      durationMs: clock.now() - t0,
      ...(spawnError ? { error: spawnError } : {}),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Short human-readable reason for a failed command (for rejection reasons). */
export function describeFailure(r: CommandResult): string {
  const what = formatArgv(r.argv);
  if (r.cancelled) return `${what}: cancelled`;
  if (r.timedOut) return `${what}: timed out after ${Math.round(r.durationMs)} ms`;
  if (r.error) return `${what}: ${r.error}`;
  const tail = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-3).join(" | ");
  return `${what}: exit code ${r.exitCode}${tail ? ` (${tail.slice(0, 300)})` : ""}`;
}
