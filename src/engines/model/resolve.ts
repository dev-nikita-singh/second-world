/**
 * Entity resolution with union-find — docs/03-engines/system-model.md §3, DSA §5.8 / §5.9.
 *
 * Rules, strongest first (each union is recorded as merge provenance):
 *  1. explicit links: `trace-link` (client span → server span of another service), `k8s-selector`
 *  2. `host-port`: same normalised host:port (localhost ≡ 127.0.0.1)
 *  3. `service-name`: same OTel service.name / peer.service / server.address / compose / k8s DNS name
 *  4. `env-url`: env var stem (`PAYMENTS_URL` → payments) ↔ client/service name in code or config
 *  5. `name-similarity`: Jaro-Winkler ≥ threshold on normalised names AND compatible kinds → PROPOSED
 *     merge with lowered confidence; never between groups with disjoint known addresses or two
 *     distinct traced services; never on IP/host:port-like names.
 *  6. `route-signature`: routes of the same resolved service with the same METHOD + path (params anonymised).
 * Kind compatibility is checked for the whole group at union time (transitive merges cannot chain
 * a datastore into a queue).
 */
import { KeyedUnionFind } from "../../shared/ds/union-find.js";
import { jaroWinkler, normalizeName, stem } from "./similarity.js";
import type { LinkObservation, NodeObservation } from "./sources/observation.js";
import { routeSignature } from "./sources/observation.js";
import type { MergeRecord, MergeRule, ModelNodeKind } from "./types.js";

export interface ResolveOptions {
  /** Jaro-Winkler threshold (default 0.92). */
  threshold?: number;
  /** Enable name-similarity proposals (default true). */
  fuzzy?: boolean;
  /** Skip fuzzy matching when there are more candidate groups than this (O(n²)). Default 3000. */
  maxFuzzyGroups?: number;
}

export interface ResolvedGroup {
  root: string;
  keys: string[];
  observations: NodeObservation[];
  merges: Omit<MergeRecord, "node">[];
  /** Product of proposed-merge confidences (1 when only exact rules). */
  multiplier: number;
  proposed: boolean;
}

export interface ResolveResult {
  groups: ResolvedGroup[];
  groupOf: (key: string) => ResolvedGroup | undefined;
  /** Unions refused because of incompatible kinds. */
  refused: { a: string; b: string; rule: MergeRule; reason: string }[];
  fuzzySkipped: boolean;
}

const INFRA: ReadonlySet<ModelNodeKind> = new Set(["service", "external", "datastore", "cache", "queue"]);

function pairCompatible(a: ModelNodeKind, b: ModelNodeKind, fuzzy: boolean): boolean {
  if (a === b) return true;
  if (
    a === "route" ||
    b === "route" ||
    a === "handler" ||
    b === "handler" ||
    a === "module" ||
    b === "module"
  )
    return false;
  const pair = new Set([a, b]);
  if (pair.has("service") && pair.has("external")) return true;
  if (fuzzy) return false;
  // Strong identity (same address / DNS name): a service or external endpoint may be a datastore/cache/queue.
  if (pair.has("service") || pair.has("external")) return true;
  return pair.has("datastore") && pair.has("cache");
}

export function kindsCompatible(
  a: Iterable<ModelNodeKind>,
  b: Iterable<ModelNodeKind>,
  fuzzy = false,
): boolean {
  const bs = [...b];
  for (const x of a) for (const y of bs) if (!pairCompatible(x, y, fuzzy)) return false;
  return true;
}

const ipLike = (n: string): boolean => /^[\d.:[\]]+$/.test(n) || /^[a-z0-9.-]+:\d+$/i.test(n);

export function resolveEntities(
  nodes: readonly NodeObservation[],
  links: readonly LinkObservation[],
  opts: ResolveOptions = {},
): ResolveResult {
  const threshold = opts.threshold ?? 0.92;
  const uf = new KeyedUnionFind();
  const byKey = new Map<string, NodeObservation[]>();
  for (const n of nodes) {
    let l = byKey.get(n.key);
    if (!l) {
      l = [];
      byKey.set(n.key, l);
      uf.add(n.key);
    }
    l.push(n);
  }
  const kinds = new Map<string, Set<ModelNodeKind>>();
  for (const [k, obs] of byKey) kinds.set(k, new Set(obs.map((o) => o.kind)));
  const records = new Map<string, Omit<MergeRecord, "node">[]>();
  const refused: ResolveResult["refused"] = [];

  const union = (
    a: string,
    b: string,
    rule: MergeRule,
    detail: string,
    confidence = 1,
    proposed = false,
  ): boolean => {
    if (!byKey.has(a) || !byKey.has(b)) return false;
    const ra = uf.find(a);
    const rb = uf.find(b);
    if (ra === rb) return false;
    const ka = kinds.get(ra) as Set<ModelNodeKind>;
    const kb = kinds.get(rb) as Set<ModelNodeKind>;
    if (!kindsCompatible(ka, kb, proposed)) {
      if (refused.length < 200)
        refused.push({
          a,
          b,
          rule,
          reason: `incompatible kinds ${[...ka].join("/")} vs ${[...kb].join("/")}`,
        });
      return false;
    }
    uf.union(ra, rb);
    const r = uf.find(a);
    const merged = new Set([...ka, ...kb]);
    kinds.set(r, merged);
    const recs = [
      ...(records.get(ra) ?? []),
      ...(records.get(rb) ?? []),
      { rule, a, b, detail, confidence, proposed },
    ];
    records.delete(ra);
    records.delete(rb);
    records.set(r, recs);
    return true;
  };

  // 1. Explicit links.
  for (const l of links) union(l.a, l.b, l.rule, l.detail);

  const identityObs = nodes.filter((n) => INFRA.has(n.kind));
  // 2./3. Token rules.
  const tokenRule = (tokens: (n: NodeObservation) => string[] | undefined, rule: MergeRule) => {
    const index = new Map<string, string>();
    for (const n of identityObs) {
      for (const t of tokens(n) ?? []) {
        const prev = index.get(t);
        if (prev === undefined) index.set(t, n.key);
        else if (prev !== n.key) union(prev, n.key, rule, t);
      }
    }
  };
  tokenRule((n) => n.hosts, "host-port");
  tokenRule((n) => n.serviceNames?.map((s) => s.toLowerCase()), "service-name");

  // 4. env-url: env-derived observation ↔ non-env observation with the same stem.
  const stemIndex = new Map<string, string[]>();
  for (const n of identityObs) {
    if (n.key.startsWith("env:")) continue;
    for (const s of n.envStems ?? []) {
      const k = stem(s);
      if (!k) continue;
      const l = stemIndex.get(k) ?? [];
      if (!l.includes(n.key)) l.push(n.key);
      stemIndex.set(k, l);
    }
  }
  for (const n of identityObs) {
    if (!n.key.startsWith("env:")) continue;
    for (const s of n.envStems ?? []) {
      for (const other of stemIndex.get(stem(s)) ?? [])
        union(n.key, other, "env-url", `${(n.aliases ?? [n.name]).join(",")} ↔ ${other}`);
    }
  }

  // 5. Name similarity (proposed merges).
  let fuzzySkipped = false;
  if (opts.fuzzy !== false) {
    interface G {
      root: string;
      names: string[];
      hosts: Set<string>;
      tracedServices: Set<string>;
    }
    const gmap = new Map<string, G>();
    for (const n of identityObs) {
      if (n.fuzzy === false) continue;
      const r = uf.find(n.key);
      let g = gmap.get(r);
      if (!g) {
        g = { root: r, names: [], hosts: new Set(), tracedServices: new Set() };
        gmap.set(r, g);
      }
      for (const nm of [n.name, ...(n.aliases ?? [])]) {
        if (ipLike(nm)) continue;
        const norm = normalizeName(nm);
        if (norm.length >= 2 && !g.names.includes(norm)) g.names.push(norm);
      }
      for (const h of n.hosts ?? []) g.hosts.add(h);
      if (n.key.startsWith("trace:svc:")) g.tracedServices.add(n.key);
    }
    // Hosts known for the whole group (including non-fuzzy members).
    for (const n of identityObs) {
      const g = gmap.get(uf.find(n.key));
      if (g) for (const h of n.hosts ?? []) g.hosts.add(h);
    }
    const groups = [...gmap.values()].filter((g) => g.names.length > 0);
    if (groups.length > (opts.maxFuzzyGroups ?? 3000)) fuzzySkipped = true;
    else {
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i] as G;
          const b = groups[j] as G;
          if (uf.find(a.root) === uf.find(b.root)) continue;
          if (a.hosts.size > 0 && b.hosts.size > 0 && ![...a.hosts].some((h) => b.hosts.has(h))) continue;
          if (a.tracedServices.size > 0 && b.tracedServices.size > 0) continue;
          let best = 0;
          let pair = "";
          for (const x of a.names)
            for (const y of b.names) {
              // Short names (< 4 chars) only match exactly: Jaro-Winkler is unreliable on them.
              const s = stem(x) === stem(y) ? 1 : Math.min(x.length, y.length) < 4 ? 0 : jaroWinkler(x, y);
              if (s > best) {
                best = s;
                pair = `${x}~${y}`;
              }
            }
          if (best < threshold) continue;
          const conf =
            Math.round((0.6 + (0.3 * (best - threshold)) / Math.max(1e-9, 1 - threshold)) * 1000) / 1000;
          union(a.root, b.root, "name-similarity", `jw=${best.toFixed(3)} ${pair}`, conf, true);
        }
      }
    }
  }

  // 6. Routes by (resolved service, signature).
  const routeIndex = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== "route" || !n.route) continue;
    const svc = byKey.has(n.route.serviceKey) ? uf.find(n.route.serviceKey) : n.route.serviceKey;
    const sig = `${svc}\u0000${routeSignature(n.route.method, n.route.path)}`;
    const prev = routeIndex.get(sig);
    if (prev === undefined) routeIndex.set(sig, n.key);
    else if (prev !== n.key)
      union(prev, n.key, "route-signature", routeSignature(n.route.method, n.route.path));
  }

  // Collect groups.
  const out = new Map<string, ResolvedGroup>();
  for (const [k, obs] of byKey) {
    const r = uf.find(k);
    let g = out.get(r);
    if (!g) {
      const merges = records.get(r) ?? [];
      const proposedRecs = merges.filter((m) => m.proposed);
      g = {
        root: r,
        keys: [],
        observations: [],
        merges,
        multiplier: proposedRecs.reduce((p, m) => p * m.confidence, 1),
        proposed: proposedRecs.length > 0,
      };
      out.set(r, g);
    }
    g.keys.push(k);
    g.observations.push(...obs);
  }
  return {
    groups: [...out.values()],
    groupOf: (key) => (byKey.has(key) ? out.get(uf.find(key)) : undefined),
    refused,
    fuzzySkipped,
  };
}
