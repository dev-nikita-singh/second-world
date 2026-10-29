/**
 * Normalised observations: every evidence source (architecture, OpenAPI, config, traces, metrics,
 * performance, findings, AI) is converted into these before entity resolution
 * (docs/03-engines/system-model.md §3). Keys are namespaced per source (`arch:…`, `trace:…`, `compose:…`).
 */
import type { Limitation } from "../../../core/evidence/schemas.js";
import type {
  CoverageSource,
  FailureMode,
  MergeRule,
  ModelEdgeKind,
  ModelEvidence,
  ModelNodeKind,
  ObservedEdgeMetrics,
  ObservedNodeMetrics,
  TraceSummary,
} from "../types.js";

/** Key of the project's own service (shared by all static sources). */
export const PRIMARY_KEY = "app:primary";

export interface NodeObservation {
  key: string;
  kind: ModelNodeKind;
  name: string;
  aliases?: string[];
  evidence: ModelEvidence[];
  /** `host:port` identities (normalised, lower-case). */
  hosts?: string[];
  /** OTel service.name / peer.service / compose / k8s service names. */
  serviceNames?: string[];
  /** Env-var stems (`PAYMENTS_URL` → `payments`) and client names that may be configured by env vars. */
  envStems?: string[];
  /** Routes. */
  route?: { method: string; path: string; serviceKey: string };
  /** Handlers / modules owned by a service. */
  serviceKey?: string;
  observed?: ObservedNodeMetrics;
  failureModes?: FailureMode[];
  /** Participates in Jaro-Winkler proposals (default true for non-route nodes). */
  fuzzy?: boolean;
}

export interface EdgeObservation {
  from: string;
  to: string;
  kind: ModelEdgeKind;
  evidence: ModelEvidence[];
  observed?: ObservedEdgeMetrics;
}

export interface LinkObservation {
  a: string;
  b: string;
  rule: MergeRule;
  detail: string;
}

export interface ObservationSet {
  nodes: NodeObservation[];
  edges: EdgeObservation[];
  links: LinkObservation[];
  limitations: Limitation[];
  coverage: Partial<Record<CoverageSource, boolean>>;
  traces?: TraceSummary;
  /** Critical-path attribution keyed by observation keys (resolved to node ids later). */
  pendingCritical?: unknown;
}

export function emptySet(): ObservationSet {
  return { nodes: [], edges: [], links: [], limitations: [], coverage: {} };
}

export function mergeSets(sets: readonly ObservationSet[]): ObservationSet {
  const out = emptySet();
  for (const s of sets) {
    out.nodes.push(...s.nodes);
    out.edges.push(...s.edges);
    out.links.push(...s.links);
    for (const l of s.limitations)
      if (!out.limitations.some((x) => x.code === l.code && x.message === l.message)) out.limitations.push(l);
    for (const [k, v] of Object.entries(s.coverage)) if (v) out.coverage[k as CoverageSource] = true;
    if (s.traces) out.traces = s.traces;
    if (s.pendingCritical !== undefined) out.pendingCritical = s.pendingCritical;
  }
  return out;
}

/** Normalise `host:port`: lower-case, strip brackets, map localhost/::1/0.0.0.0 → 127.0.0.1. */
export function normHostPort(host: string, port: number | string | undefined): string | undefined {
  if (port === undefined || port === "") return undefined;
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return undefined;
  let h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::" || h === "host.docker.internal")
    h = "127.0.0.1";
  if (h === "") return undefined;
  return `${h}:${p}`;
}

/** URL → host:port (+ hostname when not an IP / localhost). Credentials, path and query are never kept. */
export function urlIdentity(
  raw: string,
): { hostPort?: string; hostname?: string; scheme: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!u.hostname) return undefined;
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const defaults: Record<string, number> = {
    http: 80,
    https: 443,
    postgres: 5432,
    postgresql: 5432,
    mysql: 3306,
    redis: 6379,
    rediss: 6379,
    amqp: 5672,
    amqps: 5671,
    mongodb: 27017,
    nats: 4222,
    kafka: 9092,
  };
  const port = u.port ? Number(u.port) : defaults[scheme];
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const out: { hostPort?: string; hostname?: string; scheme: string } = { scheme };
  const hp = port !== undefined ? normHostPort(hostname, port) : undefined;
  if (hp) out.hostPort = hp;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(":") && hostname !== "localhost")
    out.hostname = hostname;
  return out;
}

/** Kind implied by a URL scheme. */
export function kindForScheme(scheme: string): ModelNodeKind {
  if (/^(postgres|postgresql|mysql|mariadb|mongodb(\+srv)?|mssql|sqlserver|cockroachdb|sqlite)$/.test(scheme))
    return "datastore";
  if (/^(redis|rediss|memcached)$/.test(scheme)) return "cache";
  if (/^(amqp|amqps|kafka|nats|sqs|mqtt)$/.test(scheme)) return "queue";
  return "external";
}

/** Normalise a route path to OpenAPI style: `:id` → `{id}`, trailing slash removed. */
export function normRoutePath(p: string): string {
  let s = p.trim().split("?")[0] ?? "";
  s = s.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/<[^>]+>/g, "{param}");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.startsWith("/") ? s : `/${s}`;
}

/** Route signature for matching: parameters anonymised. */
export function routeSignature(method: string, path: string): string {
  return `${method.toUpperCase()} ${normRoutePath(path).replace(/\{[^}]*\}/g, "{}")}`;
}

/** Regex that matches concrete paths against a route template (`/products/{id}` ↔ `/products/42`). */
export function routeRegex(path: string): RegExp {
  const parts = normRoutePath(path)
    .split(/\{[^}]*\}/)
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}/?$`);
}
