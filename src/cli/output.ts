/**
 * CLI output helpers: symbols with ASCII fallback, colors honouring --no-color/NO_COLOR,
 * error → exit code mapping with hints. See docs/09 §1 and docs/02 §4.5.
 * stdout = machine/report output; stderr = logs, progress and errors.
 */
import pc from "picocolors";
import { ExitCode, isSecondWorldError } from "../core/errors.js";
import { createLogger, silentLogger } from "../core/log/logger.js";
import type { Logger } from "../core/types.js";
import type { GlobalOptions } from "./main.js";

export interface Style {
  ok: string;
  warn: string;
  fail: string;
  info: string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

export function colorEnabled(g: Pick<GlobalOptions, "color"> = {}): boolean {
  if (g.color === false) return false;
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.TERM === "dumb") return false;
  return process.stdout.isTTY === true;
}

export function unicodeEnabled(): boolean {
  const env = process.env;
  if (process.platform !== "win32") return env.TERM !== "linux" && env.TERM !== "dumb";
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.CI || env.TERM === "xterm-256color");
}

export function style(color: boolean, unicode = unicodeEnabled()): Style {
  const c = pc.createColors(color);
  return {
    ok: c.green(unicode ? "✔" : "OK"),
    warn: c.yellow(unicode ? "⚠" : "!!"),
    fail: c.red(unicode ? "✖" : "XX"),
    info: c.cyan(unicode ? "ℹ" : "i"),
    green: c.green,
    yellow: c.yellow,
    red: c.red,
    dim: c.dim,
    bold: c.bold,
  };
}

export function makeLogger(g: GlobalOptions): Logger {
  if (g.quiet && !g.verbose) return createLogger({ level: "error", json: g.jsonLogs === true });
  return createLogger({ level: g.verbose ? "debug" : "warn", json: g.jsonLogs === true });
}

export function out(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
}

export function err(s: string): void {
  process.stderr.write(s.endsWith("\n") ? s : `${s}\n`);
}

/** Prints an error with its hint to stderr and returns the exit code. */
export function reportError(e: unknown, opts: { color?: boolean } = {}): number {
  const s = style(opts.color ?? colorEnabled());
  if (isSecondWorldError(e)) {
    err(`${s.fail} ${e.message} ${s.dim(`[${e.code}, exit ${e.exitCode}]`)}`);
    if (e.hint) err(`  ${s.dim("hint:")} ${e.hint}`);
    return e.exitCode;
  }
  if (e && typeof e === "object" && (e as { name?: string }).name === "AbortError") {
    err(`${s.warn} cancelled`);
    return ExitCode.Cancelled;
  }
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  err(`${s.fail} Internal error: ${msg}`);
  err(
    `  ${s.dim("hint:")} this is a bug in SECOND WORLD; please report it with the output of \`sw doctor --json\``,
  );
  return ExitCode.Internal;
}

export { silentLogger };
