/**
 * Base for injectors whose faults live outside this process (Toxiproxy, Docker).
 * See docs/03-engines/reliability-lab.md §1 and docs/11-safety-security-privacy.md §1.
 *
 * A fault is expressed as serialisable apply/revert actions, so the revert can be:
 * run in-process (manual revert, TTL, abort signal, global cleanup stack on signals),
 * persisted in the ledger (`cleanupAll()` from a fresh process after a crash), and
 * executed by a detached watchdog process after the TTL (crash-safe auto-revert).
 * Flapping is emulated by toggling apply/revert on a timer.
 */
import {
  armTtl,
  defaultLedgerPath,
  ledgerAdd,
  ledgerRemove,
  type RevertAction,
  registerGlobalCleanup,
  runRevertAction,
  runRevertActionSync,
  spawnWatchdog,
} from "./cleanup.js";
import {
  type AppliedFault,
  describeFault,
  type Fault,
  type FaultInjector,
  type FaultInput,
  type InjectorCapabilities,
  parseFault,
} from "./types.js";

export type Action = RevertAction;

export interface ExternalInjectorOptions {
  /** Ledger file (default: SW_FAULT_LEDGER or <tmp>/second-world/fault-ledger.json). */
  ledgerPath?: string;
  /** Spawn a detached watchdog that reverts after the TTL even if this process crashes. Default true. */
  watchdog?: boolean;
  /** TTL applied when the fault has none (ms). Default 10 minutes. */
  defaultTtlMs?: number;
  /** Executes an action (tests inject a fake). Default: runRevertAction. */
  exec?: (a: Action) => Promise<void>;
  now?: () => number;
}

interface Live {
  id: string;
  fault: Fault;
  appliedAt: number;
  revertActions: Action[];
  dispose: (() => void)[];
  stopFlap?: () => void;
  on: boolean;
}

export abstract class ExternalInjectorBase implements FaultInjector {
  abstract readonly name: string;
  protected readonly opts: ExternalInjectorOptions;
  private readonly live = new Map<string, Live>();
  private seq = 0;

  constructor(opts: ExternalInjectorOptions = {}) {
    this.opts = opts;
  }

  abstract capabilities(): Promise<InjectorCapabilities>;
  /** Actions that apply the fault. */
  protected abstract applyActions(fault: Fault, id: string): Promise<Action[]> | Action[];
  /** Actions that revert it (must be idempotent and safe to run when not applied). */
  protected abstract revertActions(fault: Fault, id: string): Action[];

  /** Executes an action; `phase` lets subclasses tolerate "already reverted" errors on revert only. */
  protected exec(a: Action, _phase: "apply" | "revert" = "revert"): Promise<void> {
    return (this.opts.exec ?? runRevertAction)(a);
  }

  private now(): number {
    return this.opts.now?.() ?? performance.now();
  }

  async apply(input: FaultInput | Fault, signal?: AbortSignal): Promise<AppliedFault> {
    const fault = parseFault(input);
    const caps = await this.capabilities();
    if (!caps.available) throw new Error(`${this.name} unavailable: ${caps.reason ?? "unknown"}`);
    if (!caps.faults.includes(fault.type))
      throw new Error(`${this.name} does not support fault "${fault.type}"`);
    if (fault.percent < 100 && !caps.partial) throw new Error(`${this.name} does not support partial faults`);
    const id = fault.id ?? `sw-${process.pid}-${++this.seq}`;
    if (this.live.has(id)) await this.revert(id);
    const revertActions = this.revertActions(fault, id);
    const ttl = fault.ttlMs ?? this.opts.defaultTtlMs ?? 600_000;
    const l: Live = { id, fault, appliedAt: this.now(), revertActions, dispose: [], on: false };
    this.live.set(id, l);

    // Persist the revert before touching anything, so a crash mid-apply is still recoverable.
    const ledgerPath = this.opts.ledgerPath ?? defaultLedgerPath();
    const createdAt = new Date().toISOString();
    ledgerAdd(
      {
        id,
        injector: this.name,
        description: describeFault(fault),
        createdAt,
        expiresAt: Date.now() + ttl,
        pid: process.pid,
        actions: revertActions,
      },
      ledgerPath,
    );
    l.dispose.push(() => ledgerRemove(id, ledgerPath, createdAt));
    l.dispose.push(
      registerGlobalCleanup(
        `${this.name}:${id}`,
        () => this.revert(id),
        () => {
          for (const a of revertActions) runRevertActionSync(a);
        },
      ),
    );
    if (this.opts.watchdog !== false)
      l.dispose.push(spawnWatchdog(ttl, revertActions, { path: ledgerPath, id, createdAt }));
    l.dispose.push(armTtl(ttl, () => this.revert(id)));
    if (signal) {
      const onAbort = (): void => void this.revert(id);
      if (signal.aborted) {
        await this.revert(id);
        throw new Error("aborted");
      }
      signal.addEventListener("abort", onAbort, { once: true });
      l.dispose.push(() => signal.removeEventListener("abort", onAbort));
    }

    try {
      await this.turnOn(l);
    } catch (e) {
      await this.revert(id);
      throw e;
    }
    if (fault.flapping) {
      const { onMs, offMs } = fault.flapping;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const tick = (): void => {
        if (stopped || !this.live.has(id)) return;
        const next = l.on ? this.turnOff(l) : this.turnOn(l);
        void next
          .catch(() => {})
          .finally(() => {
            if (stopped) return;
            timer = setTimeout(tick, l.on ? onMs : offMs);
            timer.unref();
          });
      };
      timer = setTimeout(tick, onMs);
      timer.unref();
      l.stopFlap = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    }
    return { id, fault, appliedAt: l.appliedAt, revert: () => this.revert(id) };
  }

  private async turnOn(l: Live): Promise<void> {
    for (const a of await this.applyActions(l.fault, l.id)) await this.exec(a, "apply");
    l.on = true;
  }

  private async turnOff(l: Live): Promise<void> {
    for (const a of l.revertActions) await this.exec(a);
    l.on = false;
  }

  async revert(id?: string): Promise<void> {
    const ids = id === undefined ? [...this.live.keys()] : [id];
    const errors: unknown[] = [];
    for (const fid of ids) {
      const l = this.live.get(fid);
      if (!l) continue;
      // stop flapping first, then revert, then drop ledger/watchdog/cleanup registrations
      l.stopFlap?.();
      try {
        for (const a of l.revertActions) await this.exec(a);
      } catch (e) {
        errors.push(e);
        continue; // keep the entry + ledger so a later revert / `cleanupAll()` can retry
      }
      this.live.delete(fid);
      for (const d of l.dispose) d();
    }
    if (errors.length > 0) throw errors[0];
  }

  active(): string[] {
    return [...this.live.keys()];
  }

  async close(): Promise<void> {
    await this.revert();
  }
}
