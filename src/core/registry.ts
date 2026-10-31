/**
 * Lazy engine registry. See docs/02-architecture.md §4.1.
 * Built-in engines are loaded with dynamic import() on first use, so `sw --help` and
 * `world.performance` never pull in unrelated engines (TypeScript compiler, git, ...).
 */
import { CapabilityError, EngineError } from "./errors.js";
import type { EngineId } from "./evidence/schemas.js";
import type { Engine } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: engines are heterogeneous
export type AnyEngine = Engine<any, any>;
export type EngineLoader = () => Promise<unknown>;

/** Built-in loaders. Paths are relative to this file (src/core → src/engines). */
export const BUILTIN_ENGINES: Partial<Record<EngineId, EngineLoader>> = {
  performance: () => import("../engines/performance/index.js"),
  stress: () => import("../engines/stress/index.js"),
  architecture: () => import("../engines/architecture/index.js"),
  bugs: () => import("../engines/bugs/index.js"),
  reliability: () => import("../engines/reliability/index.js"),
  whatif: () => import("../engines/experiments/index.js"),
  evolution: () => import("../engines/experiments/index.js"),
  model: () => import("../engines/model/index.js"),
  agent: () => import("../engines/agent/index.js"),
};

function isEngine(v: unknown, id?: string): v is AnyEngine {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<AnyEngine>;
  return typeof e.run === "function" && typeof e.id === "string" && (id === undefined || e.id === id);
}

/** Picks the Engine out of a module namespace: `<id>Engine`, `engine`, `default`, or any export with matching id. */
export function engineFromModule(mod: unknown, id: string): AnyEngine | undefined {
  if (isEngine(mod, id)) return mod;
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as Record<string, unknown>;
  for (const key of [`${id}Engine`, "engine", "default"]) if (isEngine(m[key], id)) return m[key];
  for (const v of Object.values(m)) if (isEngine(v, id)) return v;
  return undefined;
}

export interface EngineRegistry {
  register(id: string, loaderOrEngine: EngineLoader | AnyEngine): void;
  has(id: string): boolean;
  ids(): string[];
  /** Loads (once) and returns the engine; also returns the raw module for extra exports. */
  load(id: string): Promise<{ engine: AnyEngine; module: unknown }>;
  isLoaded(id: string): boolean;
}

export function createRegistry(
  builtins: Partial<Record<string, EngineLoader>> = BUILTIN_ENGINES,
): EngineRegistry {
  const loaders = new Map<string, EngineLoader>();
  for (const [k, v] of Object.entries(builtins)) if (v) loaders.set(k, v);
  const cache = new Map<string, Promise<{ engine: AnyEngine; module: unknown }>>();

  return {
    register(id, le) {
      cache.delete(id);
      loaders.set(id, isEngine(le) ? async () => le : (le as EngineLoader));
    },
    has: (id) => loaders.has(id),
    ids: () => [...loaders.keys()],
    isLoaded: (id) => cache.has(id),
    load(id) {
      const hit = cache.get(id);
      if (hit) return hit;
      const loader = loaders.get(id);
      if (!loader) {
        return Promise.reject(
          new CapabilityError("SW_CAP_ENGINE_UNAVAILABLE", `Engine "${id}" is not available in this build`, {
            hint: `Available engines: ${[...loaders.keys()].join(", ") || "(none)"}`,
          }),
        );
      }
      const p = (async () => {
        let mod: unknown;
        try {
          mod = await loader();
        } catch (e) {
          throw new EngineError("SW_ENGINE_LOAD", `Failed to load engine "${id}": ${(e as Error).message}`, {
            cause: e,
          });
        }
        const engine = engineFromModule(mod, id);
        if (!engine)
          throw new EngineError("SW_ENGINE_LOAD", `Module for engine "${id}" does not export an Engine`);
        return { engine, module: mod };
      })();
      cache.set(id, p);
      p.catch(() => cache.delete(id));
      return p;
    },
  };
}
