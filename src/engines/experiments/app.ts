/**
 * Application lifecycle for What-If arms and Evolution candidates (docs/03-engines/experiments.md §A.3, §B.2):
 * random free port injected via env (`PORT` by default), wait-for-healthy with a timeout, stop with a
 * process-tree kill. docs/06-environments-and-portability.md §2 (ports :0, process trees).
 */
import { createServer } from "node:net";
import { execa } from "execa";
import { EngineError } from "../../core/errors.js";
import type { Clock } from "../../core/types.js";
import { type CommandSpec, isAlive, killTree, toArgv } from "./command.js";

/** Asks the OS for a free TCP port on `host` (bind :0, read, close). Small race window by design. */
export function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen({ port: 0, host }, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

export interface ReadyWhen {
  /** Health path (default "/"). */
  path: string;
  /** Accepted statuses (default any 2xx). */
  status?: number[] | undefined;
  bodyContains?: string | undefined;
  /** Startup timeout, ms. */
  timeoutMs: number;
  /** Poll interval, ms. */
  intervalMs: number;
}

/** A command transformed for execution (sandbox wrappers may rewrite argv/env and add cleanup). */
export interface LaunchPlan {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Extra cleanup after the process tree is killed (e.g. `docker rm -f`). */
  cleanup?: () => Promise<void>;
}

export interface StartAppOptions {
  command: CommandSpec;
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Env var receiving the port (default "PORT"). */
  portEnv?: string;
  /** Fixed port (default: a free random port). */
  port?: number;
  host?: string;
  readyWhen: ReadyWhen;
  signal?: AbortSignal;
  clock: Clock;
  /** Optional rewrite of the launch (sandbox). */
  wrap?: (plan: LaunchPlan, port: number) => LaunchPlan | Promise<LaunchPlan>;
  /** Appended to the health-timeout message (e.g. the sandbox's bind-address convention). */
  healthHint?: string;
}

export interface RunningApp {
  url: string;
  port: number;
  pid: number | undefined;
  argv: string[];
  /** Tail of the app's combined output. */
  output(): string;
  /** Kills the process tree and waits for exit. Idempotent. */
  stop(): Promise<void>;
  readonly exited: boolean;
}

async function probe(url: string, rw: ReadyWhen): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(Math.min(2000, rw.timeoutMs)),
      redirect: "manual",
    });
    // Always drain the body so the keep-alive socket is released.
    const body = await res.text();
    const statusOk = rw.status ? rw.status.includes(res.status) : res.status >= 200 && res.status < 300;
    return statusOk && (rw.bodyContains === undefined || body.includes(rw.bodyContains));
  } catch {
    return false;
  }
}

/** Polls `url` until healthy, the deadline passes, the signal aborts or `failed()` returns a reason. */
export async function waitHealthy(
  url: string,
  rw: ReadyWhen,
  clock: Clock,
  signal?: AbortSignal,
  failed?: () => string | undefined,
  hint?: string,
): Promise<void> {
  const deadline = clock.now() + rw.timeoutMs;
  for (;;) {
    if (signal?.aborted)
      throw new EngineError("SW_ENGINE_WHATIF_CANCELLED", "cancelled while waiting for health");
    const why = failed?.();
    if (why) throw new EngineError("SW_ENGINE_WHATIF_APP_EXITED", why);
    if (await probe(url, rw)) return;
    if (clock.now() >= deadline) {
      throw new EngineError(
        "SW_ENGINE_WHATIF_HEALTH_TIMEOUT",
        `not healthy at ${url} within ${rw.timeoutMs} ms${hint ? `. ${hint}` : ""}`,
      );
    }
    await clock.sleep(rw.intervalMs, signal).catch(() => undefined);
  }
}

/** Starts an app, waits until healthy, and returns a handle. On failure the process tree is killed. */
export async function startApp(opts: StartAppOptions): Promise<RunningApp> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? (await getFreePort(host));
  const portEnv = opts.portEnv ?? "PORT";
  let plan: LaunchPlan = {
    argv: toArgv(opts.command),
    cwd: opts.cwd,
    env: { ...opts.env, [portEnv]: String(port) },
  };
  if (opts.wrap) plan = await opts.wrap(plan, port);
  const [file, ...args] = plan.argv as [string, ...string[]];
  const child = execa(file, args, {
    cwd: plan.cwd,
    env: plan.env,
    extendEnv: true,
    reject: false,
    stdin: "ignore",
    buffer: false,
    all: true,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let out = "";
  child.all?.on("data", (b: Buffer) => {
    out = (out + b.toString("utf8")).slice(-8000);
  });
  let exited = false;
  let exitInfo = "";
  const done = child.then(
    (r) => {
      exited = true;
      exitInfo = r.exitCode !== undefined ? `exit code ${r.exitCode}` : (r.signal ?? "terminated");
    },
    () => {
      exited = true;
    },
  );
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (!exited) await killTree(child.pid);
      await Promise.race([done, new Promise((r) => setTimeout(r, 10_000).unref())]);
      if (!exited && child.pid !== undefined && isAlive(child.pid)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      await plan.cleanup?.().catch(() => undefined);
    })();
    return stopping;
  };
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  try {
    await waitHealthy(`${url}${opts.readyWhen.path}`, opts.readyWhen, opts.clock, opts.signal, () =>
      exited
        ? `app exited before becoming healthy (${exitInfo || "spawn failed"}): ${out.trim().split(/\r?\n/).slice(-5).join(" | ").slice(0, 600)}`
        : undefined,
      opts.healthHint,
    );
  } catch (e) {
    await stop();
    throw e;
  }
  return {
    url,
    port,
    pid: child.pid,
    argv: plan.argv,
    output: () => out,
    stop,
    get exited() {
      return exited;
    },
  };
}
