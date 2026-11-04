/**
 * Plugin lifecycle hooks (docs/10-plugins-and-extensibility.md §2). Hooks are observers: handlers run
 * one after another in plugin load order; a throwing or hanging handler (bounded by HOOK_TIMEOUT_MS)
 * never fails the run. Its error is wrapped with the plugin name and returned as a HookFailure, which
 * the world logs as a warning and records as a `PLUGIN_HOOK_FAILED` limitation.
 */
import type { PluginHookEvent, PluginHookHandler, PluginHookPayloads } from "./types.js";

export const HOOK_TIMEOUT_MS = 30_000;

export interface HookFailure {
  plugin: string;
  event: PluginHookEvent;
  message: string;
}

export interface HookRunner {
  on(plugin: string, event: PluginHookEvent, fn: PluginHookHandler): void;
  has(event: PluginHookEvent): boolean;
  /** Events with at least one handler, per plugin. */
  eventsOf(plugin: string): PluginHookEvent[];
  run<E extends PluginHookEvent>(event: E, payload: PluginHookPayloads[E]): Promise<HookFailure[]>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export function createHookRunner(opts: { timeoutMs?: number } = {}): HookRunner {
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  const handlers: { plugin: string; event: PluginHookEvent; fn: PluginHookHandler }[] = [];
  return {
    on(plugin, event, fn) {
      handlers.push({ plugin, event, fn });
    },
    has: (event) => handlers.some((h) => h.event === event),
    eventsOf: (plugin) => [...new Set(handlers.filter((h) => h.plugin === plugin).map((h) => h.event))],
    async run(event, payload) {
      const failures: HookFailure[] = [];
      for (const h of handlers) {
        if (h.event !== event) continue;
        try {
          await withTimeout(
            Promise.resolve().then(() => (h.fn as PluginHookHandler<typeof event>)(payload)),
            timeoutMs,
            `hook ${event}`,
          );
        } catch (e) {
          failures.push({
            plugin: h.plugin,
            event,
            message: `plugin "${h.plugin}" hook ${event} failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      return failures;
    },
  };
}
