/**
 * Run the calibrated server in a separate Node process (via the tsx loader, no shell).
 *
 * Why: the in-process server's precise timer spins on setImmediate near deadlines.
 * When the load generator runs in the same process, that spin is counted as generator
 * CPU / event-loop delay and the Performance Lab self-check reports a false
 * "generator-saturated". Use this for load tests whose generator health matters
 * (perf accuracy suite, stress stages); use the in-process `startCalibratedServer()`
 * for functional tests (it is faster to start and its methods are synchronous).
 *
 * Same API as CalibratedServer, except that the control methods are async (they are
 * RPCs over stdio). If the parent dies, the child sees stdin close and exits.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CalibratedBehavior, CalibratedServerOptions, CalibratedStats } from "./calibrated.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const ENTRY = path.join(HERE, "calibrated-child-entry.ts");

export interface ChildCalibratedServer {
  url: string;
  port: number;
  /** OS process id of the child (for diagnostics). */
  pid: number;
  stats(): Promise<CalibratedStats>;
  resetStats(): Promise<void>;
  setBehavior(b: CalibratedBehavior): Promise<void>;
  stallFor(ms: number, opts?: { allRoutes?: boolean }): Promise<void>;
  /** Stops the server and waits for the child to exit (kills it after 3 s). Idempotent. */
  close(): Promise<void>;
}

export interface ChildServerOptions extends CalibratedServerOptions {
  /** Startup timeout, ms (default 15 000). */
  startTimeoutMs?: number;
}

export async function startCalibratedServerInChild(
  opts: ChildServerOptions = {},
): Promise<ChildCalibratedServer> {
  const { startTimeoutMs = 15_000, ...serverOpts } = opts;
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--import", TSX_LOADER, ENTRY, JSON.stringify(serverOpts)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString("utf8")).slice(-4000);
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      for (const p of pending.values()) p.reject(new Error("calibrated child exited"));
      pending.clear();
      resolve();
    });
  });

  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<{ url: string; port: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`calibrated child did not start within ${startTimeoutMs} ms\n${stderr}`));
    }, startTimeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    void exitPromise.then(() => {
      clearTimeout(timer);
      reject(new Error(`calibrated child exited before ready (code ${child.exitCode})\n${stderr}`));
    });
    lines.on("line", (line) => {
      let msg: {
        ready?: boolean;
        url?: string;
        port?: number;
        id?: number;
        ok?: boolean;
        value?: unknown;
        error?: string;
      };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg.ready && msg.url && msg.port) {
        clearTimeout(timer);
        resolve({ url: msg.url, port: msg.port });
        return;
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (!p) return;
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error ?? "rpc failed"));
      }
    });
  });

  const { url, port } = await ready;

  const rpc = <T>(op: string, ...args: unknown[]): Promise<T> => {
    if (exited) return Promise.reject(new Error("calibrated child is not running"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  };

  let closing: Promise<void> | undefined;
  return {
    url,
    port,
    pid: child.pid ?? -1,
    stats: () => rpc<CalibratedStats>("stats"),
    resetStats: () => rpc<void>("resetStats"),
    setBehavior: (b) => rpc<void>("setBehavior", b),
    stallFor: (ms, o) => rpc<void>("stallFor", ms, o),
    close: () => {
      closing ??= (async () => {
        if (exited) return;
        const kill = setTimeout(() => child.kill(), 3000);
        await rpc("close").catch(() => undefined);
        child.stdin.end();
        await exitPromise;
        clearTimeout(kill);
      })();
      return closing;
    },
  };
}
