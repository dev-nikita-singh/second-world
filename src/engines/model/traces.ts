/**
 * Trace analysis — docs/03-engines/system-model.md §3 ("Trace → graph"), DSA §5.6 (critical path).
 *
 * - Span tree per trace from a parent map (spans may arrive out of order; missing parents → orphan roots;
 *   malformed parent cycles are broken deterministically).
 * - Critical path (Jaeger-style, iterative): walk backwards from the end of a span; the child that finishes
 *   last (before the cursor) is on the path, the cursor jumps to its start; gaps are the parent's self-time.
 *   Hence sequential children add up and parallel children contribute only the longest (max).
 */
import type { NormalizedSpan } from "../../adapters/telemetry/otlp.js";

export interface SpanNode {
  span: NormalizedSpan;
  parent?: SpanNode;
  children: SpanNode[];
}

export interface TraceTree {
  traceId: string;
  roots: SpanNode[];
  nodes: Map<string, SpanNode>;
  /** Spans whose parentSpanId is set but not present in the trace. */
  orphans: number;
  /** Parent links dropped to break cycles / self-parenting. */
  brokenLinks: number;
}

export function buildTraceTrees(spans: readonly NormalizedSpan[]): TraceTree[] {
  const byTrace = new Map<string, NormalizedSpan[]>();
  for (const s of spans) {
    let l = byTrace.get(s.traceId);
    if (!l) {
      l = [];
      byTrace.set(s.traceId, l);
    }
    l.push(s);
  }
  const out: TraceTree[] = [];
  for (const [traceId, list] of byTrace) out.push(buildTree(traceId, list));
  return out;
}

const byStart = (a: SpanNode, b: SpanNode): number =>
  a.span.startUs - b.span.startUs || a.span.endUs - b.span.endUs || (a.span.spanId < b.span.spanId ? -1 : 1);

function buildTree(traceId: string, list: readonly NormalizedSpan[]): TraceTree {
  const nodes = new Map<string, SpanNode>();
  for (const s of list) if (!nodes.has(s.spanId)) nodes.set(s.spanId, { span: s, children: [] });
  const roots: SpanNode[] = [];
  let orphans = 0;
  let broken = 0;
  for (const n of nodes.values()) {
    const pid = n.span.parentSpanId;
    if (pid === undefined) {
      roots.push(n);
      continue;
    }
    const p = nodes.get(pid);
    if (!p || p === n) {
      if (p === n) broken++;
      else orphans++;
      roots.push(n);
      continue;
    }
    n.parent = p;
    p.children.push(n);
  }
  // Break parent cycles: every node must be reachable from a root.
  const seen = new Set<SpanNode>();
  const mark = (r: SpanNode) => {
    const stack = [r];
    while (stack.length > 0) {
      const x = stack.pop() as SpanNode;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const c of x.children) stack.push(c);
    }
  };
  for (const r of roots) mark(r);
  if (seen.size < nodes.size) {
    const rest = [...nodes.values()].filter((n) => !seen.has(n)).sort(byStart);
    for (const n of rest) {
      if (seen.has(n)) continue;
      const p = n.parent;
      if (p) p.children = p.children.filter((c) => c !== n);
      delete n.parent;
      broken++;
      roots.push(n);
      mark(n);
    }
  }
  for (const n of nodes.values()) n.children.sort(byStart);
  roots.sort(byStart);
  return { traceId, roots, nodes, orphans, brokenLinks: broken };
}

export interface PathSegment {
  node: SpanNode;
  startUs: number;
  endUs: number;
}

/**
 * Critical path of the subtree under `root`, as time-ordered self-time segments.
 * The sum of segment durations equals the root's duration (children are clamped to their parent).
 */
export function criticalPath(root: SpanNode): PathSegment[] {
  interface Frame {
    node: SpanNode;
    lo: number;
    cursor: number;
    order: SpanNode[];
    idx: number;
  }
  const desc = (n: SpanNode): SpanNode[] =>
    n.children
      .slice()
      .sort(
        (a, b) =>
          b.span.endUs - a.span.endUs ||
          b.span.startUs - a.span.startUs ||
          (a.span.spanId < b.span.spanId ? -1 : 1),
      );
  const segs: PathSegment[] = [];
  const emit = (node: SpanNode, startUs: number, endUs: number) => {
    if (endUs > startUs) segs.push({ node, startUs, endUs });
  };
  const stack: Frame[] = [
    { node: root, lo: root.span.startUs, cursor: root.span.endUs, order: desc(root), idx: 0 },
  ];
  while (stack.length > 0) {
    const f = stack[stack.length - 1] as Frame;
    if (f.idx < f.order.length) {
      const c = f.order[f.idx++] as SpanNode;
      if (c.span.startUs >= f.cursor || c.span.endUs <= f.lo) continue;
      const childEnd = Math.min(c.span.endUs, f.cursor);
      const childLo = Math.max(c.span.startUs, f.lo);
      emit(f.node, childEnd, f.cursor);
      f.cursor = childLo;
      stack.push({ node: c, lo: childLo, cursor: childEnd, order: desc(c), idx: 0 });
      continue;
    }
    emit(f.node, f.lo, f.cursor);
    stack.pop();
  }
  segs.reverse();
  return segs;
}

export type PeerKind = "external" | "datastore" | "cache" | "queue";

export interface PeerInfo {
  /** Display name: peer.service, db.name/db.system, messaging destination, or host. */
  name: string;
  kind: PeerKind;
  /** `service-name` tokens (peer.service, non-IP server.address). */
  serviceNames: string[];
  /** `host:port` tokens. */
  hosts: string[];
  system?: string;
  /** reads / writes / publishes / consumes / calls */
  op: "calls" | "reads" | "writes" | "publishes" | "consumes";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const CACHE_SYSTEMS = new Set(["redis", "memcached", "valkey", "hazelcast"]);

export function isIp(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

function urlHostPort(u: string): { host: string; port?: number } | undefined {
  try {
    const x = new URL(u);
    const port = x.port
      ? Number(x.port)
      : x.protocol === "https:"
        ? 443
        : x.protocol === "http:"
          ? 80
          : undefined;
    return port === undefined ? { host: x.hostname.toLowerCase() } : { host: x.hostname.toLowerCase(), port };
  } catch {
    return undefined;
  }
}

/** Dependency described by a CLIENT / PRODUCER / CONSUMER span (OTel semantic conventions, old and new). */
export function peerOf(s: NormalizedSpan): PeerInfo | undefined {
  if (s.kind !== "client" && s.kind !== "producer" && s.kind !== "consumer") {
    // Internal spans with db.system (e.g. hand-instrumented in-memory db) still describe a datastore.
    if (!str(s.attributes["db.system"]) && !str(s.attributes["db.system.name"])) return undefined;
  }
  const a = s.attributes;
  let host = str(a["server.address"]) ?? str(a["net.peer.name"]) ?? str(a["net.sock.peer.addr"]);
  let port = Number(a["server.port"] ?? a["net.peer.port"] ?? Number.NaN);
  const url = str(a["url.full"]) ?? str(a["http.url"]);
  if (url && (!host || !Number.isFinite(port))) {
    const hp = urlHostPort(url);
    if (hp) {
      host ??= hp.host;
      if (!Number.isFinite(port) && hp.port !== undefined) port = hp.port;
    }
  }
  host = host?.toLowerCase();
  const peerService = str(a["peer.service"]);
  const dbSystem = str(a["db.system"]) ?? str(a["db.system.name"]);
  const msgSystem = str(a["messaging.system"]);
  const hosts: string[] = [];
  if (host && Number.isFinite(port)) hosts.push(`${host}:${port}`);
  const serviceNames: string[] = [];
  if (peerService) serviceNames.push(peerService);
  if (host && !isIp(host) && host !== "localhost") serviceNames.push(host);
  if (dbSystem) {
    const kind: PeerKind = CACHE_SYSTEMS.has(dbSystem.toLowerCase()) ? "cache" : "datastore";
    const name = peerService ?? str(a["db.namespace"]) ?? str(a["db.name"]) ?? dbSystem;
    const opText = (
      str(a["db.operation.name"]) ??
      str(a["db.operation"]) ??
      str(a["db.query.text"]) ??
      str(a["db.statement"]) ??
      s.name
    )
      .trim()
      .toUpperCase();
    const op = /^(SELECT|GET|FIND|READ|MGET|HGET|SCAN|QUERY|COUNT|EXISTS)/.test(opText)
      ? "reads"
      : /^(INSERT|UPDATE|DELETE|UPSERT|SET|PUT|WRITE|DEL|HSET|INCR|MERGE|REPLACE|CREATE|DROP|ALTER)/.test(
            opText,
          )
        ? "writes"
        : "calls";
    return { name, kind, serviceNames, hosts, system: dbSystem, op };
  }
  if (msgSystem) {
    const dest = str(a["messaging.destination.name"]) ?? str(a["messaging.destination"]) ?? msgSystem;
    return {
      name: peerService ?? dest,
      kind: "queue",
      serviceNames,
      hosts,
      system: msgSystem,
      op: s.kind === "consumer" ? "consumes" : "publishes",
    };
  }
  if (s.kind !== "client") return undefined;
  const name = peerService ?? (host && Number.isFinite(port) && isIp(host) ? `${host}:${port}` : host);
  if (!name) return undefined;
  return { name, kind: "external", serviceNames, hosts, op: "calls" };
}

/** HTTP method + route of a SERVER span (http.route preferred; falls back to "GET /x" span names). */
export function serverRouteOf(s: NormalizedSpan): { method: string; path: string } | undefined {
  if (s.kind !== "server") return undefined;
  const a = s.attributes;
  const method = (str(a["http.request.method"]) ?? str(a["http.method"]))?.toUpperCase();
  const route = str(a["http.route"]);
  if (method && route) return { method, path: route };
  const m = /^([A-Z]+)\s+(\/\S*)$/.exec(s.name);
  if (m) return { method: m[1] as string, path: m[2] as string };
  return undefined;
}

/** Status ≥ 500 or span status ERROR. */
export function isErrorSpan(s: NormalizedSpan): boolean {
  if (s.status === "error") return true;
  const code = Number(s.attributes["http.response.status_code"] ?? s.attributes["http.status_code"] ?? 0);
  return code >= 500;
}

/** host:port identities a SERVER span reveals about its own service. */
export function serverHostsOf(s: NormalizedSpan): string[] {
  const a = s.attributes;
  const host = (
    str(a["server.address"]) ??
    str(a["net.host.name"]) ??
    str(a["http.host"])?.split(":")[0]
  )?.toLowerCase();
  const port = Number(
    a["server.port"] ?? a["net.host.port"] ?? str(a["http.host"])?.split(":")[1] ?? Number.NaN,
  );
  return host && Number.isFinite(port) ? [`${host}:${port}`] : [];
}
