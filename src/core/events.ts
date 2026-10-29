/**
 * Typed, synchronous-dispatch event bus. See docs/02-architecture.md §4.3.
 * Listener errors (sync throws or rejected promises) are isolated and logged,
 * never thrown into the emitter. A "*" listener receives every event as (payload, eventName).
 */
import { silentLogger } from "./log/logger.js";
import type { EventBus, Logger } from "./types.js";

type Listener = (payload: unknown, event?: string) => void;

export interface TypedEventBus<M extends Record<string, unknown> = Record<string, unknown>> extends EventBus {
  emit<K extends keyof M & string>(event: K, payload: M[K]): void;
  emit(event: string, payload: unknown): void;
  on<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): () => void;
  on(event: string, listener: (payload: unknown, event?: string) => void): () => void;
  once<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): () => void;
  once(event: string, listener: (payload: unknown, event?: string) => void): () => void;
  listenerCount(event?: string): number;
  clear(): void;
}

export function createEventBus<M extends Record<string, unknown> = Record<string, unknown>>(
  opts: { log?: Logger } = {},
): TypedEventBus<M> {
  const log = opts.log ?? silentLogger;
  const map = new Map<string, Set<Listener>>();

  function report(event: string, err: unknown): void {
    log.error("event listener failed", { event, error: err instanceof Error ? err.message : String(err) });
  }

  function call(l: Listener, payload: unknown, event: string): void {
    try {
      const r = l(payload, event) as unknown;
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).then(undefined, (e: unknown) => report(event, e));
      }
    } catch (e) {
      report(event, e);
    }
  }

  function on(event: string, listener: Listener): () => void {
    let set = map.get(event);
    if (!set) {
      set = new Set();
      map.set(event, set);
    }
    set.add(listener);
    return () => {
      const s = map.get(event);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) map.delete(event);
    };
  }

  const bus = {
    emit(event: string, payload: unknown): void {
      const set = map.get(event);
      if (set) for (const l of [...set]) call(l, payload, event);
      if (event !== "*") {
        const all = map.get("*");
        if (all) for (const l of [...all]) call(l, payload, event);
      }
    },
    on,
    once(event: string, listener: Listener): () => void {
      const off = on(event, (p, e) => {
        off();
        listener(p, e);
      });
      return off;
    },
    listenerCount(event?: string): number {
      if (event !== undefined) return map.get(event)?.size ?? 0;
      let n = 0;
      for (const s of map.values()) n += s.size;
      return n;
    },
    clear(): void {
      map.clear();
    },
  };
  return bus as TypedEventBus<M>;
}
