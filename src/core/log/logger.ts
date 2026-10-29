/**
 * Tiny structured logger with mandatory redaction. See docs/02-architecture.md §3 (core/log)
 * and docs/11-safety-security-privacy.md §4. Writes to stderr by default (stdout is for
 * reports / --json output). No pino dependency in core: keeps `sw --help` fast.
 */
import type { LogLevel, Logger } from "../types.js";
import { createRedactor, type Redactor } from "./redact.js";

const LEVELS: Record<Exclude<LogLevel, "silent">, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface LoggerOptions {
  level?: LogLevel;
  /** JSON lines instead of human text. */
  json?: boolean;
  /** Redactor applied to messages and data. Pass `false` to disable (tests only). */
  redact?: Redactor | false;
  /** Output sink (default: process.stderr.write). */
  write?: (line: string) => void;
  bindings?: Record<string, unknown>;
  /** Include ISO timestamps in text mode (always in JSON mode). */
  timestamps?: boolean;
  now?: () => string;
}

const noop = (): void => {};

export const silentLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLogger,
};

function fmtValue(v: unknown): string {
  if (typeof v === "string") return /[\s="]/.test(v) ? JSON.stringify(v) : v;
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  if (level === "silent") return silentLogger;
  const min = LEVELS[level];
  const redactor = opts.redact === false ? null : (opts.redact ?? createRedactor());
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  const now = opts.now ?? (() => new Date().toISOString());
  const bindings = opts.bindings ?? {};

  function log(lvl: Exclude<LogLevel, "silent">, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[lvl] < min) return;
    try {
      const merged = { ...bindings, ...(data ?? {}) };
      const safeData = redactor ? redactor.redactObject(merged) : merged;
      const safeMsg = redactor ? redactor.redactString(String(msg)) : String(msg);
      if (opts.json) {
        write(`${JSON.stringify({ level: lvl, time: now(), msg: safeMsg, ...safeData })}\n`);
      } else {
        const kv = Object.entries(safeData)
          .map(([k, v]) => `${k}=${fmtValue(v)}`)
          .join(" ");
        const ts = opts.timestamps ? `${now()} ` : "";
        write(`${ts}${lvl.toUpperCase().padEnd(5)} ${safeMsg}${kv ? ` ${kv}` : ""}\n`);
      }
    } catch {
      // logging must never throw into callers
    }
  }

  return {
    trace: (m, d) => log("trace", m, d),
    debug: (m, d) => log("debug", m, d),
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
    child: (b) => createLogger({ ...opts, redact: redactor ?? false, bindings: { ...bindings, ...b } }),
  };
}

/** Collects log records in memory (for tests). */
export function createMemoryLogger(level: LogLevel = "trace"): Logger & {
  records: Array<{ level: string; msg: string; [k: string]: unknown }>;
} {
  const records: Array<{ level: string; msg: string; [k: string]: unknown }> = [];
  const logger = createLogger({
    level,
    json: true,
    write: (line) => records.push(JSON.parse(line)),
  });
  return Object.assign(logger, { records });
}
