/**
 * Deployment/config files → observations (confidence 0.8, docs/03-engines/system-model.md §1):
 * docker-compose, Kubernetes manifests (Deployment/StatefulSet/DaemonSet + Service), `.env` /
 * `.env.example`, package.json. docs/06-environments-and-portability.md (compose / k8s targets).
 *
 * SECRETS: env values are never stored. Only URL-like values (`scheme://host:port`, `host:port`) are
 * parsed, and only their scheme + host + port survive — user-info, path and query are dropped.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import type { Limitation } from "../../../core/evidence/schemas.js";
import { DEFAULT_CONFIDENCE } from "../confidence.js";
import { normalizeName } from "../similarity.js";
import type { ModelEdgeKind, ModelEvidence, ModelNodeKind } from "../types.js";
import {
  emptySet,
  kindForScheme,
  type NodeObservation,
  normHostPort,
  type ObservationSet,
  PRIMARY_KEY,
  urlIdentity,
} from "./observation.js";

export type ConfigFileType = "compose" | "k8s" | "env" | "package";

export interface CodeEnvRef {
  file: string;
  line: number;
}

export interface ConfigSourceOptions {
  /** Project root (paths in evidence are made relative to it). */
  root: string;
  /** Env var name → places in code that read it (`process.env.X`). */
  codeEnv?: Map<string, CodeEnvRef[]>;
}

export interface ConfigSourceResult extends ObservationSet {
  /** package.json `name`, if seen. */
  packageName?: string;
  files: { file: string; type: ConfigFileType }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

const rel = (root: string, f: string): string => {
  const r = path.relative(root, f);
  return (r && !r.startsWith("..") && !path.isAbsolute(r) ? r : f).replace(/\\/g, "/");
};

export function detectConfigType(file: string, text?: string): ConfigFileType | undefined {
  const b = path.basename(file).toLowerCase();
  if (b === "package.json") return "package";
  if (b === ".env" || b.startsWith(".env.") || b.endsWith(".env")) return "env";
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b)) return "compose";
  if (/\.ya?ml$/.test(b)) {
    if (text && /^\s*apiVersion\s*:/m.test(text) && /^\s*kind\s*:/m.test(text)) return "k8s";
    if (text && /^services\s*:/m.test(text)) return "compose";
  }
  return undefined;
}

const SECRET_KEY =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SIGNING|SALT|COOKIE|SESSION)/i;

/** Parses an env value into a non-secret network identity, or undefined. Never returns the raw value. */
export function envIdentity(
  name: string,
  value: string,
): { kind: ModelNodeKind; hostPort?: string; hostname?: string; display: string } | undefined {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (v === "") return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    const id = urlIdentity(v);
    if (!id || (!id.hostPort && !id.hostname)) return undefined;
    const display = `${id.scheme}://${id.hostPort ?? id.hostname}`;
    return {
      kind: kindForScheme(id.scheme),
      ...(id.hostPort ? { hostPort: id.hostPort } : {}),
      ...(id.hostname ? { hostname: id.hostname } : {}),
      display,
    };
  }
  // Plain host:port only for keys that clearly name an address (avoid secrets that contain ':').
  if (SECRET_KEY.test(name)) return undefined;
  const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(v);
  if (m && /(HOST|ADDR|ADDRESS|URL|URI|ENDPOINT|SERVER|BROKER|DSN)/i.test(name)) {
    const hp = normHostPort(m[1] as string, m[2] as string);
    if (!hp) return undefined;
    const host = (m[1] as string).toLowerCase();
    const named = !/^\d/.test(host) && host !== "localhost";
    return { kind: "external", hostPort: hp, ...(named ? { hostname: host } : {}), display: hp };
  }
  return undefined;
}

/** `.env` parser (KEY=VALUE, `export`, quotes, comments). */
export function parseDotEnv(text: string): { name: string; value: string; line: number }[] {
  const out: { name: string; value: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    let value = (m[2] as string).trim();
    if (/^["']/.test(value)) {
      const q = value[0] as string;
      const end = value.indexOf(q, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.push({ name: m[1] as string, value, line: i + 1 });
  });
  return out;
}

function imageKind(image: string | undefined): ModelNodeKind {
  const i = (image ?? "").toLowerCase();
  if (
    /(postgres|mysql|mariadb|mongo|cockroach|cassandra|scylla|clickhouse|mssql|elasticsearch|opensearch|couchdb|neo4j)/.test(
      i,
    )
  )
    return "datastore";
  if (/(redis|memcached|valkey|keydb|dragonfly)/.test(i)) return "cache";
  if (/(rabbitmq|kafka|nats|redpanda|activemq|pulsar|localstack|elasticmq)/.test(i)) return "queue";
  return "service";
}

class Builder {
  readonly set: ConfigSourceResult = { ...emptySet(), files: [] };
  constructor(readonly opts: ConfigSourceOptions) {
    this.set.coverage.config = true;
  }
  ev(origin: string, detail: string, line?: number): ModelEvidence {
    return {
      source: "config",
      confidence: DEFAULT_CONFIDENCE.config,
      origin,
      detail,
      ...(line !== undefined ? { line } : {}),
    };
  }
  /** env var → target node + edge from `ownerKey`. */
  env(ownerKey: string, origin: string, name: string, value: string, line?: number): void {
    const id = envIdentity(name, value);
    if (!id) return;
    const stem = normalizeName(name);
    const key = `env:${id.hostPort ?? id.hostname}`;
    const evidence = [this.ev(origin, `${name}=${id.display}`, line)];
    const refs = this.opts.codeEnv?.get(name) ?? [];
    for (const r of refs.slice(0, 3))
      evidence.push({
        source: "static",
        confidence: DEFAULT_CONFIDENCE.static,
        origin: r.file,
        line: r.line,
        detail: `code reads process.env.${name}`,
      });
    const node: NodeObservation = {
      key,
      kind: id.kind,
      name: id.hostname ?? stem ?? name,
      aliases: [name],
      evidence,
      ...(id.hostPort ? { hosts: [id.hostPort] } : {}),
      ...(id.hostname ? { serviceNames: [id.hostname] } : {}),
      ...(stem ? { envStems: [stem] } : {}),
    };
    this.set.nodes.push(node);
    const kind: ModelEdgeKind = id.kind === "external" ? "calls" : "depends";
    this.set.edges.push({ from: ownerKey, to: key, kind, evidence: evidence.slice() });
  }
  lim(l: { code: string; message: string; impact?: Limitation["impact"] }): void {
    const full: Limitation = { impact: "informational", ...l };
    if (!this.set.limitations.some((x) => x.code === l.code && x.message === l.message))
      this.set.limitations.push(full);
  }
}

function envEntries(v: unknown): { name: string; value: string }[] {
  if (Array.isArray(v)) {
    const out: { name: string; value: string }[] = [];
    for (const e of v) {
      const s = str(e);
      if (!s) continue;
      const i = s.indexOf("=");
      if (i > 0) out.push({ name: s.slice(0, i), value: s.slice(i + 1) });
    }
    return out;
  }
  if (isObj(v)) {
    return Object.entries(v)
      .map(([name, val]) => ({ name, value: str(val) ?? "" }))
      .filter((e) => e.value !== "");
  }
  return [];
}

function parsePort(p: unknown): { published?: number; target?: number; ip?: string } | undefined {
  if (isObj(p)) {
    const t = Number(p.target);
    const pub = Number(p.published);
    return {
      ...(Number.isFinite(t) ? { target: t } : {}),
      ...(Number.isFinite(pub) ? { published: pub } : {}),
      ...(typeof p.host_ip === "string" ? { ip: p.host_ip } : {}),
    };
  }
  const s = str(p);
  if (!s) return undefined;
  const parts = s.split("/")[0]?.split(":") ?? [];
  const nums = parts.map((x) => x.trim());
  if (nums.length === 1) {
    const t = Number(nums[0]);
    return Number.isFinite(t) ? { target: t } : undefined;
  }
  const target = Number(nums[nums.length - 1]);
  const published = Number(nums[nums.length - 2]);
  const ip = nums.length >= 3 ? nums.slice(0, -2).join(":") : undefined;
  if (!Number.isFinite(target)) return undefined;
  return { target, ...(Number.isFinite(published) ? { published } : {}), ...(ip ? { ip } : {}) };
}

function compose(b: Builder, file: string, text: string): void {
  const origin = rel(b.opts.root, file);
  let docs: unknown[];
  try {
    docs = parseAllDocuments(text).map((d) => d.toJS() as unknown);
  } catch (e) {
    b.lim({
      code: "MODEL_CONFIG_PARSE",
      message: `${origin}: ${(e as Error).message}`,
      impact: "reduces-confidence",
    });
    return;
  }
  for (const doc of docs) {
    if (!isObj(doc) || !isObj(doc.services)) continue;
    for (const [name, svc0] of Object.entries(doc.services)) {
      const svc = isObj(svc0) ? svc0 : {};
      const key = `compose:${name}`;
      const image = str(svc.image);
      const kind = imageKind(image);
      const hosts: string[] = [];
      const names = new Set<string>([name.toLowerCase()]);
      for (const n of [svc.container_name, svc.hostname])
        if (typeof n === "string") names.add(n.toLowerCase());
      for (const p of arr(svc.ports)) {
        const pp = parsePort(p);
        if (!pp) continue;
        if (pp.published !== undefined) {
          const hp = normHostPort(pp.ip && pp.ip !== "0.0.0.0" ? pp.ip : "127.0.0.1", pp.published);
          if (hp) hosts.push(hp);
        }
        if (pp.target !== undefined) for (const n of names) hosts.push(`${n}:${pp.target}`);
      }
      for (const p of arr(svc.expose)) {
        const t = Number(str(p)?.split("/")[0]);
        if (Number.isFinite(t)) for (const n of names) hosts.push(`${n}:${t}`);
      }
      b.set.nodes.push({
        key,
        kind,
        name,
        evidence: [
          b.ev(origin, `compose service ${name}${image ? ` (image ${image})` : svc.build ? " (build)" : ""}`),
        ],
        ...(hosts.length ? { hosts: [...new Set(hosts)] } : {}),
        serviceNames: [...names],
        envStems: [normalizeName(name)],
      });
      const deps = Array.isArray(svc.depends_on)
        ? svc.depends_on
        : isObj(svc.depends_on)
          ? Object.keys(svc.depends_on)
          : [];
      for (const d of deps) {
        const dn = str(d);
        if (dn)
          b.set.edges.push({
            from: key,
            to: `compose:${dn}`,
            kind: "depends",
            evidence: [b.ev(origin, `${name} depends_on ${dn}`)],
          });
      }
      for (const l of arr(svc.links)) {
        const ln = str(l)?.split(":")[0];
        if (ln)
          b.set.edges.push({
            from: key,
            to: `compose:${ln}`,
            kind: "depends",
            evidence: [b.ev(origin, `${name} links ${ln}`)],
          });
      }
      for (const e of envEntries(svc.environment)) b.env(key, origin, e.name, e.value);
    }
  }
}

function k8s(b: Builder, file: string, text: string): void {
  const origin = rel(b.opts.root, file);
  let docs: unknown[];
  try {
    docs = parseAllDocuments(text).map((d) => d.toJS() as unknown);
  } catch (e) {
    b.lim({
      code: "MODEL_CONFIG_PARSE",
      message: `${origin}: ${(e as Error).message}`,
      impact: "reduces-confidence",
    });
    return;
  }
  const workloads: { key: string; ns: string; labels: Record<string, string> }[] = [];
  const services: { key: string; ns: string; selector: Record<string, string> }[] = [];
  const flat: unknown[] = [];
  for (const d of docs) {
    if (isObj(d) && d.kind === "List") flat.push(...arr(d.items));
    else flat.push(d);
  }
  for (const doc of flat) {
    if (!isObj(doc) || typeof doc.kind !== "string" || !isObj(doc.metadata)) continue;
    const name = str(doc.metadata.name);
    if (!name) continue;
    const ns = str(doc.metadata.namespace) ?? "default";
    const spec = isObj(doc.spec) ? doc.spec : {};
    if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod"].includes(doc.kind)) {
      const tpl = doc.kind === "Pod" ? doc : isObj(spec.template) ? spec.template : {};
      const tplMeta = isObj(tpl.metadata) ? tpl.metadata : {};
      const podSpec = doc.kind === "Pod" ? spec : isObj(tpl.spec) ? tpl.spec : {};
      const labels: Record<string, string> = {};
      if (isObj(tplMeta.labels)) for (const [k, v] of Object.entries(tplMeta.labels)) labels[k] = String(v);
      const containers = arr(podSpec.containers).filter(isObj);
      const image = containers.map((c) => str(c.image)).find((x) => x !== undefined);
      const key = `k8s:${ns}/${doc.kind.toLowerCase()}/${name}`;
      workloads.push({ key, ns, labels });
      b.set.nodes.push({
        key,
        kind: imageKind(image),
        name,
        evidence: [b.ev(origin, `k8s ${doc.kind} ${ns}/${name}${image ? ` (image ${image})` : ""}`)],
        serviceNames: [name.toLowerCase()],
        envStems: [normalizeName(name)],
      });
      for (const c of containers)
        for (const e of arr(c.env).filter(isObj)) {
          const en = str(e.name);
          const ev = str(e.value);
          if (en && ev !== undefined) b.env(key, origin, en, ev);
        }
    } else if (doc.kind === "Service") {
      const key = `k8s:${ns}/service/${name}`;
      const selector: Record<string, string> = {};
      if (isObj(spec.selector)) for (const [k, v] of Object.entries(spec.selector)) selector[k] = String(v);
      services.push({ key, ns, selector });
      const dns = [name, `${name}.${ns}`, `${name}.${ns}.svc`, `${name}.${ns}.svc.cluster.local`].map((x) =>
        x.toLowerCase(),
      );
      const hosts: string[] = [];
      for (const p of arr(spec.ports).filter(isObj)) {
        const port = Number(p.port);
        if (Number.isFinite(port)) for (const d of dns) hosts.push(`${d}:${port}`);
        const np = Number(p.nodePort);
        if (Number.isFinite(np)) hosts.push(`127.0.0.1:${np}`);
      }
      b.set.nodes.push({
        key,
        kind: "service",
        name,
        evidence: [b.ev(origin, `k8s Service ${ns}/${name}`)],
        hosts,
        serviceNames: dns,
        envStems: [normalizeName(name)],
      });
    }
  }
  for (const s of services) {
    if (Object.keys(s.selector).length === 0) continue;
    for (const w of workloads) {
      if (w.ns !== s.ns) continue;
      if (Object.entries(s.selector).every(([k, v]) => w.labels[k] === v))
        b.set.links.push({
          a: s.key,
          b: w.key,
          rule: "k8s-selector",
          detail: `selector ${JSON.stringify(s.selector)}`,
        });
    }
  }
}

function dotenv(b: Builder, file: string, text: string): void {
  const origin = rel(b.opts.root, file);
  for (const e of parseDotEnv(text)) b.env(PRIMARY_KEY, origin, e.name, e.value, e.line);
}

/** Process explicit config files (type detected from name/content). */
export async function fromConfigFiles(
  files: readonly string[],
  opts: ConfigSourceOptions,
): Promise<ConfigSourceResult> {
  const b = new Builder(opts);
  for (const f of files) {
    let text: string;
    try {
      const st = await stat(f);
      if (st.size > 2_000_000) {
        b.lim({ code: "MODEL_CONFIG_TOO_LARGE", message: `${rel(opts.root, f)} skipped (> 2 MB)` });
        continue;
      }
      text = await readFile(f, "utf8");
    } catch (e) {
      b.lim({ code: "MODEL_CONFIG_UNREADABLE", message: `${rel(opts.root, f)}: ${(e as Error).message}` });
      continue;
    }
    const type = detectConfigType(f, text);
    if (!type) {
      b.lim({
        code: "MODEL_CONFIG_UNKNOWN",
        message: `${rel(opts.root, f)}: not a compose/k8s/.env/package.json file`,
      });
      continue;
    }
    b.set.files.push({ file: rel(opts.root, f), type });
    if (type === "compose") compose(b, f, text);
    else if (type === "k8s") k8s(b, f, text);
    else if (type === "env") dotenv(b, f, text);
    else {
      try {
        const pkg = JSON.parse(text) as Obj;
        if (typeof pkg.name === "string") b.set.packageName = pkg.name;
      } catch {
        b.lim({ code: "MODEL_CONFIG_PARSE", message: `${rel(opts.root, f)}: invalid JSON` });
      }
    }
  }
  if (b.set.files.length === 0) b.set.coverage.config = false;
  else if (b.set.files.every((f) => f.type === "package")) b.set.coverage.config = false;
  return b.set;
}

const K8S_DIRS = ["k8s", "kubernetes", "deploy", "deployment", "manifests", ".k8s", "helm-rendered"];

/** Find config files in a project root (non-recursive except well-known k8s dirs, depth ≤ 3, ≤ 200 files). */
export async function discoverConfigFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }
  for (const e of entries.sort()) {
    const b = e.toLowerCase();
    if (
      b === "package.json" ||
      /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b) ||
      b === ".env" ||
      /^\.env\.(example|sample|template|defaults|local|development|dev)$/.test(b)
    )
      out.push(path.join(root, e));
  }
  for (const d of K8S_DIRS) {
    const stack: { dir: string; depth: number }[] = [{ dir: path.join(root, d), depth: 0 }];
    while (stack.length > 0 && out.length < 200) {
      const { dir, depth } = stack.pop() as { dir: string; depth: number };
      let list: import("node:fs").Dirent[];
      try {
        list = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory() && depth < 3) stack.push({ dir: p, depth: depth + 1 });
        else if (ent.isFile() && /\.ya?ml$/i.test(ent.name)) out.push(p);
      }
    }
  }
  return out;
}

/** Scan source files for `process.env.X` / `process.env["X"]` / `import.meta.env.X` / `Deno.env.get("X")`. */
export async function scanCodeEnv(
  root: string,
  files: readonly string[],
  maxFiles = 5000,
): Promise<Map<string, CodeEnvRef[]>> {
  const out = new Map<string, CodeEnvRef[]>();
  const re =
    /(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])|Deno\.env\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g;
  for (const f of files.slice(0, maxFiles)) {
    let text: string;
    try {
      const abs = path.resolve(root, f);
      const st = await stat(abs);
      if (st.size > 1_000_000) continue;
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      re.lastIndex = 0;
      for (let m = re.exec(l); m; m = re.exec(l)) {
        const name = m[1] ?? m[2] ?? m[3];
        if (!name) continue;
        let list = out.get(name);
        if (!list) {
          list = [];
          out.set(name, list);
        }
        if (list.length < 10) list.push({ file: f.replace(/\\/g, "/"), line: i + 1 });
      }
    });
  }
  return out;
}
