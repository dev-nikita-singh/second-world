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
 *    watchdog process that runs the revert actions after the TTL even if this process crashed.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function writeLedger(entries: LedgerEntry[], path: string): void {
  if (entries.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, path);
}

export function ledgerAdd(entry: LedgerEntry, path = defaultLedgerPath()): void {
  const all = readLedger(path).filter((e) => e.id !== entry.id);
  all.push(entry);
  writeLedger(all, path);
}

export function ledgerRemove(id: string, path = defaultLedgerPath()): void {
  const all = readLedger(path);
  const next = all.filter((e) => e.id !== id);
  if (next.length !== all.length) writeLedger(next, path);
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

/**
 * Spawns a detached watchdog process that runs `actions` after `ttlMs`, surviving a crash of this
 * process. Returns a disarm function (kills the watchdog). Errors in the watchdog are ignored.
 */
export function spawnWatchdog(ttlMs: number, actions: RevertAction[]): () => void {
  const script = `
const actions = JSON.parse(process.argv[1]);
const { spawnSync } = require("node:child_process");
setTimeout(async () => {
  for (const a of actions) {
    try {
      if (a.kind === "http") {
        await fetch(a.url, { method: a.method, body: a.body === undefined ? undefined : JSON.stringify(a.body),
          headers: a.body === undefined ? undefined : { "content-type": "application/json" }, signal: AbortSignal.timeout(10000) });
      } else {
        spawnSync(a.file, a.args, { timeout: 10000, stdio: "ignore", windowsHide: true });
      }
    } catch {}
  }
  process.exit(0);
}, ${Math.max(0, Math.round(ttlMs))});`;
  try {
    const child = spawn(process.execPath, ["-e", script, JSON.stringify(actions)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
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
    if (ok) ledgerRemove(e.id, path);
    ledger++;
  }
  return { inProcess, ledger, errors };
}
