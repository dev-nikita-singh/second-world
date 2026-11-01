/**
 * System Model builder — docs/03-engines/system-model.md (§1 sources/trust, §2 schema, §3 algorithms,
 * §4 honesty, §5 export). Pipeline: sources → observations → entity resolution (union-find) →
 * nodes/edges with evidence lists + noisy-OR confidence → observed metrics, failure modes, critical paths.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { maybeGunzip, stripGzipExtension } from "../../adapters/telemetry/gzip.js";
import { type NormalizedMetric, type NormalizedSpan, parseOtlp } from "../../adapters/telemetry/otlp.js";
import { isOtlpProtobufFile, parseOtlpProtobuf } from "../../adapters/telemetry/otlp-proto.js";
import { parsePrometheus } from "../../adapters/telemetry/prometheus.js";
import { zodIssueLines } from "../../core/config/loader.js";
import { createEngineContext } from "../../core/context.js";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult, Limitation } from "../../core/evidence/schemas.js";
import { createEvidenceStore } from "../../core/evidence/store.js";
import type { EngineContext } from "../../core/types.js";
import type { ArchitectureData } from "../architecture/index.js";
import { combineConfidence } from "./confidence.js";
import { type ModelGraph, withGraph } from "./graph.js";
import { type ResolvedGroup, resolveEntities } from "./resolve.js";
import { type ModelInput, type ModelInputLoose, ModelInputSchema } from "./schema.js";
import { normalizeName } from "./similarity.js";
import { fromArchitecture } from "./sources/architecture.js";
import { discoverConfigFiles, fromConfigFiles, scanCodeEnv } from "./sources/config.js";
import {
  type EdgeObservation,
  emptySet,
  mergeSets,
  type NodeObservation,
  type ObservationSet,
  PRIMARY_KEY,
  routeSignature,
} from "./sources/observation.js";
import { fromOpenApi } from "./sources/openapi.js";
import {
  fromOtlpMetrics,
  fromPerformance,
  fromPrometheus,
  fromReliability,
  type KnownRoute,
  type PrometheusScrape,
} from "./sources/runtime.js";
import { fromTraces, type PendingCriticalPath } from "./sources/traces.js";
import {
  type Coverage,
  type CoverageSource,
  type CriticalPath,
  type DominantDependency,
  type FailureMode,
  type MergeRecord,
  MODEL_SCHEMA_VERSION,
  type ModelData,
  type ModelEdge,
  type ModelEdgeKind,
  type ModelEvidence,
  type ModelNode,
  type ModelNodeKind,
  type ObservedEdgeMetrics,
} from "./types.js";

export const MODEL_ENGINE_VERSION = "0.1.0";

export type ModelDataWithGraph = ModelData & { readonly graph: ModelGraph };

export interface ModelDeps {
  /** Override the architecture runner (tests). */
  inspect?: (
    input: Record<string, unknown>,
    ctx: Partial<EngineContext>,
  ) => Promise<EngineResult<ArchitectureData>>;
  /** Override Prometheus URL fetches (tests). */
  fetchText?: (url: string, signal: AbortSignal) => Promise<string>;
}

export function parseModelInput(input: unknown): ModelInput {
  const r = ModelInputSchema.safeParse(input ?? {});
  if (!r.success) {
    const issues = zodIssueLines(r.error, { prefix: ["model"], schema: ModelInputSchema });
    throw new ConfigError(
      "SW_CONFIG_MODEL",
      `Invalid model input: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      { hint: "See docs/03-engines/system-model.md", details: { issues } },
    );
  }
  return r.data;
}

const BASE_LIMITATIONS: Limitation[] = [
  {
    code: "MODEL_SECRETS_NOT_STORED",
    message: "Environment values are never stored: only scheme/host/port of URL-like values are kept",
    impact: "informational",
  },
];

const KIND_RANK: Record<ModelNodeKind, number> = {
  route: 9,
  handler: 8,
  module: 7,
  datastore: 3,
  cache: 3,
  queue: 3,
  service: 2,
  external: 1,
};

/** Lower = preferred source of the canonical display name. */
function namePriority(key: string): number {
  if (key === PRIMARY_KEY) return 0;
  if (key.startsWith("trace:svc:")) return 1;
  if (key.startsWith("compose:") || key.startsWith("k8s:")) return 2;
  if (key.startsWith("metrics:svc:")) return 3;
  if (key.startsWith("openapi:")) return 4;
  if (key.startsWith("arch:route:")) return 5;
  if (key.startsWith("trace:")) return 6;
  if (key.startsWith("env:")) return 7;
  if (key.startsWith("arch:")) return 8;
  if (key.startsWith("exp:")) return 9;
  if (key.startsWith("perf:") || key.startsWith("metrics:")) return 10;
  return 20;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function dedupeEvidence(list: ModelEvidence[], max = 30): ModelEvidence[] {
  const seen = new Set<string>();
  const out: ModelEvidence[] = [];
  for (const e of list) {
    const k = `${e.source}|${e.origin}|${e.line ?? ""}|${e.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => b.confidence - a.confidence || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  return out.slice(0, max);
}

function coverageOf(src: Partial<Record<CoverageSource, boolean>>): Coverage {
  const sources: Record<CoverageSource, boolean> = {
    static: src.static === true,
    openapi: src.openapi === true,
    config: src.config === true,
    traces: src.traces === true,
    metrics: src.metrics === true,
    performance: src.performance === true,
    experiments: src.experiments === true,
  };
  const labels: [CoverageSource, string][] = [
    ["static", "static analysis"],
    ["openapi", "OpenAPI"],
    ["config", "config/deployment"],
    ["traces", "runtime traces"],
    ["metrics", "runtime metrics"],
    ["performance", "load tests"],
    ["experiments", "experiments"],
  ];
  const runtimeObserved = sources.traces || sources.metrics || sources.performance || sources.experiments;
  const tail = sources.traces
    ? " Runtime topology observed only within the ingested trace window."
    : runtimeObserved
      ? " No traces: dependencies between services are not runtime-confirmed. Production topology unknown."
      : " Source-only model, not runtime truth. Production topology unknown.";
  const banner = `Built from: ${labels.map(([k, l]) => `${l} ${sources[k] ? "✓" : "✗"}`).join(", ")}.${tail}`;
  const bannerAscii = `Built from: ${labels.map(([k, l]) => `${l} [${sources[k] ? "x" : " "}]`).join(", ")}.${tail}`;
  return { sources, banner, bannerAscii, runtimeObserved };
}

function isMetric(x: unknown): x is NormalizedMetric {
  return typeof x === "object" && x !== null && "points" in x && "name" in x;
}
function isSpan(x: unknown): x is NormalizedSpan {
  return typeof x === "object" && x !== null && "spanId" in x && "traceId" in x && "startUs" in x;
}

/** Build the model. `ctx` may be partial (test-friendly defaults). */
export async function buildModel(
  inputLoose: ModelInputLoose | ModelInput = {},
  ctxPartial: Partial<EngineContext> = {},
  deps: ModelDeps = {},
): Promise<EngineResult<ModelDataWithGraph>> {
  const ctx = createEngineContext(ctxPartial);
  const input = parseModelInput(inputLoose);
  const startedAt = ctx.clock.isoNow();
  const runId = ctx.newId();
  const limitations: Limitation[] = [...BASE_LIMITATIONS];
  const lim = (l: Limitation) => {
    if (!limitations.some((x) => x.code === l.code && x.message === l.message)) limitations.push(l);
  };
  let partial = false;
  const cwd = input.project ? path.resolve(input.project) : process.cwd();
  const sets: ObservationSet[] = [];
  const cancelled = (): EngineResult<ModelDataWithGraph> => ({
    schemaVersion: 1,
    engine: "model",
    runId,
    status: "cancelled",
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings: [],
    limitations,
    artifacts: [],
  });

  // --- Static analysis ---------------------------------------------------------------------------
  let arch: ArchitectureData | undefined = input.architectureData as ArchitectureData | undefined;
  const runArch = input.architecture ?? input.project !== undefined;
  if (!arch && runArch && input.project) {
    const extra = typeof input.architecture === "object" ? input.architecture : {};
    const archInput: Record<string, unknown> = {
      project: cwd,
      ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
      ...extra,
    };
    try {
      const inspect =
        deps.inspect ??
        (async (i: Record<string, unknown>, c: Partial<EngineContext>) =>
          (await import("../architecture/index.js")).inspectArchitecture(i, c));
      // Separate evidence store: architecture findings belong to the architecture engine.
      const r = await inspect(archInput, { ...ctx, evidence: createEvidenceStore() });
      if (r.data) arch = r.data;
      else {
        partial = true;
        lim({
          code: "MODEL_STATIC_FAILED",
          message: `Architecture inspection returned ${r.status}`,
          impact: "reduces-confidence",
        });
      }
    } catch (e) {
      partial = true;
      lim({
        code: "MODEL_STATIC_FAILED",
        message: `Architecture inspection failed: ${(e as Error).message}`,
        impact: "reduces-confidence",
      });
    }
  }
  if (ctx.signal.aborted) return cancelled();
  let codeEnv = new Map<string, { file: string; line: number }[]>();
  if (arch) {
    sets.push(fromArchitecture(arch, { detail: input.detail }));
    const root = arch.project?.root ?? cwd;
    const files = arch.components.filter((c) => c.kind === "module" && c.file).map((c) => c.file as string);
    codeEnv = await scanCodeEnv(root, files);
    if (input.detail === "components")
      lim({
        code: "MODEL_STATIC_COLLAPSED",
        message:
          "Internal functions are collapsed into route → dependency edges (use detail: full to keep them)",
        impact: "informational",
      });
  }

  // --- OpenAPI ---------------------------------------------------------------------------------
  const specs =
    input.openapi === undefined ? [] : Array.isArray(input.openapi) ? input.openapi : [input.openapi];
  for (const s of specs) {
    try {
      sets.push(await fromOpenApi(s as string | Record<string, unknown>, cwd));
    } catch (e) {
      partial = true;
      lim({ code: "MODEL_OPENAPI_FAILED", message: (e as Error).message, impact: "reduces-confidence" });
    }
  }

  // --- Config ------------------------------------------------------------------------------------
  const cfgFiles = input.config.files.map((f) => path.resolve(cwd, f));
  if (input.config.discover && input.project)
    for (const f of await discoverConfigFiles(cwd)) if (!cfgFiles.includes(f)) cfgFiles.push(f);
  let packageName: string | undefined;
  if (cfgFiles.length > 0) {
    const cfg = await fromConfigFiles(cfgFiles, { root: cwd, codeEnv });
    packageName = cfg.packageName;
    sets.push(cfg);
  }

  // --- Telemetry ---------------------------------------------------------------------------------
  const spans: NormalizedSpan[] = [];
  const metrics: NormalizedMetric[] = [];
  let droppedSpans = 0;
  const addParsed = (r: ReturnType<typeof parseOtlp>, origin: string) => {
    for (const s of r.spans) {
      if (spans.length < input.maxSpans) spans.push(s);
      else droppedSpans++;
    }
    droppedSpans += r.droppedSpans;
    metrics.push(...r.metrics);
    if (r.warnings.length > 0)
      lim({
        code: "MODEL_OTLP_WARNINGS",
        message: `${origin}: ${r.warnings.length} warning(s), e.g. ${r.warnings[0]}`,
        impact: "informational",
      });
  };
  for (const f of input.traces) {
    try {
      // gzip (magic 1f 8b, any name) is decompressed under a size/ratio cap, then detected as usual.
      const raw = await readFile(path.resolve(cwd, f));
      const gz = maybeGunzip(raw);
      const buf = Buffer.from(gz.bytes.buffer, gz.bytes.byteOffset, gz.bytes.byteLength);
      addParsed(
        isOtlpProtobufFile(gz.gzipped ? stripGzipExtension(f) : f, buf)
          ? parseOtlpProtobuf(buf, { maxSpans: input.maxSpans })
          : parseOtlp(buf.toString("utf8"), { maxSpans: input.maxSpans }),
        f,
      );
    } catch (e) {
      partial = true;
      lim({
        code: "MODEL_OTLP_UNREADABLE",
        message: `${f}: ${(e as Error).message}`,
        impact: "reduces-confidence",
      });
    }
  }
  if (input.telemetry) {
    for (const s of input.telemetry.spans ?? [])
      if (isSpan(s)) spans.length < input.maxSpans ? spans.push(s) : droppedSpans++;
    for (const m of input.telemetry.metrics ?? []) if (isMetric(m)) metrics.push(m);
    if (input.telemetry.payloads?.length)
      addParsed(parseOtlp(input.telemetry.payloads, { maxSpans: input.maxSpans }), "telemetry");
  }
  if (droppedSpans > 0)
    lim({
      code: "MODEL_SPANS_DROPPED",
      message: `${droppedSpans} span(s) dropped at maxSpans=${input.maxSpans}`,
      impact: "reduces-confidence",
    });
  let pendingCritical: PendingCriticalPath[] = [];
  if (spans.length > 0) {
    const ts = fromTraces(spans, { droppedSpans, maxCriticalPaths: input.maxCriticalPaths });
    pendingCritical = ts.pendingCritical;
    sets.push(ts);
    lim({
      code: "MODEL_TRACE_WINDOW",
      message: "Observed metrics reflect only the ingested trace window; sampling can hide rare paths",
      impact: "informational",
    });
  }
  if (metrics.length > 0) sets.push(fromOtlpMetrics(metrics));
  const scrapes: PrometheusScrape[] = [];
  for (const p of input.prometheus) {
    const src = typeof p === "string" ? { file: p } : p;
    try {
      let text = src.text;
      let origin = "prometheus";
      if (text === undefined && src.file) {
        text = await readFile(path.resolve(cwd, src.file), "utf8");
        origin = src.file;
      } else if (text === undefined && src.url) {
        const decision = ctx.safety.checkTarget(new URL(src.url));
        if (!decision.allowed) throw new Error(`scrape of ${src.url} denied: ${decision.reason}`);
        const fetchText =
          deps.fetchText ??
          (async (u: string, signal: AbortSignal) => {
            const res = await fetch(u, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          });
        text = await fetchText(src.url, AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]));
        origin = src.url;
      }
      if (text === undefined) continue;
      const parsed = parsePrometheus(text);
      scrapes.push({
        parsed,
        origin,
        ...(src.service ? { service: src.service } : {}),
        ...(src.atMs !== undefined ? { atMs: src.atMs } : {}),
      });
    } catch (e) {
      partial = true;
      lim({ code: "MODEL_PROMETHEUS_FAILED", message: (e as Error).message, impact: "reduces-confidence" });
    }
  }
  if (scrapes.length > 0) sets.push(fromPrometheus(scrapes));
  if (ctx.signal.aborted) return cancelled();

  // --- Performance / experiments --------------------------------------------------------------
  const known: KnownRoute[] = [];
  for (const s of sets)
    for (const n of s.nodes) if (n.route) known.push({ method: n.route.method, path: n.route.path });
  if (input.performance.length > 0) sets.push(fromPerformance(input.performance, known));
  if (input.reliability.length > 0) sets.push(fromReliability(input.reliability));

  const all = mergeSets(sets.length ? sets : [emptySet()]);
  for (const l of all.limitations) lim(l);

  // Primary service observation (named after serviceName / package.json / folder).
  const primaryName =
    input.serviceName ??
    packageName ??
    (input.project ? path.basename(cwd) : undefined) ??
    all.nodes.find((n) => n.key === PRIMARY_KEY)?.name ??
    "app";
  const referencesPrimary =
    all.nodes.some(
      (n) => n.key === PRIMARY_KEY || n.route?.serviceKey === PRIMARY_KEY || n.serviceKey === PRIMARY_KEY,
    ) || all.edges.some((e) => e.from === PRIMARY_KEY || e.to === PRIMARY_KEY);
  if (referencesPrimary) {
    const ev: ModelEvidence[] = [];
    if (arch)
      ev.push({
        source: "static",
        confidence: 0.75,
        origin: ".",
        detail: `project ${primaryName} (${arch.project?.frameworks?.join(", ") || "source"})`,
      });
    if (packageName)
      ev.push({
        source: "config",
        confidence: 0.8,
        origin: "package.json",
        detail: `package ${packageName}`,
      });
    if (ev.length === 0 && !all.nodes.some((n) => n.key === PRIMARY_KEY))
      ev.push({
        source: "config",
        confidence: 0.8,
        origin: ".",
        detail: "project service implied by its configuration",
      });
    all.nodes.push({
      key: PRIMARY_KEY,
      kind: "service",
      name: primaryName,
      aliases: packageName && packageName !== primaryName ? [packageName] : [],
      evidence: ev,
      serviceNames: [primaryName.toLowerCase(), ...(packageName ? [packageName.toLowerCase()] : [])],
    });
  }
  // Every edge endpoint must exist as an observation (e.g. compose depends_on a missing service).
  const keys = new Set(all.nodes.map((n) => n.key));
  const edges = all.edges.filter((e) => keys.has(e.from) && keys.has(e.to));

  // --- Entity resolution -------------------------------------------------------------------------
  const res = resolveEntities(all.nodes, all.links, input.resolution);
  if (res.fuzzySkipped)
    lim({
      code: "MODEL_FUZZY_SKIPPED",
      message: "Too many entities for name-similarity matching; only exact rules applied",
      impact: "reduces-confidence",
    });

  // Node ids (deterministic): kind + canonical name; routes include their service name.
  const idOf = new Map<ResolvedGroup, string>();
  const used = new Set<string>();
  const canonical = (g: ResolvedGroup): NodeObservation => {
    if (g.keys.includes(PRIMARY_KEY))
      return (
        g.observations.find((o) => o.key === PRIMARY_KEY && o.name === primaryName) ??
        (g.observations[0] as NodeObservation)
      );
    return [...g.observations].sort(
      (a, b) => namePriority(a.key) - namePriority(b.key) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )[0] as NodeObservation;
  };
  const kindOf = (g: ResolvedGroup): ModelNodeKind => {
    let best: ModelNodeKind = (g.observations[0] as NodeObservation).kind;
    for (const o of g.observations) if (KIND_RANK[o.kind] > KIND_RANK[best]) best = o.kind;
    if (best === "external" && g.keys.some((k) => k.startsWith("trace:svc:") || k === PRIMARY_KEY))
      best = "service";
    return best;
  };
  // Services first (route ids embed the service name).
  const ordered = [...res.groups].sort((a, b) => {
    const ra = kindOf(a) === "route" || kindOf(a) === "handler" || kindOf(a) === "module" ? 1 : 0;
    const rb = kindOf(b) === "route" || kindOf(b) === "handler" || kindOf(b) === "module" ? 1 : 0;
    const ka = canonical(a).key;
    const kb = canonical(b).key;
    return ra - rb || namePriority(ka) - namePriority(kb) || (ka < kb ? -1 : 1);
  });
  const nodeName = new Map<ResolvedGroup, string>();
  const nodes: ModelNode[] = [];
  const nodeByGroup = new Map<ResolvedGroup, ModelNode>();
  const primaryGroup = res.groupOf(PRIMARY_KEY);
  for (const g of ordered) {
    const kind = kindOf(g);
    const c = canonical(g);
    let name = c.name;
    let svcId: string | undefined;
    let svcName: string | undefined;
    let routeInfo: { method: string; path: string } | undefined;
    if (kind === "route") {
      // Prefer OpenAPI parameter names, then static, then runtime.
      const ro = [...g.observations]
        .filter((o) => o.route)
        .sort((a, b) => namePriority(a.key) - namePriority(b.key))[0] as NodeObservation;
      routeInfo = { method: ro.route?.method ?? "GET", path: ro.route?.path ?? "/" };
      name = `${routeInfo.method} ${routeInfo.path}`;
      const sg = ro.route ? res.groupOf(ro.route.serviceKey) : undefined;
      if (sg) {
        svcId = idOf.get(sg);
        svcName = nodeName.get(sg);
      }
    } else if (kind === "handler" || kind === "module") {
      const sk = g.observations.find((o) => o.serviceKey)?.serviceKey;
      const sg = sk ? res.groupOf(sk) : undefined;
      if (sg) svcId = idOf.get(sg);
    }
    let id = kind === "route" ? `route:${svcName ? `${svcName}:` : ""}${name}` : `${kind}:${name}`;
    if (used.has(id)) {
      let i = 2;
      while (used.has(`${id}#${i}`)) i++;
      id = `${id}#${i}`;
    }
    used.add(id);
    idOf.set(g, id);
    nodeName.set(g, name);
    const names = [name];
    const aliases = new Set<string>();
    for (const o of g.observations)
      for (const n of [o.name, ...(o.aliases ?? [])]) if (n !== name) aliases.add(n);
    if (kind === "route") aliases.clear();
    names.push(...[...aliases].sort());
    const evidence = dedupeEvidence(g.observations.flatMap((o) => o.evidence));
    const conf = combineConfidence(evidence, g.multiplier);
    const hosts = [...new Set(g.observations.flatMap((o) => o.hosts ?? []))].sort();
    const node: ModelNode = { id, kind, names, evidence, confidence: conf.confidence };
    if (svcId) node.service = svcId;
    if (routeInfo) {
      node.method = routeInfo.method;
      node.path = routeInfo.path;
    }
    if (hosts.length > 0 && kind !== "route") node.hosts = hosts;
    const obsPriority = { performance: 0, trace: 1, metrics: 2 } as const;
    const observed = g.observations
      .map((o) => o.observed)
      .filter((x) => x !== undefined)
      .sort((a, b) => obsPriority[a.source] - obsPriority[b.source])[0];
    if (observed) node.observed = observed;
    const fms: FailureMode[] = g.observations.flatMap((o) => o.failureModes ?? []);
    if (fms.length > 0) node.failureModes = fms;
    if (g.proposed) node.proposedMerge = true;
    nodes.push(node);
    nodeByGroup.set(g, node);
  }

  // --- Edges ------------------------------------------------------------------------------------
  const edgeMap = new Map<
    string,
    { from: string; to: string; kind: ModelEdgeKind; obs: EdgeObservation[] }
  >();
  for (const e of edges) {
    const fg = res.groupOf(e.from);
    const tg = res.groupOf(e.to);
    if (!fg || !tg || fg === tg) continue;
    const from = idOf.get(fg) as string;
    const to = idOf.get(tg) as string;
    const k = `${from}\u0000${to}\u0000${e.kind}`;
    let m = edgeMap.get(k);
    if (!m) {
      m = { from, to, kind: e.kind, obs: [] };
      edgeMap.set(k, m);
    }
    m.obs.push(e);
  }
  // Fold "depends" into a more specific edge between the same pair.
  for (const [k, m] of edgeMap) {
    if (m.kind !== "depends") continue;
    const target = [...edgeMap.values()].find(
      (x) => x !== m && x.from === m.from && x.to === m.to && x.kind !== "depends",
    );
    if (target) {
      target.obs.push(...m.obs);
      edgeMap.delete(k);
    }
  }
  const modelEdges: ModelEdge[] = [];
  for (const m of edgeMap.values()) {
    const evidence = dedupeEvidence(m.obs.flatMap((o) => o.evidence));
    const conf = combineConfidence(evidence);
    const edge: ModelEdge = {
      id: `${m.from}->${m.to}:${m.kind}`,
      from: m.from,
      to: m.to,
      kind: m.kind,
      evidence,
      confidence: conf.confidence,
    };
    const obsList = m.obs.map((o) => o.observed).filter((x): x is ObservedEdgeMetrics => x !== undefined);
    if (obsList.length > 0) {
      const o: ObservedEdgeMetrics = {};
      let calls = 0;
      let cpr = 0;
      let p95 = 0;
      let errW = 0;
      for (const x of obsList) {
        calls += x.calls ?? 0;
        cpr += x.callsPerRequest ?? 0;
        p95 = Math.max(p95, x.p95Ms ?? 0);
        errW += (x.errorRate ?? 0) * (x.calls ?? 0);
      }
      if (calls > 0) {
        o.calls = calls;
        o.errorRate = r3(errW / calls);
      }
      if (obsList.some((x) => x.callsPerRequest !== undefined)) o.callsPerRequest = r3(cpr);
      if (obsList.some((x) => x.p95Ms !== undefined)) o.p95Ms = p95;
      edge.observed = o;
    }
    modelEdges.push(edge);
  }

  // --- Merge provenance ---------------------------------------------------------------------------
  const merges: MergeRecord[] = [];
  for (const g of res.groups) for (const m of g.merges) merges.push({ node: idOf.get(g) as string, ...m });

  // --- Failure modes from findings -------------------------------------------------------------
  attachFindings(input.findings, nodes, primaryGroup ? nodeByGroup.get(primaryGroup) : undefined);

  // --- Critical paths & dominant dependency -------------------------------------------------------
  let traces = all.traces;
  if (traces && pendingCritical.length > 0) {
    const nodeIdOfKey = (k: string): string | undefined => {
      const g = res.groupOf(k);
      return g ? idOf.get(g) : undefined;
    };
    const paths: CriticalPath[] = pendingCritical.map((p) => {
      const byNode = new Map<string, number>();
      const segments = p.segments.map((s) => {
        const node = nodeIdOfKey(s.key);
        if (node) byNode.set(node, (byNode.get(node) ?? 0) + s.ms);
        return { spanId: s.spanId, name: s.name, service: s.service, ...(node ? { node } : {}), ms: s.ms };
      });
      const total = p.durationMs || 1;
      const route = p.routeKey ? nodeIdOfKey(p.routeKey) : undefined;
      return {
        traceId: p.traceId,
        rootSpanId: p.rootSpanId,
        root: p.root,
        ...(route ? { route } : {}),
        durationMs: p.durationMs,
        segments,
        byNode: [...byNode]
          .map(([node, ms]) => ({ node, ms: r3(ms), share: r3(ms / total) }))
          .sort((a, b) => b.ms - a.ms || (a.node < b.node ? -1 : 1)),
      };
    });
    const dom = new Map<string, { total: number; traces: number; byNode: Map<string, number> }>();
    for (const p of paths) {
      if (!p.route) continue;
      const svc = nodes.find((n) => n.id === p.route)?.service;
      let d = dom.get(p.route);
      if (!d) {
        d = { total: 0, traces: 0, byNode: new Map() };
        dom.set(p.route, d);
      }
      d.total += p.durationMs;
      d.traces++;
      for (const b of p.byNode)
        if (b.node !== svc && b.node !== p.route) d.byNode.set(b.node, (d.byNode.get(b.node) ?? 0) + b.ms);
    }
    const dominant: DominantDependency[] = [];
    for (const [route, d] of dom) {
      const best = [...d.byNode].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (best)
        dominant.push({
          route,
          node: best[0],
          ms: r3(best[1]),
          share: r3(best[1] / (d.total || 1)),
          traces: d.traces,
        });
    }
    dominant.sort((a, b) => (a.route < b.route ? -1 : 1));
    traces = { ...traces, criticalPaths: paths.slice(0, input.maxCriticalPaths), dominant };
  }

  // --- Honesty ------------------------------------------------------------------------------------
  const coverage = coverageOf(all.coverage);
  if (!coverage.runtimeObserved)
    lim({
      code: "MODEL_SOURCE_ONLY",
      message: "Model built from source/config only; it is not runtime truth",
      impact: "reduces-confidence",
    });
  else if (!coverage.sources.traces)
    lim({
      code: "MODEL_NO_TRACES",
      message: "No traces ingested: inter-service dependencies are not runtime-confirmed",
      impact: "reduces-confidence",
    });
  const proposed = merges.filter((m) => m.proposed).length;
  if (proposed > 0)
    lim({
      code: "MODEL_PROPOSED_MERGES",
      message: `${proposed} merge(s) are name-similarity proposals with lowered confidence; verify them`,
      impact: "reduces-confidence",
    });
  if (res.refused.length > 0)
    lim({
      code: "MODEL_MERGES_REFUSED",
      message: `${res.refused.length} identity match(es) refused because of incompatible kinds (e.g. ${res.refused[0]?.a} ↔ ${res.refused[0]?.b})`,
      impact: "informational",
    });

  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  modelEdges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const data: ModelData = {
    schemaVersion: MODEL_SCHEMA_VERSION,
    builtAt: ctx.clock.isoNow(),
    ...(primaryGroup ? { primaryService: idOf.get(primaryGroup) as string } : {}),
    nodes,
    edges: modelEdges,
    merges,
    coverage,
    ...(traces ? { traces } : {}),
    stats: {
      observations: all.nodes.length,
      nodes: nodes.length,
      edges: modelEdges.length,
      merges: merges.length,
      proposedMerges: proposed,
    },
    limitations: [],
  };
  data.limitations = limitations;
  ctx.events.emit("model.built", {
    runId,
    nodes: nodes.length,
    edges: modelEdges.length,
    coverage: coverage.sources,
  });
  return {
    schemaVersion: 1,
    engine: "model",
    runId,
    status: partial ? "partial" : "passed",
    startedAt,
    endedAt: ctx.clock.isoNow(),
    findings: [],
    limitations,
    artifacts: [],
    data: withGraph(data),
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Findings (or EngineResults) → failure modes on routes / named nodes; unmatched reliability findings → primary. */
export function attachFindings(items: readonly unknown[], nodes: ModelNode[], primary?: ModelNode): number {
  const findings: Obj[] = [];
  for (const it of items) {
    if (isObj(it) && Array.isArray(it.findings)) findings.push(...it.findings.filter(isObj));
    else if (isObj(it)) findings.push(it);
  }
  const routes = new Map<string, ModelNode[]>();
  for (const n of nodes) {
    if (n.kind !== "route" || !n.method || !n.path) continue;
    const k = routeSignature(n.method, n.path);
    const l = routes.get(k) ?? [];
    l.push(n);
    routes.set(k, l);
  }
  const byName = new Map<string, ModelNode>();
  for (const n of nodes)
    for (const nm of n.names) if (!byName.has(normalizeName(nm))) byName.set(normalizeName(nm), n);
  let attached = 0;
  for (const f of findings) {
    if (f.classification === "hypothesis") continue;
    const affected = Array.isArray(f.affected)
      ? f.affected.filter((x): x is string => typeof x === "string")
      : [];
    const targets = new Set<ModelNode>();
    for (const a of affected) {
      const m = /^([A-Z]+)\s+(\/\S*)$/.exec(a.trim());
      if (m) {
        const list = routes.get(routeSignature(m[1] as string, m[2] as string)) ?? [];
        const own = list.filter((n) => !primary || n.service === primary.id);
        for (const n of own.length ? own : list) targets.add(n);
        continue;
      }
      const n = nodes.find((x) => x.id === a) ?? byName.get(normalizeName(a));
      if (n) targets.add(n);
    }
    if (targets.size === 0 && f.engine === "reliability" && primary) targets.add(primary);
    const fm: FailureMode = {
      id: String(f.ruleId ?? f.fingerprint ?? f.id ?? "finding"),
      title: String(f.title ?? f.ruleId ?? "finding"),
      source: String(f.engine ?? "finding"),
      ...(typeof f.severity === "string" ? { severity: f.severity as FailureMode["severity"] & string } : {}),
      ...(typeof f.classification === "string" ? { classification: f.classification } : {}),
      ...(typeof f.fingerprint === "string" ? { fingerprint: f.fingerprint } : {}),
    };
    for (const n of targets) {
      n.failureModes ??= [];
      if (!n.failureModes.some((x) => x.id === fm.id && x.fingerprint === fm.fingerprint)) {
        n.failureModes.push(fm);
        attached++;
      }
    }
  }
  return attached;
}
