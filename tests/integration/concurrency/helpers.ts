/** Spawning helpers for real-process concurrency tests (tests/integration/concurrency). */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

export interface GatedProxy {
  url: string;
  /** Requests the proxy has seen. */
  readonly seen: number;
  close(): Promise<void>;
}

/**
 * HTTP proxy in front of `target` that makes "the run is in flight" a fact instead of a timing guess:
 * once it has forwarded `afterRequests` requests it creates `triggerFile` (for SW_TEST_SIGINT_WHEN_FILE)
 * and from then on holds every further request for `holdMs` before forwarding it. A Ctrl+C sent after
 * the trigger therefore always lands while the run still has requests outstanding, on fast and slow
 * machines alike.
 */
export async function startGatedProxy(
  target: string,
  o: { afterRequests: number; triggerFile: string; holdMs: number },
): Promise<GatedProxy> {
  const up = new URL(target);
  let seen = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((req, res) => {
    seen++;
    const forward = (): void => {
      const preq = http.request(
        {
          host: up.hostname,
          port: up.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: up.host },
        },
        (pres) => {
          res.writeHead(pres.statusCode ?? 502, pres.headers);
          pres.pipe(res);
        },
      );
      preq.on("error", () => res.destroy());
      req.pipe(preq);
    };
    if (seen <= o.afterRequests) {
      if (seen === o.afterRequests) writeFileSync(o.triggerFile, "in flight\n");
      forward();
      return;
    }
    req.pause();
    const t = setTimeout(() => {
      timers.delete(t);
      req.resume();
      forward();
    }, o.holdMs);
    timers.add(t);
    res.on("close", () => {
      clearTimeout(t);
      timers.delete(t);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get seen() {
      return seen;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
