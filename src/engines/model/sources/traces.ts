/**
 * OTLP spans → observations (runtime evidence 0.95, docs/03-engines/system-model.md §1, §3).
 * Aggregates edges by (service, peer) and (route, peer) with callsPerRequest and p95, and computes the
 * critical path per trace with time attributed to "self" (the root service) or the dependency that owns it.
 */
import type { NormalizedSpan } from "../../../adapters/telemetry/otlp.js";
import { quantile, sortedCopy } from "../../../shared/stats/quantile.js";
import { DEFAULT_CONFIDENCE } from "../confidence.js";
import {
  buildTraceTrees,
  criticalPath,
  isErrorSpan,
  type PeerInfo,
  peerOf,
  type SpanNode,
  serverHostsOf,
  serverRouteOf,
} from "../traces.js";
import type { ModelEdgeKind, ModelEvidence, TraceSummary } from "../types.js";
import {
  emptySet,
  type NodeObservation,
  normHostPort,
  normRoutePath,
  type ObservationSet,
} from "./observation.js";

export interface PendingCriticalPath {
  traceId: string;
  rootSpanId: string;
  root: string;
  routeKey?: string;
  durationMs: number;
  segments: { spanId: string; name: string; service: string; key: string; ms: number }[];
}

export interface TraceObservationSet extends ObservationSet {
  pendingCritical: PendingCriticalPath[];
}

export interface TraceSourceOptions {
  origin?: string;
  droppedSpans?: number;
  /** Keep at most this many critical paths (longest first). Default 50. */
  maxCriticalPaths?: number;
}

const svcKey = (s: string) => `trace:svc:${s}`;
const peerKey = (p: PeerInfo) => `trace:peer:${p.kind}:${p.name.toLowerCase()}`;
const routeKey = (svc: string, method: string, path: string) =>
  `trace:route:${svc}:${method} ${normRoutePath(path)}`;

interface Agg {
  count: number;
  errors: number;
  durations: number[];
  traces: Set<string>;
}
const newAgg = (): Agg => ({ count: 0, errors: 0, durations: [], traces: new Set() });
const addAgg = (a: Agg, s: NormalizedSpan) => {
  a.count++;
  if (isErrorSpan(s)) a.errors++;
  a.durations.push(s.durationUs / 1000);
  if (a.traces.size < 1000) a.traces.add(s.traceId);
};
const p95 = (xs: number[]): number =>
  Math.round(quantile(sortedCopy(xs), 0.95, "nearest-rank") * 1000) / 1000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function fromTraces(
  spans: readonly NormalizedSpan[],
  opts: TraceSourceOptions = {},
): TraceObservationSet {
  const set: TraceObservationSet = { ...emptySet(), pendingCritical: [] };
  const origin = opts.origin ?? "otlp";
  if (spans.length === 0) return set;
  set.coverage.traces = true;
  const trees = buildTraceTrees(spans);
  let minUs = Number.POSITIVE_INFINITY;
  let maxUs = 0;
  for (const s of spans) {
    if (s.startUs < minUs) minUs = s.startUs;
    if (s.endUs > maxUs) maxUs = s.endUs;
  }
  const window = { start: new Date(minUs / 1000).toISOString(), end: new Date(maxUs / 1000).toISOString() };
  const windowS = Math.max(1, (maxUs - minUs) / 1e6);
  const ev = (detail: string, agg?: Agg): ModelEvidence => ({
    source: "trace",
    confidence: DEFAULT_CONFIDENCE.trace,
    origin,
    detail,
    ...(agg ? { count: agg.count, traceIds: [...agg.traces].slice(0, 5) } : {}),
  });

  const services = new Map<string, { agg: Agg; hosts: Set<string>; server: number }>();
  const routes = new Map<string, { svc: string; method: string; path: string; agg: Agg }>();
  const peers = new Map<string, { info: PeerInfo; agg: Agg; hosts: Set<string>; names: Set<string> }>();
  const svcEdges = new Map<string, { from: string; to: string; kind: ModelEdgeKind; agg: Agg }>();
  const routeEdges = new Map<string, { from: string; to: string; kind: ModelEdgeKind; agg: Agg }>();
  const links = new Map<string, { a: string; b: string; detail: string }>();
  let orphans = 0;

  const edge = (m: typeof svcEdges, from: string, to: string, kind: ModelEdgeKind, s: NormalizedSpan) => {
    const k = `${from}\u0000${to}\u0000${kind}`;
    let e = m.get(k);
    if (!e) {
      e = { from, to, kind, agg: newAgg() };
      m.set(k, e);
    }
    addAgg(e.agg, s);
  };

  /** Route key of the nearest same-service SERVER ancestor (or self). */
  const owningRoute = (n: SpanNode): string | undefined => {
    for (let c: SpanNode | undefined = n; c; c = c.parent) {
      if (c.span.service !== n.span.service) return undefined;
      const r = serverRouteOf(c.span);
      if (r) return routeKey(c.span.service, r.method, r.path);
    }
    return undefined;
  };

  for (const t of trees) {
    orphans += t.orphans;
    for (const n of t.nodes.values()) {
      const s = n.span;
      let sv = services.get(s.service);
      if (!sv) {
        sv = { agg: newAgg(), hosts: new Set(), server: 0 };
        services.set(s.service, sv);
      }
      addAgg(sv.agg, s);
      if (s.kind === "server") {
        sv.server++;
        for (const h of serverHostsOf(s)) {
          const [host, port] = [h.slice(0, h.lastIndexOf(":")), h.slice(h.lastIndexOf(":") + 1)];
          const hp = normHostPort(host, port);
          if (hp) sv.hosts.add(hp);
        }
        const r = serverRouteOf(s);
        if (r) {
          const k = routeKey(s.service, r.method, r.path);
          let ra = routes.get(k);
          if (!ra) {
            ra = { svc: s.service, method: r.method, path: normRoutePath(r.path), agg: newAgg() };
            routes.set(k, ra);
          }
          addAgg(ra.agg, s);
        }
        // Cross-service hop without client instrumentation: parent in another service.
        const p = n.parent;
        if (p && p.span.service !== s.service && !peerOf(p.span))
          edge(svcEdges, svcKey(p.span.service), svcKey(s.service), "calls", s);
      }
      const peer = peerOf(s);
      if (!peer) continue;
      const pk = peerKey(peer);
      let pa = peers.get(pk);
      if (!pa) {
        pa = { info: peer, agg: newAgg(), hosts: new Set(), names: new Set() };
        peers.set(pk, pa);
      }
      addAgg(pa.agg, s);
      for (const h of peer.hosts) {
        const i = h.lastIndexOf(":");
        const hp = normHostPort(h.slice(0, i), h.slice(i + 1));
        if (hp) pa.hosts.add(hp);
      }
      for (const nm of peer.serviceNames) pa.names.add(nm.toLowerCase());
      edge(svcEdges, svcKey(s.service), pk, peer.op, s);
      const rk = owningRoute(n);
      if (rk) edge(routeEdges, rk, pk, peer.op, s);
      // Client span whose child is a server span of another service → same entity.
      for (const c of n.children) {
        if (c.span.service !== s.service && (c.span.kind === "server" || c.span.kind === "consumer")) {
          const k = `${pk}\u0000${c.span.service}`;
          if (!links.has(k))
            links.set(k, {
              a: pk,
              b: svcKey(c.span.service),
              detail: `client span ${s.spanId} → server span ${c.span.spanId} (${c.span.service})`,
            });
        }
      }
    }
  }

  // Nodes.
  for (const [name, sv] of services) {
    const requests = sv.server;
    const node: NodeObservation = {
      key: svcKey(name),
      kind: "service",
      name,
      evidence: [ev(`service.name=${name}, ${sv.agg.count} spans`, sv.agg)],
      serviceNames: [name.toLowerCase()],
      ...(sv.hosts.size ? { hosts: [...sv.hosts] } : {}),
    };
    if (requests > 0) {
      const serverDur: number[] = [];
      let errs = 0;
      for (const t of trees)
        for (const n of t.nodes.values())
          if (
            n.span.service === name &&
            n.span.kind === "server" &&
            (!n.parent || n.parent.span.service !== name)
          ) {
            serverDur.push(n.span.durationUs / 1000);
            if (isErrorSpan(n.span)) errs++;
          }
      if (serverDur.length > 0)
        node.observed = {
          rps: r3(serverDur.length / windowS),
          p95Ms: p95(serverDur),
          errorRate: r3(errs / serverDur.length),
          requests: serverDur.length,
          window,
          source: "trace",
        };
    }
    set.nodes.push(node);
  }
  for (const [k, r] of routes) {
    set.nodes.push({
      key: k,
      kind: "route",
      name: `${r.method} ${r.path}`,
      route: { method: r.method, path: r.path, serviceKey: svcKey(r.svc) },
      evidence: [ev(`server span ${r.method} ${r.path} in ${r.svc}`, r.agg)],
      observed: {
        rps: r3(r.agg.count / windowS),
        p95Ms: p95(r.agg.durations),
        errorRate: r3(r.agg.errors / r.agg.count),
        requests: r.agg.count,
        window,
        source: "trace",
      },
      fuzzy: false,
    });
  }
  for (const [k, p] of peers) {
    const attrs = [
      ...[...p.names].map((n) => `peer=${n}`),
      ...[...p.hosts].map((h) => `addr=${h}`),
      ...(p.info.system ? [`system=${p.info.system}`] : []),
    ];
    set.nodes.push({
      key: k,
      kind: p.info.kind,
      name: p.info.name,
      evidence: [ev(`${p.info.kind} called from spans (${attrs.join(", ")})`, p.agg)],
      ...(p.hosts.size ? { hosts: [...p.hosts] } : {}),
      ...(p.names.size ? { serviceNames: [...p.names] } : {}),
    });
  }
  // Edges with callsPerRequest relative to the caller's request count.
  const requestsOf = (key: string): number => {
    if (key.startsWith("trace:route:")) return routes.get(key)?.agg.count ?? 0;
    const sv = services.get(key.slice("trace:svc:".length));
    return sv ? sv.server || sv.agg.traces.size : 0;
  };
  for (const m of [svcEdges, routeEdges]) {
    for (const e of m.values()) {
      const req = requestsOf(e.from);
      set.edges.push({
        from: e.from,
        to: e.to,
        kind: e.kind,
        evidence: [ev(`observed ${e.agg.count}× in ${e.agg.traces.size} traces`, e.agg)],
        observed: {
          calls: e.agg.count,
          ...(req > 0 ? { callsPerRequest: r3(e.agg.count / req) } : {}),
          p95Ms: p95(e.agg.durations),
          errorRate: r3(e.agg.errors / e.agg.count),
        },
      });
    }
  }
  for (const l of links.values()) set.links.push({ a: l.a, b: l.b, rule: "trace-link", detail: l.detail });

  // Critical paths.
  const crit: PendingCriticalPath[] = [];
  for (const t of trees) {
    for (const root of t.roots) {
      const rs = root.span;
      const segs = criticalPath(root);
      const attribute = (n: SpanNode): string => {
        let attr: string | undefined;
        for (let c: SpanNode | undefined = n; c && c !== root.parent; c = c.parent) {
          if (c.span.service !== rs.service) {
            // Inside another service: attribute to the hop (client span if any, else that service).
            attr = undefined;
            const p = c.parent;
            if (p && p.span.service === rs.service) {
              const pi = peerOf(p.span);
              attr = pi ? peerKey(pi) : svcKey(c.span.service);
              return attr;
            }
            continue;
          }
          const pi = peerOf(c.span);
          if (pi) attr = peerKey(pi);
        }
        return attr ?? svcKey(rs.service);
      };
      const merged: PendingCriticalPath["segments"] = [];
      for (const sg of segs) {
        const ms = (sg.endUs - sg.startUs) / 1000;
        const key = attribute(sg.node);
        const last = merged[merged.length - 1];
        if (last && last.spanId === sg.node.span.spanId) last.ms += ms;
        else
          merged.push({
            spanId: sg.node.span.spanId,
            name: sg.node.span.name,
            service: sg.node.span.service,
            key,
            ms,
          });
      }
      for (const m of merged) m.ms = r3(m.ms);
      const r = serverRouteOf(rs);
      crit.push({
        traceId: t.traceId,
        rootSpanId: rs.spanId,
        root: `${rs.service}: ${rs.name}`,
        ...(r ? { routeKey: routeKey(rs.service, r.method, r.path) } : {}),
        durationMs: r3(rs.durationUs / 1000),
        segments: merged,
      });
    }
  }
  crit.sort((a, b) => b.durationMs - a.durationMs || (a.traceId < b.traceId ? -1 : 1));
  set.pendingCritical = crit;
  const summary: TraceSummary = {
    traces: trees.length,
    spans: spans.length,
    services: [...services.keys()].sort(),
    orphanSpans: orphans,
    droppedSpans: opts.droppedSpans ?? 0,
    window,
    criticalPaths: [],
    dominant: [],
  };
  set.traces = summary;
  if (orphans > 0)
    set.limitations.push({
      code: "MODEL_TRACE_ORPHANS",
      message: `${orphans} span(s) reference a parent that was not received (incomplete traces); they are treated as roots`,
      impact: "reduces-confidence",
    });
  return set;
}
