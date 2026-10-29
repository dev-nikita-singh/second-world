/**
 * Setup / reset hooks: bring the system under test to a known state before each run and replay
 * (docs/03-engines/api-bug-hunter.md §3 step 1). HTTP hooks pass the safety target check;
 * command hooks run via execa with an argv array and NO shell (docs/11 §5).
 */
import { isAbsolute, resolve } from "node:path";
import {
  createUndiciExecutor,
  type ExecutorSafety,
  flattenHeaders,
} from "../../adapters/http/undici-executor.js";
import { ConfigError, SafetyError } from "../../core/errors.js";
import type { EngineContext } from "../../core/types.js";
import type { Hook } from "./schema.js";

/** Splits a command string into argv (supports single/double quotes and backslash escapes; no shell features). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur.length > 0) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new ConfigError("SW_CONFIG_BUGS_HOOK", `Unterminated quote in hook command: ${cmd}`);
  if (has || cur.length > 0) out.push(cur);
  return out;
}

export interface HookRunner {
  run(name: "setup" | "reset"): Promise<void>;
  has(name: "setup" | "reset"): boolean;
  close(): Promise<void>;
  runs: number;
}

export function createHookRunner(
  ctx: EngineContext,
  hooks: { setup?: Hook | undefined; reset?: Hook | undefined },
  opts: { cwd: string; target: string; timeoutMs: number },
): HookRunner {
  const executor = createUndiciExecutor({
    timeoutMs: opts.timeoutMs,
    connections: 2,
    safety: ctx.safety as ExecutorSafety, // F6 (sw-perf)
  });
  const runner: HookRunner = {
    runs: 0,
    has: (name) => hooks[name] !== undefined,
    async run(name) {
      const h = hooks[name];
      if (!h) return;
      runner.runs++;
      if ("http" in h) {
        const u = new URL(h.http.url, opts.target);
        const d = ctx.safety.checkTarget(u);
        if (!d.allowed) {
          throw new SafetyError("SW_SAFETY_HOOK_TARGET", `Hook ${name} targets a blocked host: ${d.reason}`, {
            hint: d.hint,
          });
        }
        const headers: Record<string, string> = { ...h.http.headers };
        let body: string | undefined;
        if (h.http.body !== undefined) {
          body = typeof h.http.body === "string" ? h.http.body : JSON.stringify(h.http.body);
          headers["content-type"] ??= "application/json";
        }
        const r = await executor.execute(
          {
            origin: u.origin,
            method: h.http.method.toUpperCase(),
            path: u.pathname + u.search,
            headers: flattenHeaders(headers),
            ...(body === undefined ? {} : { body }),
          },
          ctx.signal,
        );
        const okStatus = h.http.expectStatus
          ? h.http.expectStatus.includes(r.status)
          : r.status >= 200 && r.status < 300;
        if (r.error || !okStatus) {
          throw new ConfigError(
            "SW_CONFIG_BUGS_HOOK",
            `Hook ${name} failed: ${r.error ? r.error.message : `HTTP ${r.status}`}`,
            {
              hint: "Check bugs.hooks (the reset hook must bring the API to a known state)",
            },
          );
        }
        ctx.safety.audit({ action: `bugs.hook.${name}`, target: u.origin });
        return;
      }
      const argv = Array.isArray(h.command) ? h.command : splitCommand(h.command);
      const [file, ...args] = argv;
      if (!file) throw new ConfigError("SW_CONFIG_BUGS_HOOK", `Hook ${name} has an empty command`);
      const cwd = h.cwd ? (isAbsolute(h.cwd) ? h.cwd : resolve(opts.cwd, h.cwd)) : opts.cwd;
      const { execa } = await import("execa");
      try {
        await execa(file, args, {
          cwd,
          timeout: h.timeout,
          shell: false,
          reject: true,
          cancelSignal: ctx.signal,
          stdin: "ignore",
        });
      } catch (e) {
        throw new ConfigError(
          "SW_CONFIG_BUGS_HOOK",
          `Hook ${name} command failed: ${(e as Error).message.split("\n")[0]}`,
          {
            hint: "Commands run without a shell (argv array); use an explicit interpreter for scripts",
          },
        );
      }
      ctx.safety.audit({ action: `bugs.hook.${name}`, detail: { command: file } });
    },
    close: () => executor.close(),
  };
  return runner;
}
