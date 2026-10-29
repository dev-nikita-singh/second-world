/**
 * Architecture Inspector orchestration — docs/03-engines/architecture-inspector.md §1 (pipeline),
 * §4 (rules, levels, suppression), §5 (limitations always reported).
 * discover → hash → cache lookup → analyze misses (SourceAnalyzer) → graph → analyses → rules → findings.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult, Finding, Limitation, SourceLocation } from "../../core/evidence/schemas.js";
import { createFinding } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import { fingerprint, sha256 } from "../../shared/index.js";
import { deepestChain, dependencyImpact, hubs, routeReachability } from "./analyses.js";
import type { SourceAnalyzer } from "./analyzer/source-analyzer.js";
import { createTsAnalyzer } from "./analyzer/ts/index.js";
import type { TsExtractor } from "./analyzer/ts/walker.js";
import { cacheNamespace, FactsCache } from "./cache.js";
import { discover, toPosix } from "./discovery.js";
import { type ArchitectureGraph, buildGraph } from "./graph.js";
import { type ArchRule, BUILTIN_RULES, buildRuleContext, type RuleReport } from "./rules/index.js";
import {
  type ArchitectureInput,
  type ArchitectureInputLoose,
  ArchitectureInputSchema,
  type RuleConfigEntry,
  type RuleLevel,
} from "./schema.js";
import { findSuppression } from "./suppress.js";
import type {
  ArchEdge,
  ArchitectureMetrics,
  ComponentNode,
  CycleInfo,
  FileFacts,
  RouteInfo,
  SuppressedFinding,
} from "./types.js";

export const ENGINE_VERSION = "0.1.0";

export interface ArchitectureData {
  project: { root: string; tsconfig?: string; files: number; workspaces: string[]; frameworks: string[] };
  components: ComponentNode[];
  edges: ArchEdge[];
  routes: RouteInfo[];
  cycles: CycleInfo[];
  metrics: ArchitectureMetrics;
  /** route id → reachable datastore/external/cache/queue node ids. */
  reachability: Record<string, string[]>;
  /** dependency node id → route ids that depend on it (impact set). */
  impact: Record<string, string[]>;
  suppressed: SuppressedFinding[];
  /** Effective rule levels. */
  rules: Record<string, RuleLevel>;
  /** Non-enumerable (not serialised): queryable graph with toDot()/toMermaid()/toJSON()/impactOf(). */
  readonly graph: ArchitectureGraph;
}

export interface ArchitectureDeps {
  analyzer?: SourceAnalyzer;
  /** Extra TS extractors (plugins) when the default analyzer is used. */
  extractors?: readonly TsExtractor[];
  /** Extra (plugin) rules. */
  rules?: readonly ArchRule[];
}

export function parseArchitectureInput(input: unknown): ArchitectureInput {
  const r = ArchitectureInputSchema.safeParse(input ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError("SW_CONFIG_ARCHITECTURE", `invalid architecture input: ${msg}`, {
      details: { issues: r.error.issues },
    });
  }
  return r.data;
}

function ruleSetting(
  entry: RuleConfigEntry | undefined,
  def: "warn" | "error",
): { level: RuleLevel; options: Record<string, unknown> } {
  if (entry === undefined) return { level: def, options: {} };
  if (typeof entry === "string") return { level: entry, options: {} };
  return { level: entry[0], options: (entry[1] as Record<string, unknown> | undefined) ?? {} };
}

const BASE_LIMITATIONS: Limitation[] = [
  {
    code: "ARCH_STATIC_ONLY",
    message:
      "Static analysis only: runtime wiring (dependency injection containers, reflection, env-dependent configuration, monkey-patching) and production topology (replicas, load balancers, proxies) are not visible",
    impact: "reduces-confidence",
  },
  {
    code: "ARCH_HEURISTIC_EDGES",
    message:
      "Edges derived from naming heuristics (e.g. classes named *Db/*Repository treated as datastores, URL-less HTTP targets named after the client module) carry confidence < 0.6 and are marked heuristic",
    impact: "informational",
  },
  {
    code: "ARCH_INDIRECT_CALLS",
    message:
      "Calls through callbacks, higher-order functions, event emitters and dynamic property access are not resolved; reachability may be under-reported",
    impact: "reduces-confidence",
  },
];

export async function runArchitecture(
  inputLoose: ArchitectureInputLoose | ArchitectureInput,
  ctxPartial: Partial<EngineContext> = {},
  deps: ArchitectureDeps = {},
): Promise<EngineResult<ArchitectureData>> {
  const ctx = createEngineContext(ctxPartial);
  const input = parseArchitectureInput(inputLoose);
  const clock = ctx.clock;
  const t0 = clock.now();
  const startedAt = clock.isoNow();
  const runId = ctx.newId();
  const limitations: Limitation[] = [...BASE_LIMITATIONS];
  const addLim = (l: { code: string; message: string; impact?: Limitation["impact"] }) => {
    if (!limitations.some((x) => x.code === l.code && x.message === l.message))
      limitations.push({ impact: "informational", ...l });
  };
  const cancelled = (): EngineResult<ArchitectureData> => ({
    schemaVersion: 1,
    engine: "architecture",
    runId,
    status: "cancelled",
    startedAt,
    endedAt: clock.isoNow(),
    findings: [],
    limitations,
    artifacts: [],
  });

  const root = path.resolve(input.project);
  const disc = await discover({
    root,
    ...(input.tsconfig ? { tsconfig: input.tsconfig } : {}),
    ...(input.include ? { include: input.include } : {}),
    exclude: input.exclude,
    maxFiles: input.maxFiles,
    maxFileSizeBytes: input.maxFileSizeBytes,
    gitignore: input.gitignore,
  });
  for (const l of disc.limitations) addLim(l);
  if (disc.files.length === 0)
    addLim({
      code: "ARCH_NO_FILES",
      message: `no TypeScript/JavaScript source files found under ${root}`,
      impact: "invalidates",
    });
  if (ctx.signal.aborted) return cancelled();

  // hash
  const hashes = new Map<string, string>();
  for (const f of disc.files) {
    try {
      hashes.set(f, sha256(await readFile(path.join(root, f))));
    } catch {
      // vanished between discovery and read
    }
  }
  const files = disc.files.filter((f) => hashes.has(f));
  const projectSet = new Set(files);

  // cache
  const analyzer = deps.analyzer ?? createTsAnalyzer(deps.extractors ? { extractors: deps.extractors } : {});
  const namespace = cacheNamespace([
    ENGINE_VERSION,
    await analyzer.signature(),
    disc.tsconfigText,
    JSON.stringify(input.frameworks),
    JSON.stringify(disc.workspaces),
  ]);
  const cacheDir = path.resolve(root, input.cacheDir ?? ".second-world/cache/arch");
  const cache = new FactsCache(cacheDir, namespace);
  const cached = new Map<string, FileFacts>();
  if (!input.noCache) {
    await cache.load();
    for (const f of files) {
      const hit = cache.lookup(f, hashes, projectSet);
      if (hit) cached.set(f, hit);
    }
  }
  const misses = files.filter((f) => !cached.has(f));
  const ta = clock.now();
  let analyzed: FileFacts[] = [];
  if (misses.length > 0) {
    const res = await analyzer.analyze({
      root,
      projectFiles: files,
      files: misses,
      hashes,
      ...(disc.tsconfig ? { tsconfig: disc.tsconfig } : {}),
      workspaces: disc.workspaces,
      frameworks: input.frameworks,
      signal: ctx.signal,
    });
    analyzed = res.facts;
    for (const l of res.limitations) addLim(l);
  }
  const analyzeMs = clock.now() - ta;
  if (ctx.signal.aborted) return cancelled();
  const byFile = new Map<string, FileFacts>([...cached, ...analyzed.map((f) => [f.file, f] as const)]);
  const facts = files.map((f) => byFile.get(f)).filter((f): f is FileFacts => !!f);
  if (!input.noCache) {
    cache.replaceAll(facts);
    try {
      await cache.save();
    } catch (e) {
      addLim({
        code: "ARCH_CACHE_WRITE_FAILED",
        message: `facts cache not written (${(e as Error).message})`,
      });
    }
  }
  for (const f of facts) for (const l of f.limitations) addLim(l);
  const dynamicImports = facts.reduce((n, f) => n + f.imports.filter((i) => i.computed).length, 0);
  if (dynamicImports > 0)
    addLim({
      code: "ARCH_DYNAMIC_IMPORT",
      message: `${dynamicImports} dynamic import()/require() call(s) with computed paths could not be resolved`,
      impact: "reduces-confidence",
    });
  if (disc.workspaces.length > 0)
    addLim({
      code: "ARCH_WORKSPACES",
      message: `${disc.workspaces.length} workspace package(s) analysed in one program; cross-package imports resolved via node_modules links or the package entry (heuristic)`,
    });
  addLim({
    code: "ARCH_CACHE_DEPTH",
    message:
      "The incremental cache re-validates a file when it or a directly imported project file changes; changes behind re-export chains may need `noCache`",
  });

  // graph + analyses
  const { graph, routes, units } = buildGraph(facts);
  const base = buildRuleContext(facts, graph, routes, units);

  // rules
  const rules = [...BUILTIN_RULES, ...(deps.rules ?? [])];
  const levels: Record<string, RuleLevel> = {};
  const findings: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const supByFile = new Map(facts.map((f) => [f.file, f.suppressions]));
  let errorFindings = 0;
  for (const rule of rules) {
    const { level, options } = ruleSetting(
      input.rules[rule.meta.id] ?? input.rules[rule.meta.id.toLowerCase()],
      rule.meta.defaultLevel,
    );
    levels[rule.meta.id] = level;
    if (level === "off") continue;
    if (rule.meta.id === "ARCH012" && !options.layers) {
      addLim({
        code: "ARCH012_NO_LAYERS",
        message:
          "ARCH012 (layer violations) needs a layer map: rules.ARCH012 = ['warn', { layers: { controller: ['src/routes/**'] }, allow: { controller: ['service'] } }]",
      });
    }
    let reports: RuleReport[];
    try {
      reports = rule.check({ ...base, options });
    } catch (e) {
      addLim({
        code: "ARCH_RULE_FAILED",
        message: `rule ${rule.meta.id} failed: ${(e as Error).message}`,
        impact: "reduces-confidence",
      });
      continue;
    }
    const ordinals = new Map<string, number>();
    reports.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || (a.column ?? 0) - (b.column ?? 0),
    );
    for (const r of reports) {
      const sup = findSuppression(supByFile.get(r.file) ?? [], r.ruleId, r.line, r.endLine);
      if (sup) {
        suppressed.push({ ruleId: r.ruleId, file: r.file, line: r.line, reason: sup.reason });
        continue;
      }
      const snippetHash = sha256(r.snippet.replace(/\s+/g, " ").trim()).slice(0, 16);
      const parts = r.fingerprintParts ?? [r.ruleId, r.file, r.symbol, snippetHash];
      const key = parts.join("|");
      const ord = ordinals.get(key) ?? 0;
      ordinals.set(key, ord + 1);
      const fp = fingerprint(ord === 0 ? parts : [...parts, String(ord)]);
      const location: SourceLocation = { file: r.file, line: r.line, symbol: r.symbol, snippetHash };
      if (r.column !== undefined) location.column = r.column;
      if (r.endLine !== undefined && r.endLine >= r.line) location.endLine = r.endLine;
      const severity =
        (options.severity as Finding["severity"] | undefined) ?? r.severity ?? rule.meta.severity;
      const title =
        `${rule.meta.title}: ${r.symbol === "<module>" ? r.file : `${r.symbol} (${r.file})`}`.slice(0, 200);
      const finding = createFinding(
        {
          engine: "architecture",
          ruleId: r.ruleId,
          category: rule.meta.category,
          title,
          description: r.message,
          severity,
          classification: "suspected-risk",
          confidence: Math.max(0, Math.min(1, r.confidence)),
          evidence: [{ kind: "code", location, ruleId: r.ruleId }],
          locations: [
            location,
            ...(r.extraLocations ?? []).map((l) => ({
              file: l.file,
              line: l.line,
              ...(l.column ? { column: l.column } : {}),
            })),
          ],
          affected: r.affected ?? [],
          recommendation: rule.meta.fix,
          tags: [`level:${level}`, `docs:${rule.meta.docs}`, ...(r.confidence < 0.6 ? ["heuristic"] : [])],
          fingerprint: fp,
        },
        { newId: ctx.newId, clock },
      );
      findings.push(finding);
      if (level === "error") errorFindings++;
    }
  }

  const cycles = base.cycles;
  const frameworks = [...new Set(routes.map((r) => r.framework))].sort();
  const metrics: ArchitectureMetrics = {
    files: files.length,
    filesFromCache: cached.size,
    modules: graph.nodes("module").length,
    components: graph.nodes().filter((n) => n.kind !== "module").length,
    edges: graph.edges().length,
    routes: routes.length,
    cycles: cycles.length,
    hubs: hubs(graph),
    deepestChain: deepestChain(graph),
    durationMs: clock.now() - t0,
    analyzeMs,
  };
  const project: ArchitectureData["project"] = {
    root: toPosix(root),
    files: files.length,
    workspaces: disc.workspaces.map((w) => w.name),
    frameworks,
  };
  if (disc.tsconfig) project.tsconfig = toPosix(path.relative(root, disc.tsconfig)) || "tsconfig.json";
  const data = {
    project,
    components: graph.nodes(),
    edges: graph.edges(),
    routes: routes.map(({ fact: _f, public: _p, ...r }) => r),
    cycles,
    metrics,
    reachability: routeReachability(graph),
    impact: dependencyImpact(graph),
    suppressed,
    rules: levels,
  } as Omit<ArchitectureData, "graph">;
  Object.defineProperty(data, "graph", { value: graph, enumerable: false });
  for (const f of findings) ctx.evidence.addFinding(f);
  for (const l of limitations) ctx.evidence.addLimitation("architecture", l);

  return {
    schemaVersion: 1,
    engine: "architecture",
    runId,
    status: errorFindings > 0 ? "failed" : "passed",
    startedAt,
    endedAt: clock.isoNow(),
    findings,
    limitations,
    artifacts: [],
    data: data as ArchitectureData,
  };
}
