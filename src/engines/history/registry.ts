/**
 * History backend registry: lets plugins contribute a `HistoryStore` (docs/10-plugins-and-extensibility.md,
 * CONTRACTS.md "sw-sqlite-w9"). `createHistoryStore({ backend: "<name>" })` resolves a registered name.
 * Built-in names ("jsonl", "sqlite") are reserved; a second registration of a name is an error.
 */
import type { LockOptions } from "./fsutil.js";
import { HistoryError, type HistoryStore } from "./store.js";

export interface HistoryStoreFactoryOptions {
  /** Project root. */
  cwd: string;
  /** Resolved history directory (`history.dir`); the store may ignore it. */
  dir: string;
  captureGit?: boolean;
  newId?: () => string;
  isoNow?: () => string;
  lock?: LockOptions;
  onWarning?: (message: string) => void;
  /** Free-form options for the plugin store (passed through unchanged). */
  options?: Record<string, unknown>;
}

export type HistoryStoreFactory = (opts: HistoryStoreFactoryOptions) => HistoryStore | Promise<HistoryStore>;

export const BUILTIN_HISTORY_BACKENDS = ["jsonl", "sqlite"] as const;
const NAME = /^[a-z0-9@][a-z0-9._\-/@]{0,99}$/i;

const backends = new Map<string, HistoryStoreFactory>();

/** Registers a history backend; returns a function that unregisters it. */
export function registerHistoryBackend(name: string, factory: HistoryStoreFactory): () => void {
  if (!NAME.test(name))
    throw new HistoryError("SW_HISTORY_BACKEND", `Invalid history backend name "${name}"`);
  if ((BUILTIN_HISTORY_BACKENDS as readonly string[]).includes(name))
    throw new HistoryError(
      "SW_HISTORY_BACKEND",
      `History backend "${name}" is built in and cannot be replaced`,
    );
  if (backends.has(name))
    throw new HistoryError("SW_HISTORY_BACKEND", `History backend "${name}" is already registered`);
  if (typeof factory !== "function")
    throw new HistoryError("SW_HISTORY_BACKEND", `History backend "${name}": factory must be a function`);
  backends.set(name, factory);
  return () => {
    if (backends.get(name) === factory) backends.delete(name);
  };
}

export function getHistoryBackend(name: string): HistoryStoreFactory | undefined {
  return backends.get(name);
}

/** Built-in and registered backend names. */
export function listHistoryBackends(): string[] {
  return [...BUILTIN_HISTORY_BACKENDS, ...[...backends.keys()].sort()];
}
