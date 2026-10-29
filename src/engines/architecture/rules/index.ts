/**
 * Built-in rules ARCH001–ARCH012 — docs/03-engines/architecture-inspector.md §4.
 * Language-agnostic: they read FileFacts (incl. adapter RuleHits) and the component graph.
 * Plugin rules implement the same `ArchRule` interface (docs/10-plugins-and-extensibility.md §2:
 * "`checkGraph(graph)`"); AST-level plugin rules are written with `defineTsRule` (analyzer/ts).
 */
import type { Category, Severity } from "../../../core/evidence/schemas.js";
import { findModuleCycles, importLocation } from "../analyses.js";
import { createMatcher } from "../glob.js";
import { type ArchitectureGraph, type ResolvedRoute, unitNodeId } from "../graph.js";
import type { CycleInfo, FileFacts, RuleHit, UnitFact } from "../types.js";

export interface RuleMeta {
  id: string;
  title: string;
  severity: Severity;
  category: Category;
  defaultLevel: "warn" | "error";
  docs: string;
  fix: string;
}

export interface RuleReport {
  ruleId: string;
  message: string;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  /** Enclosing symbol (fingerprint part; stable across line shifts). */
  symbol: string;
  /** Snippet used for the fingerprint (normalised). */
  snippet: string;
  confidence: number;
  severity?: Severity;
  affected?: string[];
  /** Override fingerprint parts (default: rule, file, symbol, snippet hash). */
  fingerprintParts?: string[];
  extraLocations?: { file: string; line: number; column?: number }[];
}

export interface RuleContext {
  facts: readonly FileFacts[];
  graph: ArchitectureGraph;
  routes: readonly ResolvedRoute[];
  units: ReadonlyMap<string, UnitFact & { file: string }>;
  cycles: readonly CycleInfo[];
  flags: ReadonlySet<string>;
  options: Record<string, unknown>;
  /** True when the unit runs while handling a request / message (reachable from a handler). */
  reachableFromHandler(unitId: string): boolean;
  /** Routes from which the unit is reachable (for messages). */
  routesReaching(unitId: string): string[];
}

export interface ArchRule {
  meta: RuleMeta;
  check(ctx: RuleContext): RuleReport[];
}

const DOCS = "https://second-world.dev/rules/";

export function meta(
  id: string,
  title: string,
  severity: Severity,
  category: Category,
  defaultLevel: "warn" | "error",
  fix: string,
): RuleMeta {
  return { id, title, severity, category, defaultLevel, docs: `${DOCS}${id.toLowerCase()}`, fix };
}

/** Rule that turns adapter hits with its id into reports. */
export function hitRule(
  m: RuleMeta,
  opts: {
    filter?: (h: RuleHit, ctx: RuleContext) => boolean;
    message?: (h: RuleHit, ctx: RuleContext) => string;
  } = {},
): ArchRule {
  return {
    meta: m,
    check(ctx) {
      const out: RuleReport[] = [];
      for (const f of ctx.facts) {
        for (const h of f.hits) {
          if (h.ruleId !== m.id) continue;
          if (h.requiresHandler && !ctx.reachableFromHandler(h.unit)) continue;
          if (opts.filter && !opts.filter(h, ctx)) continue;
          const r: RuleReport = {
            ruleId: m.id,
            message: opts.message ? opts.message(h, ctx) : h.message,
            file: f.file,
            line: h.line,
            column: h.column,
            symbol: h.symbol,
            snippet: h.snippet,
            confidence: h.confidence,
          };
          if (h.endLine !== undefined) r.endLine = h.endLine;
          if (h.severity) r.severity = h.severity;
          out.push(r);
        }
      }
      return out;
    },
  };
}

const viaRoutes = (ctx: RuleContext, unit: string) => {
  const rs = ctx.routesReaching(unit);
  return rs.length > 0 ? ` (reached from ${rs.slice(0, 3).join(", ")}${rs.length > 3 ? ", …" : ""})` : "";
};
const symbolOf = (unitId: string) => unitId.slice(unitId.indexOf("#") + 1);

export const ARCH001: ArchRule = {
  meta: meta(
    "ARCH001",
    "Outbound HTTP call without timeout",
    "high",
    "reliability",
    "error",
    "Pass a timeout/AbortSignal (e.g. `signal: AbortSignal.timeout(2000)` for fetch, `timeout` for axios/got)",
  ),
  check(ctx) {
    const out: RuleReport[] = [];
    for (const f of ctx.facts) {
      for (const c of f.clients) {
        if (c.kind !== "http" || c.timeout !== false) continue;
        if (c.library === "axios" && ctx.flags.has("axios.defaults.timeout")) continue;
        const weak = c.library === "undici" || c.library.startsWith("node:");
        out.push({
          ruleId: "ARCH001",
          message: `${c.detail} to "${c.target}" has no identifiable timeout or AbortSignal: a hanging dependency hangs the caller${viaRoutes(ctx, c.unit)}`,
          file: f.file,
          line: c.line,
          column: c.column,
          endLine: c.endLine,
          symbol: symbolOf(c.unit),
          snippet: c.snippet,
          confidence: weak ? 0.5 : 0.8,
          affected: [`external:${c.target}`],
        });
      }
    }
    return out;
  },
};

export const ARCH002 = hitRule(
  meta(
    "ARCH002",
    "Retry without max attempts or backoff",
    "high",
    "reliability",
    "error",
    "Cap attempts (e.g. 3) and use exponential backoff with full jitter; consider a circuit breaker",
  ),
);

export const ARCH003: ArchRule = {
  meta: meta(
    "ARCH003",
    "Module dependency cycle",
    "medium",
    "architecture",
    "warn",
    "Break the cycle: move the shared code into a third module or invert one dependency",
  ),
  check(ctx) {
    return ctx.cycles.map((c) => {
      const from = c.example[0] as string;
      const to = (c.example[1] ?? c.example[0]) as string;
      const loc = importLocation(ctx.facts, from, to) ?? { line: 1, column: 1 };
      const r: RuleReport = {
        ruleId: "ARCH003",
        message: `Import cycle: ${[...c.example, c.example[0]].join(" -> ")}${c.members.length > c.example.length ? ` (SCC of ${c.members.length} modules)` : ""}`,
        file: from,
        line: loc.line,
        column: loc.column,
        symbol: "<module>",
        snippet: c.members.join(","),
        confidence: 0.95,
        affected: c.members,
        fingerprintParts: ["ARCH003", ...c.members],
        extraLocations: c.example.slice(1).map((f, i) => {
          const next = c.example[i + 2] ?? c.example[0];
          const l = importLocation(ctx.facts, f, next as string);
          return { file: f, line: l?.line ?? 1 };
        }),
      };
      return r;
    });
  },
};

export const ARCH004 = hitRule(
  meta(
    "ARCH004",
    "Synchronous heavy work in request path",
    "medium",
    "performance",
    "warn",
    "Use the async API (e.g. crypto.pbkdf2, fs.promises.readFile) or move the work off the event loop (worker_threads)",
  ),
  {
    message: (h, ctx) => `${h.message}${viaRoutes(ctx, h.unit)}`,
  },
);

export const ARCH005: ArchRule = {
  meta: meta(
    "ARCH005",
    "Database query inside a loop (possible N+1)",
    "medium",
    "performance",
    "warn",
    "Batch the lookups (e.g. WHERE id IN (...), findMany({ where: { id: { in: ids } } })) and group in memory",
  ),
  check(ctx) {
    const out: RuleReport[] = [];
    for (const f of ctx.facts) {
      for (const c of f.clients) {
        if (c.kind !== "db" || !c.inLoop) continue;
        out.push({
          ruleId: "ARCH005",
          message: `Query ${c.detail} runs once per loop iteration (possible N+1)${viaRoutes(ctx, c.unit)}`,
          file: f.file,
          line: c.line,
          column: c.column,
          endLine: c.endLine,
          symbol: symbolOf(c.unit),
          snippet: c.snippet,
          confidence: c.heuristicTarget ? 0.6 : 0.8,
          affected: [`datastore:${c.target}`],
        });
      }
    }
    return out;
  },
};

export const ARCH006 = hitRule(
  meta(
    "ARCH006",
    "DB pool size not configured",
    "medium",
    "capacity",
    "warn",
    "Set the pool size explicitly (pg `max`, mysql2 `connectionLimit`, knex `pool`) to match the expected concurrency",
  ),
);

export const ARCH007: ArchRule = {
  meta: meta(
    "ARCH007",
    "Route without auth where sibling routes have it",
    "high",
    "security",
    "error",
    "Add the same auth middleware/guard as the sibling routes, or mark the route as intentionally public",
  ),
  check(ctx) {
    const minSiblings = typeof ctx.options.minSiblings === "number" ? ctx.options.minSiblings : 2;
    const ratio = typeof ctx.options.ratio === "number" ? ctx.options.ratio : 0.5;
    const groups = new Map<string, ResolvedRoute[]>();
    for (const r of ctx.routes) {
      const seg = r.path.split("/").filter(Boolean)[0] ?? "";
      const key = `${r.framework}|${seg}`;
      let l = groups.get(key);
      if (!l) {
        l = [];
        groups.set(key, l);
      }
      l.push(r);
    }
    const out: RuleReport[] = [];
    for (const [, rs] of groups) {
      if (rs.length < minSiblings) continue;
      const withAuth = rs.filter((r) => r.auth);
      if (withAuth.length === 0 || withAuth.length / rs.length < ratio) continue;
      for (const r of rs) {
        if (r.auth || r.public) continue;
        out.push({
          ruleId: "ARCH007",
          message: `${r.method} ${r.path} has no auth middleware/guard, but ${withAuth.length} of ${rs.length} sibling routes do (${[...new Set(withAuth.flatMap((x) => x.middlewares))].slice(0, 3).join(", ") || "auth check"})`,
          file: r.file,
          line: r.line,
          symbol: `${r.method} ${r.path}`,
          snippet: `${r.method} ${r.path}`,
          confidence: 0.6,
          affected: [r.id],
          fingerprintParts: ["ARCH007", r.file, r.method, r.path],
        });
      }
    }
    return out;
  },
};

export const ARCH008: ArchRule = {
  meta: meta(
    "ARCH008",
    "Handler depends on many external systems",
    "low",
    "architecture",
    "warn",
    "Reduce synchronous fan-out (cache, async messaging, aggregate behind one service) and add per-dependency timeouts/bulkheads",
  ),
  check(ctx) {
    const max = typeof ctx.options.max === "number" ? ctx.options.max : 4;
    const out: RuleReport[] = [];
    for (const r of ctx.routes) {
      const deps = ctx.graph.dependenciesOf(r.id, { kinds: ["datastore", "external", "cache", "queue"] });
      if (deps.length < max) continue;
      out.push({
        ruleId: "ARCH008",
        message: `${r.method} ${r.path} reaches ${deps.length} external systems: ${deps.join(", ")}`,
        file: r.file,
        line: r.line,
        symbol: `${r.method} ${r.path}`,
        snippet: deps.join(","),
        confidence: 0.7,
        affected: [r.id, ...deps],
        fingerprintParts: ["ARCH008", r.file, r.method, r.path],
      });
    }
    return out;
  },
};

export const ARCH009 = hitRule(
  meta(
    "ARCH009",
    "Unbounded in-memory cache or global collection",
    "low",
    "performance",
    "warn",
    "Bound it (LRU with max size / TTL) or evict entries; unbounded growth leaks memory under load",
  ),
);
export const ARCH010 = hitRule(
  meta(
    "ARCH010",
    "Hard-coded secret",
    "high",
    "security",
    "error",
    "Move the secret to environment/secret storage and rotate it",
  ),
);
export const ARCH011 = hitRule(
  meta(
    "ARCH011",
    "Floating promise in request path",
    "medium",
    "correctness",
    "warn",
    "await the promise, return it, or handle it explicitly (`void p.catch(log)`)",
  ),
  {
    message: (h, ctx) => `${h.message}${viaRoutes(ctx, h.unit)}`,
  },
);

export const ARCH012: ArchRule = {
  meta: meta(
    "ARCH012",
    "Layer violation",
    "low",
    "architecture",
    "warn",
    "Route the dependency through the allowed layer (e.g. controller → service → repository)",
  ),
  check(ctx) {
    const layers = ctx.options.layers as Record<string, string[]> | undefined;
    const allow = (ctx.options.allow ?? {}) as Record<string, string[]>;
    if (!layers || Object.keys(layers).length === 0) return [];
    const matchers = Object.entries(layers).map(([name, globs]) => ({ name, m: createMatcher(globs) }));
    const layerOf = (file: string) => matchers.find((x) => x.m(file))?.name;
    const out: RuleReport[] = [];
    for (const f of ctx.facts) {
      const from = layerOf(f.file);
      if (!from) continue;
      for (const i of f.imports) {
        if (!i.resolved || i.typeOnly) continue;
        const to = layerOf(i.resolved);
        if (!to || to === from) continue;
        if ((allow[from] ?? []).includes(to)) continue;
        out.push({
          ruleId: "ARCH012",
          message: `Layer "${from}" (${f.file}) must not depend on layer "${to}" (${i.resolved})`,
          file: f.file,
          line: i.line,
          column: i.column,
          symbol: "<module>",
          snippet: `${f.file}->${i.resolved}`,
          confidence: 0.9,
          affected: [f.file, i.resolved],
        });
      }
    }
    return out;
  },
};

export const BUILTIN_RULES: readonly ArchRule[] = [
  ARCH001,
  ARCH002,
  ARCH003,
  ARCH004,
  ARCH005,
  ARCH006,
  ARCH007,
  ARCH008,
  ARCH009,
  ARCH010,
  ARCH011,
  ARCH012,
];

export function buildRuleContext(
  facts: readonly FileFacts[],
  graph: ArchitectureGraph,
  routes: readonly ResolvedRoute[],
  units: ReadonlyMap<string, UnitFact & { file: string }>,
): Omit<RuleContext, "options"> {
  // units reachable from handlers/consumers (BFS over resolved calls)
  const reach = new Set<string>();
  const queue: string[] = [];
  for (const u of units.values()) if (u.kind === "handler" || u.kind === "consumer") queue.push(u.id);
  for (const r of routes) if (r.handler) queue.push(r.handler);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    if (reach.has(id)) continue;
    reach.add(id);
    for (const c of units.get(id)?.calls ?? []) if (!reach.has(c.target)) queue.push(c.target);
  }
  const flags = new Set(facts.flatMap((f) => f.flags));
  return {
    facts,
    graph,
    routes,
    units,
    cycles: findModuleCycles(facts),
    flags,
    reachableFromHandler: (id) => reach.has(id),
    routesReaching: (id) =>
      graph.impactOf(unitNodeId(id), { kinds: ["route"] }).map((r) => r.slice("route:".length)),
  };
}
