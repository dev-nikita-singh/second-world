/**
 * Guaranteed fault revert. See docs/03-engines/reliability-lab.md §1 ("revert() is guaranteed")
 * and docs/11-safety-security-privacy.md §1 ("Leftover faults": cleanup stack, fault TTL, watchdog,
 * `sw reliability cleanup`). Signals per docs/06-environments-and-portability.md §2 (SIGINT, SIGTERM,
 * SIGBREAK on Windows).
 *
 * Layers:
 * 1. `CleanupStack` (LIFO). Engines push a revert per applied fault and run it in `finally`.
 * 2. A process-global stack with signal / uncaught-exception hooks, installed only while non-empty.
 * 3. Per-fault TTL timers (`armTtl`) that auto-revert in-process.
 * 4. For faults that outlive the process (Docker, Toxiproxy): a persistent ledger of serialisable
 *    revert actions (`cleanupAll()` replays it from a fresh process) and an optional detached
 *    watchdog process that runs the revert actions after the TTL even if this process crashed, and
 *    then clears its own ledger entry (only when every action succeeded or was already done).
 *
 * Ledger writes are atomic and serialised: every read-modify-write holds `<ledger>.lock` (created
 * with O_EXCL; a lock older than LEDGER_LOCK_STALE_MS is a crashed writer's and is broken) and
 * replaces the file by writing a uniquely named temp file and renaming it over the ledger (retried on
 * transient Windows EPERM/EACCES/EBUSY). Readers never see a torn file and concurrent writers
 * (engine processes, `sw reliability cleanup`, watchdogs) never lose each other's entries.
 * (Lock-free temp+rename alone lost 58 of 80 entries with 4 concurrent writer processes.)
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type CleanupFn = () => Promise<void> | void;

interface Entry {
  id: number;
  name: string;
  fn: CleanupFn;
  /** Best-effort synchronous variant used from the uncaught-exception monitor. */
  sync?: () => void;
}

export interface CleanupError {
  name: string;
  error: unknown;
}

/** LIFO stack of cleanup callbacks. Each entry runs at most once. */
export class CleanupStack {
  private entries: Entry[] = [];
  private seq = 0;
  private readonly onChange: (() => void) | undefined;

  constructor(onChange?: () => void) {
    this.onChange = onChange;
  }

  get size(): number {
    return this.entries.length;
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** Registers a callback; returns an unregister function (call it after a successful manual revert). */
  push(name: string, fn: CleanupFn, sync?: () => void): () => void {
    const id = ++this.seq;
    this.entries.push({ id, name, fn, ...(sync ? { sync } : {}) });
    this.onChange?.();
    return () => {
      const i = this.entries.findIndex((e) => e.id === id);
      if (i >= 0) {
        this.entries.splice(i, 1);
        this.onChange?.();
      }
    };
  }

  /** Runs every callback in LIFO order; never throws, returns the errors. */
  async runAll(): Promise<CleanupError[]> {
    const errors: CleanupError[] = [];
    while (this.entries.length > 0) {
      const e = this.entries.pop() as Entry;
      this.onChange?.();
      try {
        await e.fn();
      } catch (error) {
        errors.push({ name: e.name, error });
      }
    }
    return errors;
  }

  /** Synchronous best effort (crash path): runs `sync` variants only. */
  runAllSync(): void {
    while (this.entries.length > 0) {
      const e = this.entries.pop() as Entry;
      try {
        e.sync?.();
      } catch {
        // crash path: nothing else we can do
      }
    }
    this.onChange?.();
  }
}

// ---------------------------------------------------------------- process-global stack + hooks

const SIGNALS: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  ...(process.platform === "win32" ? (["SIGBREAK"] as NodeJS.Signals[]) : []),
];
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };

let hooksInstalled = false;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function onCrash(): void {
  globalStack.runAllSync();
}

function onSignal(sig: NodeJS.Signals): void {
  // If we are the only listener, Node would otherwise not exit: clean up, then exit with 128+n.
  const alone = process.listenerCount(sig) <= 1;
  const timer = setTimeout(() => {
    if (alone) process.exit(SIGNAL_EXIT[sig] ?? 1);
  }, 5000);
  timer.unref();
  void globalStack.runAll().finally(() => {
    clearTimeout(timer);
    if (alone) {
      uninstallHooks();
      process.exit(SIGNAL_EXIT[sig] ?? 1);
    }
  });
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const sig of SIGNALS) {
    const h = (): void => onSignal(sig);
    signalHandlers.set(sig, h);
    process.on(sig, h);
  }
  // Monitor does not swallow the exception (default crash behaviour is preserved).
  process.on("uncaughtExceptionMonitor", onCrash);
  process.on("exit", onCrash);
}

function uninstallHooks(): void {
  if (!hooksInstalled) return;
  hooksInstalled = false;
  for (const [sig, h] of signalHandlers) process.off(sig, h);
  signalHandlers.clear();
  process.off("uncaughtExceptionMonitor", onCrash);
  process.off("exit", onCrash);
}

function syncHooks(): void {
  if (globalStack.size > 0) installHooks();
  else uninstallHooks();
}

const globalStack: CleanupStack = new CleanupStack(() => syncHooks());

/**
 * Registers a revert on the process-global stack (runs on SIGINT/SIGTERM/SIGBREAK, crash, exit,
 * and `cleanupAll()`). Returns an unregister function.
 */
export function registerGlobalCleanup(name: string, fn: CleanupFn, sync?: () => void): () => void {
  return globalStack.push(name, fn, sync);
}

/** Names of reverts currently registered globally (for diagnostics / tests). */
export function pendingGlobalCleanups(): string[] {
  return globalStack.names();
}

/** True while signal/crash hooks are installed (only when something needs reverting). */
export function cleanupHooksInstalled(): boolean {
  return hooksInstalled;
}

/** Arms an in-process TTL: calls `revert` after `ttlMs` unless disarmed. Timer is unref'd. */
export function armTtl(ttlMs: number, revert: () => Promise<void> | void): () => void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return () => {};
  const t = setTimeout(() => {
    void Promise.resolve()
      .then(revert)
      .catch(() => {});
  }, ttlMs);
  t.unref();
  return () => clearTimeout(t);
}

// ---------------------------------------------------------------- serialisable revert actions + ledger

export type RevertAction =
  | { kind: "http"; method: "DELETE" | "POST"; url: string; body?: unknown }
  | {
      kind: "exec";
      file: string;
      args: string[];
      /**
       * Regex (source, case-insensitive) of error output meaning "already reverted" (e.g. docker
       * "is not paused"): such a failure counts as success, so a ledger entry whose fault was already
       * reverted (by the watchdog, an operator, a restart) is cleared instead of failing forever.
       */
      alreadyDone?: string;
    };

export interface LedgerEntry {
  id: string;
  injector: string;
  description: string;
  createdAt: string;
  /** Epoch ms after which the fault must be reverted. */
  expiresAt: number;
  pid: number;
  actions: RevertAction[];
}

export function defaultLedgerPath(): string {
  return process.env.SW_FAULT_LEDGER ?? join(tmpdir(), "second-world", "fault-ledger.json");
}

export function readLedger(path = defaultLedgerPath()): LedgerEntry[] {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(v) ? (v as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** How long a ledger rename/read keeps retrying transient Windows sharing errors. */
const FS_RETRY_BUDGET_MS = 5_000;
/** How long a writer waits for the ledger lock before breaking it as stale. */
export const LEDGER_LOCK_STALE_MS = 10_000;
let tmpSeq = 0;

function pause(i: number): void {
  Atomics.wait(sleepBuf, 0, 0, Math.min(1 + i, 20));
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | undefined)?.code ?? "";
}

/**
 * Read inside the lock: a missing file is empty; transient sharing errors are retried; an unparsable
 * file (never written by this code: writes are atomic) is moved aside to `<path>.corrupt` instead of
 * being silently overwritten.
 */
function readLedgerLocked(path: string): LedgerEntry[] {
  const deadline = performance.now() + FS_RETRY_BUDGET_MS;
  for (let i = 0; ; i++) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      if (errCode(e) === "ENOENT") return [];
      if (RETRY_CODES.has(errCode(e)) && performance.now() < deadline) {
        pause(i);
        continue;
      }
      throw e;
    }
    try {
      const v = JSON.parse(raw) as unknown;
      if (Array.isArray(v)) return v as LedgerEntry[];
    } catch {
      // fall through
    }
    renameSync(path, `${path}.corrupt`);
    return [];
  }
}

/** Atomic replace: unique temp file + rename (retried on transient Windows sharing errors). */
function writeLedger(entries: LedgerEntry[], path: string): void {
  if (entries.length === 0) {
    rmSync(path, { force: true, maxRetries: 20, retryDelay: 10 });
    return;
  }
  const tmp = `${path}.${process.pid}-${++tmpSeq}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  const deadline = performance.now() + FS_RETRY_BUDGET_MS;
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      // Windows: replacing a file another process has open fails transiently.
      if (RETRY_CODES.has(errCode(e)) && performance.now() < deadline) {
        pause(i);
        continue;
      }
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}

/**
 * Runs `fn` holding `<path>.lock` (created with O_EXCL, atomic on every OS). Writers hold it for a
 * read + write (milliseconds); a lock older than LEDGER_LOCK_STALE_MS is left by a crashed writer and
 * is broken. The same protocol is implemented by the watchdog script.
 */
function withLedgerLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST" && !RETRY_CODES.has(errCode(e))) throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LEDGER_LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // lock vanished meanwhile: retry at once
        continue;
      }
      pause(i);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true, maxRetries: 20, retryDelay: 10 });
  }
}

/** Read → mutate → atomic write, under the ledger lock. `mutate` returns null for "nothing to do". */
function mutateLedger(path: string, mutate: (all: LedgerEntry[]) => LedgerEntry[] | null): void {
  withLedgerLock(path, () => {
    const next = mutate(readLedgerLocked(path));
    if (next !== null) writeLedger(next, path);
  });
}

export function ledgerAdd(entry: LedgerEntry, path = defaultLedgerPath()): void {
  mutateLedger(path, (all) => [...all.filter((e) => e.id !== entry.id), entry]);
}

/** Removes entry `id` (only the one created at `createdAt`, when given). */
export function ledgerRemove(id: string, path = defaultLedgerPath(), createdAt?: string): void {
  const match = (e: LedgerEntry) => e.id === id && (createdAt === undefined || e.createdAt === createdAt);
  mutateLedger(path, (all) => (all.some(match) ? all.filter((e) => !match(e)) : null));
}

/** Executes one revert action (async). Throws on failure. */
export async function runRevertAction(a: RevertAction, timeoutMs = 10_000): Promise<void> {
  if (a.kind === "http") {
    const res = await fetch(a.url, {
      method: a.method,
      ...(a.body !== undefined
        ? { body: JSON.stringify(a.body), headers: { "content-type": "application/json" } }
        : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    // 404 = already gone: fine.
    if (!res.ok && res.status !== 404) throw new Error(`${a.method} ${a.url} → HTTP ${res.status}`);
    return;
  }
  const { execa } = await import("execa");
  try {
    await execa(a.file, a.args, { timeout: timeoutMs, reject: true, windowsHide: true, stdin: "ignore" });
  } catch (e) {
    if (a.alreadyDone && new RegExp(a.alreadyDone, "i").test(e instanceof Error ? e.message : String(e)))
      return;
    throw e;
  }
}

/** Synchronous best-effort revert (crash path). Only exec actions can run synchronously. */
export function runRevertActionSync(a: RevertAction): void {
  if (a.kind === "exec") spawnSync(a.file, a.args, { timeout: 10_000, stdio: "ignore", windowsHide: true });
}

/** Ledger entry a watchdog clears after a successful revert. */
export interface WatchdogLedgerRef {
  path: string;
  id: string;
  /** Only the entry with this createdAt is removed (a re-applied fault with the same id is kept). */
  createdAt: string;
}

/**
 * Body of the detached watchdog (plain JS for `node -e`; argv: actions JSON, ttlMs, ledger ref JSON
 * or ""). Runs every revert action after the TTL; when all succeeded (or were already done: HTTP
 * 404, exec output matching `alreadyDone`) it removes its own ledger entry with the same lock +
 * temp-file + rename protocol as {@link ledgerRemove}. A failed action leaves the entry for
 * `sw reliability cleanup`.
 */
export const WATCHDOG_SCRIPT = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const crypto = require("node:crypto");
const actions = JSON.parse(process.argv[1]);
const ttl = Number(process.argv[2]);
const ref = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const pause = new Int32Array(new SharedArrayBuffer(4));
const RETRY = ["EPERM", "EACCES", "EBUSY"];
const wait = (i) => Atomics.wait(pause, 0, 0, Math.min(1 + i, 20));
function read(p) {
  const deadline = performance.now() + 5000;
  for (let i = 0; ; i++) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!Array.isArray(v)) throw new Error("ledger is not an array");
      return v;
    } catch (e) {
      if (e && e.code === "ENOENT") return [];
      if (RETRY.includes(e && e.code) && performance.now() < deadline) { wait(i); continue; }
      throw e; // unreadable / corrupt: leave it for sw reliability cleanup
    }
  }
}
function write(p, entries) {
  if (entries.length === 0) { fs.rmSync(p, { force: true, maxRetries: 20, retryDelay: 10 }); return; }
  const tmp = p + "." + process.pid + "-wd-" + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  const deadline = performance.now() + 5000;
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, p); return; } catch (e) {
      if (RETRY.includes(e && e.code) && performance.now() < deadline) { wait(i); continue; }
      fs.rmSync(tmp, { force: true }); throw e;
    }
  }
}
function withLock(p, fn) {
  const lock = p + ".lock";
  for (let i = 0; ; i++) {
    try { const fd = fs.openSync(lock, "wx"); try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (!(e && (e.code === "EEXIST" || RETRY.includes(e.code)))) throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > ${LEDGER_LOCK_STALE_MS}) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      wait(i);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true, maxRetries: 20, retryDelay: 10 }); }
}
function clearEntry() {
  const match = (e) => e && e.id === ref.id && e.createdAt === ref.createdAt;
  withLock(ref.path, () => {
    const all = read(ref.path);
    if (all.some(match)) write(ref.path, all.filter((e) => !match(e)));
  });
}
setTimeout(async () => {
  let ok = true;
  for (const a of actions) {
    try {
      if (a.kind === "http") {
        const res = await fetch(a.url, { method: a.method, body: a.body === undefined ? undefined : JSON.stringify(a.body),
          headers: a.body === undefined ? undefined : { "content-type": "application/json" }, signal: AbortSignal.timeout(10000) });
        await res.arrayBuffer();
        if (!res.ok && res.status !== 404) ok = false;
      } else {
        const r = spawnSync(a.file, a.args, { timeout: 10000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true });
        if (r.status !== 0) {
          const out = String(r.stderr || "") + String(r.stdout || "") + (r.error ? String(r.error) : "");
          if (!(a.alreadyDone && new RegExp(a.alreadyDone, "i").test(out))) ok = false;
        }
      }
    } catch { ok = false; }
  }
  if (ok && ref) { try { clearEntry(); } catch {} }
  process.exit(0);
}, ttl);`;

/**
 * Spawns a detached watchdog process that runs `actions` after `ttlMs`, surviving a crash of this
 * process, then clears its own ledger entry (`ledger`) when every action succeeded. Returns a disarm
 * function (kills the watchdog). Errors in the watchdog are ignored.
 */
export function spawnWatchdog(
  ttlMs: number,
  actions: RevertAction[],
  ledger?: WatchdogLedgerRef,
): () => void {
  try {
    const child = spawn(
      process.execPath,
      [
        "-e",
        WATCHDOG_SCRIPT,
        JSON.stringify(actions),
        String(Math.max(0, Math.round(ttlMs))),
        ledger ? JSON.stringify(ledger) : "",
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.on("error", () => {});
    child.unref();
    return () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
  } catch {
    return () => {};
  }
}

export interface CleanupAllResult {
  /** In-process reverts that ran. */
  inProcess: number;
  /** Ledger entries replayed (faults left by this or a crashed process). */
  ledger: number;
  errors: { name: string; message: string }[];
}

/**
 * Reverts everything: the in-process global stack, then every ledger entry (e.g. Docker containers
 * paused by a crashed run, Toxiproxy toxics). Backs `sw reliability cleanup`.
 */
export async function cleanupAll(opts: { ledgerPath?: string } = {}): Promise<CleanupAllResult> {
  const path = opts.ledgerPath ?? defaultLedgerPath();
  const inProcess = globalStack.size;
  const errs = await globalStack.runAll();
  const errors = errs.map((e) => ({
    name: e.name,
    message: e.error instanceof Error ? e.error.message : String(e.error),
  }));
  const entries = readLedger(path);
  let ledger = 0;
  for (const e of entries) {
    let ok = true;
    for (const a of e.actions) {
      try {
        await runRevertAction(a);
      } catch (err) {
        ok = false;
        errors.push({
          name: `${e.injector}:${e.id}`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (ok) ledgerRemove(e.id, path, e.createdAt);
    ledger++;
  }
  return { inProcess, ledger, errors };
}
