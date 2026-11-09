/**
 * Runs one test at a time for `sw ui`, as a child `sw` process (never in the UI process): the safety guard,
 * confirmations, audit log, history and exit codes are exactly those of the CLI. Output lines are kept in a
 * bounded buffer and pushed to subscribers (the SSE endpoint).
 *
 * Stop: Windows cannot deliver SIGINT to a child (Node's kill("SIGINT") terminates it without running
 * handlers), so the child gets an IPC channel and `{ type: "sw-ui-interrupt" }` makes it emit SIGINT to
 * itself: the graceful Ctrl+C path (cancelled report, history, exit 130) on every OS. A second stop kills.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { JobLine, RunJob, UiEngineId } from "../shared/api-types.js";

export const MAX_LINES = 5000;
/** Message the CLI understands when started by the UI (src/cli/main.ts). */
export const INTERRUPT_MESSAGE = { type: "sw-ui-interrupt" } as const;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

export function exitMeaning(
  code: number | undefined,
  ctx: { engine?: string; dryRun?: boolean } = {},
): string {
  if (ctx.engine === "replay" && code === 0) return "No longer reproduces: looks fixed";
  if (ctx.engine === "replay" && code === 1) return "Still reproduces: not fixed yet";
  if (ctx.dryRun && code === 0) return "Plan is valid: nothing was sent";
  switch (code) {
    case 0:
      return "Passed: nothing at or above the fail-on severity";
    case 1:
      return "Finished and found problems";
    case 2:
      return "The command or the config is not valid";
    case 3:
      return "Blocked by the safety guard";
    case 4:
      return "A required tool or capability is missing";
    case 5:
      return "The app under test is down or failing";
    case 70:
      return "Internal error in SECOND WORLD (please report it)";
    case 130:
      return "Stopped";
    default:
      return code === undefined ? "Ended without an exit code" : `Exit code ${code}`;
  }
}

/** How to start the CLI: `file` (node), then `prefix` (node flags + CLI entry), then the job's args. */
export interface CliCommand {
  file: string;
  prefix: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

type Listener = (ev: { type: "line"; line: JobLine } | { type: "status" | "end"; job: RunJob }) => void;

interface Active {
  job: RunJob;
  child: ChildProcess;
  lines: JobLine[];
  dropped: number;
  listeners: Set<Listener>;
  stops: number;
}

export class JobBusyError extends Error {}

let seq = 0;

export class JobRunner {
  private current: Active | null = null;
  private last: Active | null = null;

  constructor(private readonly cli: CliCommand) {}

  get running(): RunJob | null {
    return this.current ? { ...this.current.job } : null;
  }

  /** The running job, or the last finished one (so a reloaded page still sees how it ended). */
  get(id: string): Active | null {
    if (this.current?.job.id === id) return this.current;
    if (this.last?.job.id === id) return this.last;
    return null;
  }

  latest(): RunJob | null {
    const a = this.current ?? this.last;
    return a ? { ...a.job } : null;
  }

  start(engine: UiEngineId | "replay", args: string[], display: string, dryRun = false): RunJob {
    if (this.current) throw new JobBusyError("A test is already running");
    seq++;
    const job: RunJob = {
      id: `job-${Date.now().toString(36)}-${seq}`,
      engine,
      command: display,
      startedAt: new Date().toISOString(),
      state: "running",
      ...(dryRun ? { dryRun: true } : {}),
    };
    const child = spawn(this.cli.file, [...this.cli.prefix, ...args], {
      cwd: this.cli.cwd,
      env: {
        ...process.env,
        ...this.cli.env,
        SECOND_WORLD_UI_JOB: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      shell: false,
      windowsHide: true,
    });
    const active: Active = { job, child, lines: [], dropped: 0, listeners: new Set(), stops: 0 };
    this.current = active;
    for (const [stream, src] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      let carry = "";
      src?.setEncoding("utf8");
      src?.on("data", (chunk: string) => {
        const parts = (carry + chunk).split(/\r?\n/);
        carry = parts.pop() ?? "";
        for (const p of parts) this.push(active, { stream, text: p.replace(ANSI, "") });
      });
      src?.on("end", () => {
        if (carry) this.push(active, { stream, text: carry.replace(ANSI, "") });
        carry = "";
      });
    }
    child.on("error", (e) => {
      this.push(active, { stream: "stderr", text: `could not start the test: ${e.message}` });
      this.finish(active, 70);
    });
    child.on("close", (code, signal) => {
      this.finish(active, code ?? (signal ? 130 : undefined));
    });
    return { ...job };
  }

  private push(a: Active, line: JobLine): void {
    // "history: saved run <ULID>" is the CLI's stable line for the saved run.
    const m = /history: saved run ([0-9A-HJKMNP-TV-Z]{26})/.exec(line.text);
    if (m?.[1]) a.job.runId = m[1];
    a.lines.push(line);
    if (a.lines.length > MAX_LINES) {
      a.lines.shift();
      a.dropped++;
    }
    for (const l of a.listeners) l({ type: "line", line });
  }

  private finish(a: Active, code: number | undefined): void {
    if (a.job.state === "finished") return;
    a.job.state = "finished";
    a.job.endedAt = new Date().toISOString();
    if (code !== undefined) a.job.exitCode = code;
    a.job.exitMeaning = exitMeaning(code, { engine: a.job.engine, dryRun: a.job.dryRun === true });
    if (this.current === a) this.current = null;
    this.last = a;
    for (const l of a.listeners) l({ type: "end", job: { ...a.job } });
    a.listeners.clear();
  }

  /** First call: graceful (like Ctrl+C). Second call: kill. */
  stop(id: string): RunJob | null {
    const a = this.current;
    if (!a || a.job.id !== id) return null;
    a.stops++;
    if (a.stops === 1) {
      a.job.state = "stopping";
      let sent = false;
      if (a.child.connected) {
        try {
          sent = a.child.send(INTERRUPT_MESSAGE);
        } catch {
          sent = false;
        }
      }
      if (!sent) a.child.kill("SIGINT");
      for (const l of a.listeners) l({ type: "status", job: { ...a.job } });
    } else {
      a.child.kill("SIGKILL");
    }
    return { ...a.job };
  }

  /** Buffered lines (for a reconnecting client) and live updates. Returns an unsubscribe function. */
  subscribe(
    id: string,
    fn: Listener,
  ): { lines: JobLine[]; dropped: number; job: RunJob; off: () => void } | null {
    const a = this.get(id);
    if (!a) return null;
    if (a.job.state !== "finished") a.listeners.add(fn);
    return {
      lines: [...a.lines],
      dropped: a.dropped,
      job: { ...a.job },
      off: () => {
        a.listeners.delete(fn);
      },
    };
  }

  /** Stops a running job and waits for it (server shutdown). */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const a = this.current;
    if (!a) return;
    const done = new Promise<void>((r) => a.child.once("close", () => r()));
    this.stop(a.job.id);
    const t = setTimeout(() => a.child.kill("SIGKILL"), timeoutMs);
    await done;
    clearTimeout(t);
  }
}
