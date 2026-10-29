/**
 * Runtime/experiment sources → observations — docs/03-engines/system-model.md §1:
 * performance results (observed rps/p95/error per endpoint, 0.9), OTLP metrics + Prometheus scrapes (0.9),
 * reliability experiments (controlled experiment, 0.9).
 * Inputs are accepted loosely (EngineResult or bare data) so this module does not depend on engine internals.
 */
import type { NormalizedMetric } from "../../../adapters/telemetry/otlp.js";
import { histogramQuantile } from "../../../adapters/telemetry/otlp.js";
import {
  histogramSeries,
  type PromParseResult,
  promHistogramQuantile,
} from "../../../adapters/telemetry/prometheus.js";
import { DEFAULT_CONFIDENCE } from "../confidence.js";
import { normalizeName } from "../similarity.js";
import type { ModelEvidence, ObservedNodeMetrics } from "../types.js";
import {
  emptySet,
  normRoutePath,
  type ObservationSet,
  PRIMARY_KEY,
  routeRegex,
  routeSignature,
  urlIdentity,
} from "./observation.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface KnownRoute {
  method: string;
  path: string;
}

/** Map a concrete/templated request path to a known route template (same method). */
export function matchRoute(
  method: string,
  rawPath: string,
  known: readonly KnownRoute[],
): string | undefined {
  const p = normRoutePath(rawPath.replace(/\{\{[^}]*\}\}/g, "x"));
  const sig = routeSignature(method, p);
  for (const k of known) if (k.method === method && routeSignature(k.method, k.path) === sig) return k.path;
  for (const k of known) if (k.method === method && routeRegex(k.path).test(p)) return k.path;
  return undefined;
}

interface PerfEndpoint {
  method: string;
  path: string;
  requests: number;
  rps: number;
  errorRate: number;
  latency?: { corrected?: { p95?: number } };
}

/** Performance Lab results (EngineResult<PerformanceData> or PerformanceData). */
export function fromPerformance(results: readonly unknown[], known: readonly KnownRoute[]): ObservationSet {
  const set = emptySet();
  for (const r0 of results) {
    const r = isObj(r0) && isObj(r0.data) ? r0.data : r0;
    if (!isObj(r) || !Array.isArray(r.endpoints)) continue;
    const runId = isObj(r0) && typeof r0.runId === "string" ? r0.runId : "run";
    const target = typeof r.target === "string" ? r.target : undefined;
    const win = isObj(r.window) ? r.window : {};
    const window = { start: String(win.startedAt ?? ""), end: String(win.endedAt ?? "") };
    set.coverage.performance = true;
    // Target service identity (merges with the primary service by host:port).
    const tKey = target ? `perf:target:${target}` : PRIMARY_KEY;
    if (target) {
      const id = urlIdentity(target);
      set.nodes.push({
        key: tKey,
        kind: "service",
        name: id?.hostname ?? id?.hostPort ?? target,
        evidence: [
          {
            source: "performance",
            confidence: DEFAULT_CONFIDENCE.performance,
            origin: `performance:${runId}`,
            detail: `load-test target ${id?.hostPort ?? target}`,
          },
        ],
        ...(id?.hostPort ? { hosts: [id.hostPort] } : {}),
        fuzzy: false,
      });
    }
    const agg = new Map<
      string,
      { method: string; path: string; req: number; rps: number; err: number; p95: number; keys: string[] }
    >();
    for (const e of r.endpoints as PerfEndpoint[]) {
      if (!isObj(e) || typeof e.method !== "string" || typeof e.path !== "string") continue;
      const method = e.method.toUpperCase();
      const path =
        matchRoute(method, e.path, known) ?? normRoutePath(e.path.replace(/\{\{[^}]*\}\}/g, "{param}"));
      const k = routeSignature(method, path);
      let a = agg.get(k);
      if (!a) {
        a = { method, path, req: 0, rps: 0, err: 0, p95: 0, keys: [] };
        agg.set(k, a);
      }
      const req = Number(e.requests) || 0;
      a.err += (Number(e.errorRate) || 0) * req;
      a.req += req;
      a.rps += Number(e.rps) || 0;
      a.p95 = Math.max(a.p95, Number(e.latency?.corrected?.p95) || 0);
      a.keys.push(`${e.method} ${e.path}`);
    }
    for (const [sig, a] of agg) {
      const observed: ObservedNodeMetrics = {
        rps: r3(a.rps),
        p95Ms: r3(a.p95),
        errorRate: a.req > 0 ? r3(a.err / a.req) : 0,
        requests: a.req,
        window,
        source: "performance",
      };
      set.nodes.push({
        key: `perf:${runId}:${sig}`,
        kind: "route",
        name: `${a.method} ${a.path}`,
        route: { method: a.method, path: a.path, serviceKey: tKey },
        evidence: [
          {
            source: "performance",
            confidence: DEFAULT_CONFIDENCE.performance,
            origin: `performance:${runId}`,
            detail: `load-tested endpoint(s) ${a.keys.join(", ")}: ${a.req} requests`,
            count: a.req,
          },
        ],
        observed,
        fuzzy: false,
      });
    }
  }
  return set;
}

const ROUTE_LABELS = ["http.route", "http_route", "route", "handler", "path", "uri", "endpoint"];
const METHOD_LABELS = [
  "http.request.method",
  "http.method",
  "http_request_method",
  "http_method",
  "method",
  "verb",
];
const STATUS_LABELS = [
  "http.response.status_code",
  "http.status_code",
  "http_response_status_code",
  "http_status_code",
  "status_code",
  "status",
  "code",
];
const pick = (labels: Record<string, unknown>, names: readonly string[]): string | undefined => {
  for (const n of names) {
    const v = labels[n];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
};

interface RouteMetricAgg {
  svc?: string;
  method: string;
  path: string;
  count: number;
  errors: number;
  p95?: number;
  rps?: number;
  origin: string;
}

function routeObs(
  set: ObservationSet,
  aggs: Iterable<RouteMetricAgg>,
  window: { start: string; end: string },
): void {
  for (const a of aggs) {
    const svcKey = a.svc ? `metrics:svc:${a.svc}` : PRIMARY_KEY;
    if (a.svc && !set.nodes.some((n) => n.key === svcKey))
      set.nodes.push({
        key: svcKey,
        kind: "service",
        name: a.svc,
        serviceNames: [a.svc.toLowerCase()],
        evidence: [
          {
            source: "metrics",
            confidence: DEFAULT_CONFIDENCE.metrics,
            origin: a.origin,
            detail: `metrics from service ${a.svc}`,
          },
        ],
      });
    const observed: ObservedNodeMetrics = { window, source: "metrics", requests: a.count };
    if (a.p95 !== undefined && Number.isFinite(a.p95)) observed.p95Ms = r3(a.p95);
    if (a.count > 0) observed.errorRate = r3(a.errors / a.count);
    if (a.rps !== undefined) observed.rps = r3(a.rps);
    set.nodes.push({
      key: `metrics:${a.svc ?? "_"}:${routeSignature(a.method, a.path)}`,
      kind: "route",
      name: `${a.method} ${normRoutePath(a.path)}`,
      route: { method: a.method, path: normRoutePath(a.path), serviceKey: svcKey },
      evidence: [
        {
          source: "metrics",
          confidence: DEFAULT_CONFIDENCE.metrics,
          origin: a.origin,
          detail: `route metrics ${a.method} ${a.path}`,
          count: a.count,
        },
      ],
      observed,
      fuzzy: false,
    });
  }
}

/** OTLP metrics: `http.server.request.duration` (s) / `http.server.duration` (ms) histograms per http.route. */
export function fromOtlpMetrics(
  metrics: readonly NormalizedMetric[],
  origin = "otlp-metrics",
): ObservationSet {
  const set = emptySet();
  const aggs = new Map<string, RouteMetricAgg & { bounds: number[]; counts: number[]; scale: number }>();
  let minUs = Number.POSITIVE_INFINITY;
  let maxUs = 0;
  for (const m of metrics) {
    if (m.type !== "histogram" || !/^http\.server\.(request\.)?duration$/.test(m.name)) continue;
    const scale = m.unit === "s" || m.name === "http.server.request.duration" ? 1000 : 1;
    for (const p of m.points) {
      const path = pick(p.attributes, ROUTE_LABELS);
      const method = pick(p.attributes, METHOD_LABELS)?.toUpperCase();
      if (!path || !method) continue;
      const status = Number(pick(p.attributes, STATUS_LABELS) ?? 0);
      const k = `${m.service}\u0000${routeSignature(method, path)}`;
      let a = aggs.get(k);
      if (!a) {
        a = {
          svc: m.service === "unknown_service" ? undefined : m.service,
          method,
          path,
          count: 0,
          errors: 0,
          origin,
          bounds: p.explicitBounds ?? [],
          counts: [],
          scale,
        } as RouteMetricAgg & {
          bounds: number[];
          counts: number[];
          scale: number;
        };
        aggs.set(k, a);
      }
      const c = p.count ?? 0;
      a.count += c;
      if (status >= 500) a.errors += c;
      (p.bucketCounts ?? []).forEach((v, i) => {
        a.counts[i] = (a.counts[i] ?? 0) + v;
      });
      if (p.timeUs !== undefined) maxUs = Math.max(maxUs, p.timeUs);
      if (p.startTimeUs !== undefined) minUs = Math.min(minUs, p.startTimeUs);
    }
  }
  if (aggs.size === 0) return set;
  set.coverage.metrics = true;
  const window =
    Number.isFinite(minUs) && maxUs > minUs
      ? { start: new Date(minUs / 1000).toISOString(), end: new Date(maxUs / 1000).toISOString() }
      : { start: "", end: "" };
  const seconds = Number.isFinite(minUs) && maxUs > minUs ? (maxUs - minUs) / 1e6 : 0;
  for (const a of aggs.values()) {
    a.p95 = histogramQuantile(0.95, a.bounds, a.counts) * a.scale;
    if (seconds > 0) a.rps = a.count / seconds;
  }
  routeObs(set, aggs.values(), window);
  return set;
}

export interface PrometheusScrape {
  parsed: PromParseResult;
  origin: string;
  /** Service the scrape belongs to (else `job`/`service` label, else the primary service). */
  service?: string;
  /** Scrape time (epoch ms) — two scrapes of the same origin give request rates. */
  atMs?: number;
}

/** Prometheus scrapes: `*_duration_seconds`/`*_latency_*` histograms and `*requests_total` counters per route. */
export function fromPrometheus(scrapes: readonly PrometheusScrape[]): ObservationSet {
  const set = emptySet();
  const aggs = new Map<string, RouteMetricAgg>();
  const counters = new Map<string, { k: string; status: number; pts: { atMs: number; count: number }[] }>();
  for (const sc of scrapes) {
    for (const f of sc.parsed.families) {
      const isDuration =
        /(duration|latency|response_time)/.test(f.name) && /^http|request|server/.test(f.name);
      if (f.type === "histogram" && isDuration) {
        const scale = /_seconds$/.test(f.name) || !/_(ms|milliseconds)$/.test(f.name) ? 1000 : 1;
        for (const s of histogramSeries(f)) {
          const path = pick(s.labels, ROUTE_LABELS);
          const method = pick(s.labels, METHOD_LABELS)?.toUpperCase() ?? "GET";
          if (!path) continue;
          const svc = sc.service ?? pick(s.labels, ["service", "service_name", "job"]);
          const k = `${svc ?? ""}\u0000${routeSignature(method, path)}`;
          let a = aggs.get(k);
          if (!a) {
            a = { ...(svc ? { svc } : {}), method, path, count: 0, errors: 0, origin: sc.origin };
            aggs.set(k, a);
          }
          const status = Number(pick(s.labels, STATUS_LABELS) ?? 0);
          const c = s.count ?? s.buckets[s.buckets.length - 1]?.count ?? 0;
          if (status >= 500) a.errors += c;
          a.count += c;
          const q = promHistogramQuantile(0.95, s) * scale;
          if (Number.isFinite(q)) a.p95 = Math.max(a.p95 ?? 0, q);
        }
      } else if (
        f.type === "counter" &&
        /requests?(_total)?$/.test(f.name.replace(/_total$/, "")) &&
        /http|request/.test(f.name)
      ) {
        for (const s of f.samples) {
          if (s.name.endsWith("_created")) continue;
          const path = pick(s.labels, ROUTE_LABELS);
          if (!path) continue;
          const method = pick(s.labels, METHOD_LABELS)?.toUpperCase() ?? "GET";
          const svc = sc.service ?? pick(s.labels, ["service", "service_name", "job"]);
          const k = `${svc ?? ""}\u0000${routeSignature(method, path)}`;
          let a = aggs.get(k);
          if (!a) {
            a = { ...(svc ? { svc } : {}), method, path, count: 0, errors: 0, origin: sc.origin };
            aggs.set(k, a);
          }
          const status = Number(pick(s.labels, STATUS_LABELS) ?? 0);
          const sk = `${sc.origin}\u0000${k}\u0000${status}`;
          let ser = counters.get(sk);
          if (!ser) {
            ser = { k, status, pts: [] };
            counters.set(sk, ser);
          }
          ser.pts.push({ atMs: s.timestampMs ?? sc.atMs ?? ser.pts.length, count: s.value });
        }
      }
    }
  }
  // Counters: latest cumulative value per series; rate from first → last scrape when timestamps exist.
  const cTotals = new Map<string, { count: number; errors: number; rps?: number }>();
  for (const ser of counters.values()) {
    const first = ser.pts.reduce((x, y) => (y.atMs < x.atMs ? y : x));
    const last = ser.pts.reduce((x, y) => (y.atMs >= x.atMs ? y : x));
    const t = cTotals.get(ser.k) ?? { count: 0, errors: 0 };
    t.count += last.count;
    if (ser.status >= 500) t.errors += last.count;
    if (ser.pts.length >= 2 && last.atMs > first.atMs)
      t.rps = (t.rps ?? 0) + Math.max(0, last.count - first.count) / ((last.atMs - first.atMs) / 1000);
    cTotals.set(ser.k, t);
  }
  for (const [k, t] of cTotals) {
    const a = aggs.get(k);
    if (!a) continue;
    // Histograms win for counts (avoid double counting); counters fill in when no histogram exists.
    if (a.count === 0) {
      a.count = t.count;
      a.errors = t.errors;
    }
    if (t.rps !== undefined) a.rps = t.rps;
  }
  if (aggs.size === 0) return set;
  set.coverage.metrics = true;
  routeObs(set, aggs.values(), { start: "", end: "" });
  return set;
}

/** Reliability Lab results: a controlled experiment proves the primary service depends on the dependency. */
export function fromReliability(results: readonly unknown[]): ObservationSet {
  const set = emptySet();
  for (const r0 of results) {
    const d = isObj(r0) && isObj(r0.data) ? r0.data : r0;
    if (!isObj(d) || typeof d.dependency !== "string") continue;
    set.coverage.experiments = true;
    const runId = isObj(r0) && typeof r0.runId === "string" ? r0.runId : "experiment";
    const dep = d.dependency;
    const verdict = typeof d.verdict === "string" ? d.verdict : "unknown";
    const scenario = typeof d.scenario === "string" ? d.scenario : "fault";
    const ev: ModelEvidence = {
      source: "experiment",
      confidence: DEFAULT_CONFIDENCE.experiment,
      origin: `reliability:${runId}`,
      detail: `${scenario} injected into ${dep}: hypothesis ${verdict}`,
    };
    const key = `exp:${dep.toLowerCase()}`;
    const stem = normalizeName(dep);
    set.nodes.push({
      key,
      kind: "external",
      name: dep,
      evidence: [ev],
      serviceNames: [dep.toLowerCase()],
      ...(stem ? { envStems: [stem] } : {}),
    });
    set.edges.push({ from: PRIMARY_KEY, to: key, kind: "calls", evidence: [ev] });
    const reproduced = Array.isArray(d.reproduced) ? d.reproduced.filter(isObj) : [];
    const fm = reproduced
      .filter((x) => typeof x.ruleId === "string")
      .map((x) => ({
        id: String(x.ruleId),
        title: `${String(x.ruleId)} when ${dep} fails (${Number(x.hits) || 0}/${Number(x.runs) || 0} runs)`,
        source: "reliability",
      }));
    if (fm.length > 0)
      set.nodes.push({
        key: PRIMARY_KEY,
        kind: "service",
        name: "app",
        evidence: [ev],
        failureModes: fm,
        fuzzy: false,
      });
  }
  return set;
}
