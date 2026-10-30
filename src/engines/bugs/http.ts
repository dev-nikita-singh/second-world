/**
 * HTTP layer of the Bug Hunter: request templates → undici executor (shared with the Performance
 * Lab), safety (target check, budget lease, mutation gate), 429 back-off via Retry-After,
 * barrier-synchronised bursts, redacted exchange recording and curl reproduction.
 * docs/03-engines/api-bug-hunter.md §3–§5, docs/11-safety-security-privacy.md §2, §4.
 */
import {
  type ConnectionTiming,
  createUndiciExecutor,
  type ExecutorSafety,
  flattenHeaders,
  type HttpExecutor,
  type HttpResult,
} from "../../adapters/http/undici-executor.js";
import { SafetyError } from "../../core/errors.js";
import { createRedactor, type Redactor } from "../../core/log/redact.js";
import type { BudgetLease, EngineContext } from "../../core/types.js";
import type { RawBody } from "./generators/mutations.js";
import { getPointer } from "./json-schema.js";
import type { Credential } from "./schema.js";

export const ROLE_INVALID = "__invalid__";
export const ROLE_EXPIRED = "__expired__";

export interface RequestTemplate {
  operation: string;
  method: string;
  /** Path template, e.g. "/orders/{id}". */
  path: string;
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body: RawBody;
  /**
   * Credential: a configured role name, null = anonymous, ROLE_INVALID / ROLE_EXPIRED,
   * undefined = default role when the operation is secured (else anonymous).
   */
  role?: string | null;
  secured?: boolean;
}

export interface Exchange {
  operation: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  /** Parsed JSON body (not redacted, in-memory only). */
  json?: unknown;
  contentType: string;
  durationMs: number;
  tStart: number;
  tEnd: number;
  error?: string;
  blocked?: "mutation" | "budget";
  role?: string | null;
  rateLimitedRetries: number;
  /**
   * Phase timing (ms) from the executor's detailed timing, for HAR `timings`. Absent when the
   * request got no response headers or the executor was injected without detailed timing.
   * dns/tcp/tls are present only when this request opened a new connection.
   */
  phases?: ExchangePhases;
}

export interface ExchangePhases {
  /** Queue + connection establishment before the request was written. */
  waitMs: number;
  /** Request written → response headers. */
  serverMs: number;
  /** Response headers → body read. */
  transferMs: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
}

/** Connections remembered for attribution to the request that waited for them (bounded). */
const MAX_PENDING_CONNECTIONS = 128;

export class BudgetExhausted extends Error {
  constructor() {
    super("request budget exhausted");
  }
}

export interface HttpOptions {
  target: string;
  timeoutMs: number;
  headers: Record<string, string>;
  roles: Record<string, Credential>;
  defaultRole?: string;
  invalidToken: string;
  expiredToken?: string;
  mutationsAllowed: boolean;
  lease: BudgetLease;
  executor?: HttpExecutor;
  /** Max body bytes kept in recorded exchanges. Default 4096. */
  maxRecordedBody?: number;
}

export interface HttpStats {
  sent: number;
  mutationsBlocked: number;
  rateLimited: number;
  transportErrors: number;
}

const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Substitutes {{var}} in strings (deep) from a scope. Missing vars stay unresolved (reported). */
export function substitute<T>(v: T, scope: Record<string, unknown>, missing: Set<string>): T {
  if (typeof v === "string") {
    const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(v);
    if (whole) {
      const k = whole[1] as string;
      if (k in scope) return scope[k] as T;
      missing.add(k);
      return v;
    }
    return v.replace(VAR, (m, k: string) => {
      if (k in scope) return String(scope[k]);
      missing.add(k);
      return m;
    }) as T;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, scope, missing)) as T;
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = substitute(x, scope, missing);
    return out as T;
  }
  return v;
}

function serializeQuery(q: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      const s = x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function buildPath(tpl: Pick<RequestTemplate, "path" | "pathParams" | "query">): string {
  const p = tpl.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = tpl.pathParams[name];
    return encodeURIComponent(v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  });
  return p + serializeQuery(tpl.query);
}

function credentialHeaders(c: Credential): Record<string, string> {
  if (c.type === "bearer") return { authorization: `Bearer ${c.token}` };
  if (c.type === "basic")
    return { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` };
  return { [c.name.toLowerCase()]: c.value };
}

function parseRetryAfter(v: string | undefined, nowMs: number): number {
  if (!v) return 500;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - nowMs) : 500;
}

export class BugsHttp {
  readonly stats: HttpStats = { sent: 0, mutationsBlocked: 0, rateLimited: 0, transportErrors: 0 };
  readonly redactor: Redactor;
  private readonly executor: HttpExecutor;
  private readonly ownsExecutor: boolean;
  private readonly origin: string;
  private readonly basePath: string;
  private readonly checked = new Set<string>();
  /** New connections (end time + phases) not yet attributed to a request. */
  private readonly connections: { tEnd: number; t: ConnectionTiming }[] = [];

  constructor(
    private readonly ctx: EngineContext,
    private readonly o: HttpOptions,
  ) {
    const u = new URL(o.target);
    this.origin = u.origin;
    this.basePath = u.pathname.replace(/\/$/, "");
    this.ownsExecutor = o.executor === undefined;
    // Detailed timing (HAR timings): one interceptor wrapper per request and a timed connector;
    // same pool, lookup and safety hooks, so what is sent and when is unchanged.
    const now = (): number => performance.now();
    this.executor =
      o.executor ??
      createUndiciExecutor({
        timeoutMs: o.timeoutMs,
        connections: 64,
        maxBodyBytes: 1024 * 1024,
        safety: ctx.safety as ExecutorSafety, // F6 (sw-perf)
        now,
        timing: "detailed",
        onConnection: (t) => {
          if (t.error) return;
          this.connections.push({ tEnd: now(), t });
          if (this.connections.length > MAX_PENDING_CONNECTIONS) this.connections.shift();
        },
      });
    const secrets: string[] = [o.invalidToken];
    if (o.expiredToken) secrets.push(o.expiredToken);
    for (const c of Object.values(o.roles)) {
      if (c.type === "bearer") secrets.push(c.token);
      else if (c.type === "basic")
        secrets.push(c.password, Buffer.from(`${c.username}:${c.password}`).toString("base64"));
      else secrets.push(c.value);
    }
    this.redactor = createRedactor({ secrets });
  }

  get mutationsAllowed(): boolean {
    return this.o.mutationsAllowed;
  }

  roleNames(): string[] {
    return Object.keys(this.o.roles);
  }

  checkUrl(url: URL): void {
    if (this.checked.has(url.origin)) return;
    const d = this.ctx.safety.checkTarget(url);
    if (!d.allowed) {
      const code = (
        d.code.startsWith("SW_SAFETY_") ? d.code : `SW_SAFETY_${d.code}`
      ) as `SW_SAFETY_${string}`;
      this.ctx.safety.audit({ action: "bugs.blocked", target: url.origin, detail: { code: d.code } });
      throw new SafetyError(code, d.reason, { hint: d.hint, details: { target: url.origin } });
    }
    this.checked.add(url.origin);
  }

  resolveHeaders(tpl: RequestTemplate): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.o.headers)) h[k.toLowerCase()] = v;
    let role = tpl.role;
    if (role === undefined) role = tpl.secured ? (this.o.defaultRole ?? null) : null;
    if (role === ROLE_INVALID) h.authorization = `Bearer ${this.o.invalidToken}`;
    else if (role === ROLE_EXPIRED) h.authorization = `Bearer ${this.o.expiredToken ?? this.o.invalidToken}`;
    else if (role !== null) {
      const c = this.o.roles[role];
      if (c) Object.assign(h, credentialHeaders(c));
    }
    for (const [k, v] of Object.entries(tpl.headers)) h[k.toLowerCase()] = v;
    return h;
  }

  private prepare(tpl: RequestTemplate): {
    path: string;
    headers: Record<string, string>;
    body?: string;
    url: string;
  } {
    const headers = this.resolveHeaders(tpl);
    let body: string | undefined;
    if (tpl.body.kind === "json") {
      body = JSON.stringify(tpl.body.value);
      headers["content-type"] ??= "application/json";
    } else if (tpl.body.kind === "raw") {
      body = tpl.body.text;
      headers["content-type"] = tpl.body.contentType;
    }
    const path = this.basePath + buildPath(tpl);
    return { path, headers, ...(body === undefined ? {} : { body }), url: this.origin + path };
  }

  private toExchange(
    tpl: RequestTemplate,
    p: ReturnType<BugsHttp["prepare"]>,
    r: HttpResult,
    retries: number,
  ): Exchange {
    const max = this.o.maxRecordedBody ?? 4096;
    const rh: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      if (v === undefined) continue;
      rh[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    const ct = rh["content-type"] ?? "";
    const text = r.body ? r.body.toString("utf8") : undefined;
    let json: unknown;
    if (text !== undefined && text.length > 0 && /json/i.test(ct)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const ex: Exchange = {
      operation: tpl.operation,
      method: tpl.method,
      url: this.redactor.redactString(p.url),
      requestHeaders: this.redactor.redactHeaders({ ...p.headers }),
      status: r.status,
      responseHeaders: this.redactor.redactHeaders(rh),
      contentType: ct,
      durationMs: r.tEnd - r.tStart,
      tStart: r.tStart,
      tEnd: r.tEnd,
      rateLimitedRetries: retries,
      role: tpl.role === undefined ? (tpl.secured ? (this.o.defaultRole ?? null) : null) : tpl.role,
    };
    if (p.body !== undefined) ex.requestBody = this.redactor.redactString(p.body.slice(0, max));
    if (text !== undefined) ex.responseBody = this.redactor.redactString(text.slice(0, max));
    if (json !== undefined) ex.json = json;
    if (r.error) ex.error = `${r.error.kind}: ${r.error.message}`;
    if (r.phases) ex.phases = this.phasesOf(r);
    return ex;
  }

  /**
   * Request phases plus the connection this request waited for: the first unattributed new
   * connection that became usable between the request's start and the moment it was written.
   * Under concurrency the attribution is approximate (any connection ready in the window).
   */
  private phasesOf(r: HttpResult): ExchangePhases {
    const ph = r.phases as NonNullable<HttpResult["phases"]>;
    const out: ExchangePhases = { waitMs: ph.waitMs, serverMs: ph.serverMs, transferMs: ph.transferMs };
    const tSent = r.tStart + ph.waitMs;
    const i = this.connections.findIndex((c) => c.tEnd >= r.tStart && c.tEnd <= tSent);
    if (i >= 0) {
      const { t } = this.connections[i] as { t: ConnectionTiming };
      this.connections.splice(i, 1);
      if (t.dnsMs !== undefined) out.dnsMs = t.dnsMs;
      if (t.tcpMs !== undefined) out.tcpMs = t.tcpMs;
      if (t.tlsMs !== undefined) out.tlsMs = t.tlsMs;
      if (t.tcpMs === undefined && t.tlsMs === undefined) out.tcpMs = t.totalMs;
    }
    return out;
  }

  private blocked(tpl: RequestTemplate, kind: "mutation" | "budget"): Exchange {
    const now = this.ctx.clock.now();
    return {
      operation: tpl.operation,
      method: tpl.method,
      url: this.origin + this.basePath + buildPath(tpl),
      requestHeaders: {},
      status: 0,
      responseHeaders: {},
      contentType: "",
      durationMs: 0,
      tStart: now,
      tEnd: now,
      blocked: kind,
      error:
        kind === "mutation"
          ? "mutating request blocked (allowMutations not set / not approved)"
          : "budget exhausted",
      rateLimitedRetries: 0,
    };
  }

  private async admit(tpl: RequestTemplate): Promise<Exchange | null> {
    if (this.ctx.signal.aborted || this.ctx.safety.killSwitch.aborted) throw new BudgetExhausted();
    if (/^(POST|PUT|PATCH|DELETE)$/i.test(tpl.method) && !this.o.mutationsAllowed) {
      this.stats.mutationsBlocked++;
      return this.blocked(tpl, "mutation");
    }
    if (!this.o.lease.take()) throw new BudgetExhausted();
    const lease = this.o.lease as BudgetLease & { throttle?: (s?: AbortSignal) => Promise<void> };
    if (typeof lease.throttle === "function") await lease.throttle(this.ctx.signal);
    return null;
  }

  async send(tpl: RequestTemplate): Promise<Exchange> {
    const pre = await this.admit(tpl);
    if (pre) return pre;
    const p = this.prepare(tpl);
    this.checkUrl(new URL(p.url));
    let retries = 0;
    for (;;) {
      const r = await this.executor.execute(
        {
          origin: this.origin,
          method: tpl.method,
          path: p.path,
          headers: flattenHeaders(p.headers),
          readBody: true,
          ...(p.body === undefined ? {} : { body: p.body }),
        },
        this.ctx.signal,
      );
      this.stats.sent++;
      if (r.status === 429 && retries < 3) {
        this.stats.rateLimited++;
        retries++;
        const h = r.headers?.["retry-after"];
        const wait = Math.min(5_000, parseRetryAfter(Array.isArray(h) ? h[0] : h, Date.now()));
        await this.ctx.clock.sleep(Math.max(50, wait), this.ctx.signal);
        if (!this.o.lease.take()) throw new BudgetExhausted();
        continue;
      }
      if (r.error) this.stats.transportErrors++;
      return this.toExchange(tpl, p, r, retries);
    }
  }

  /**
   * Barrier-synchronised burst: every request is admitted and serialised first, then all are
   * dispatched in the same tick.
   */
  async burst(tpls: RequestTemplate[]): Promise<Exchange[]> {
    const prepared: ({ tpl: RequestTemplate; p: ReturnType<BugsHttp["prepare"]> } | Exchange)[] = [];
    for (const tpl of tpls) {
      const pre = await this.admit(tpl);
      if (pre) prepared.push(pre);
      else {
        const p = this.prepare(tpl);
        this.checkUrl(new URL(p.url));
        prepared.push({ tpl, p });
      }
    }
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const runs = prepared.map(async (x) => {
      if (!("tpl" in x)) return x;
      await barrier;
      const r = await this.executor.execute(
        {
          origin: this.origin,
          method: x.tpl.method,
          path: x.p.path,
          headers: flattenHeaders(x.p.headers),
          readBody: true,
          ...(x.p.body === undefined ? {} : { body: x.p.body }),
        },
        this.ctx.signal,
      );
      this.stats.sent++;
      if (r.error) this.stats.transportErrors++;
      return this.toExchange(x.tpl, x.p, r, 0);
    });
    release();
    return Promise.all(runs);
  }

  /** Env var holding the FULL credential header value of a role, e.g. SW_AUTH_USER='Bearer <token>'. */
  static authEnvName(role: string | null | undefined): string {
    return `SW_AUTH_${String(role ?? "TOKEN")
      .replace(/[^A-Za-z0-9]/g, "_")
      .toUpperCase()}`;
  }

  /**
   * curl command for a template. Credentials are never printed: the credential header is emitted as
   * `-H "<header>: $SW_AUTH_<ROLE>"` where the env var holds the full header value
   * (`export SW_AUTH_USER='Bearer <token>'`), which works for bearer, basic and custom-header roles.
   */
  curl(tpl: RequestTemplate): string {
    const p = this.prepare(tpl);
    const parts = ["curl", "-sS", "-X", tpl.method, shellQuote(p.url)];
    let role = tpl.role;
    if (role === undefined) role = tpl.secured ? (this.o.defaultRole ?? null) : null;
    const cred = role ? this.o.roles[role] : undefined;
    const credHeader = cred?.type === "header" ? cred.name.toLowerCase() : "authorization";
    for (const [k, v] of Object.entries(p.headers)) {
      if (k === credHeader && cred) {
        parts.push("-H", `"${k}: $${BugsHttp.authEnvName(role)}"`);
        continue;
      }
      if (k === "authorization" && (role === ROLE_INVALID || role === ROLE_EXPIRED)) {
        // Deliberately invalid/expired probe credential: printed redacted, no env var needed.
        parts.push("-H", shellQuote(`${k}: ${this.redactor.redactString(v)}`));
        continue;
      }
      parts.push("-H", shellQuote(`${k}: ${this.redactor.redactString(v)}`));
    }
    if (p.body !== undefined) parts.push("--data-raw", shellQuote(this.redactor.redactString(p.body)));
    return parts.join(" ");
  }

  /**
   * Shell reproduction of a multi-step case. Steps use the request actually sent in the recorded
   * run (`resolved[i]`, extracted ids substituted). Only when a value is unknown (step never
   * reached) is it captured in a shell variable from the producing step's response, e.g.
   * `RID=$(curl … | node -e …)` and used as "$RID". Never prints a raw or encoded `{{…}}` template.
   */
  curlSteps(
    steps: readonly {
      request: RequestTemplate;
      extract?: Record<string, string>;
      burst?: number;
      mix?: readonly { request: RequestTemplate; count: number; phase: "before" | "during" | "after" }[];
    }[],
    resolved: readonly (RequestTemplate | undefined)[] = [],
  ): string[] {
    const shellVar = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    // Which variables must be captured in the shell (used by an unresolved step)?
    const needed = new Set<string>();
    steps.forEach((st, i) => {
      if (resolved[i]) return;
      for (const m of JSON.stringify(st.request).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g))
        needed.add(m[1] as string);
    });
    const out: string[] = [];
    steps.forEach((st, i) => {
      const mix = st.mix ?? [];
      const seq = (phase: "before" | "after"): void => {
        for (const m of mix)
          if (m.phase === phase) for (let k = 0; k < m.count; k++) out.push(this.curl(m.request));
      };
      seq("before");
      out.push(this.curlStepLine(st, i, resolved, needed, shellVar, mix));
      seq("after");
    });
    return out;
  }

  private curlStepLine(
    st: {
      request: RequestTemplate;
      extract?: Record<string, string>;
      burst?: number;
    },
    i: number,
    resolved: readonly (RequestTemplate | undefined)[],
    needed: Set<string>,
    shellVar: (name: string) => string,
    mix: readonly { request: RequestTemplate; count: number; phase: "before" | "during" | "after" }[],
  ): string {
    let tpl = resolved[i];
    let line: string;
    if (tpl) line = this.curl(tpl);
    else {
      // Replace {{var}} by URL-safe sentinels, then splice in shell variable references.
      const missing = new Set<string>();
      const scope: Record<string, unknown> = {};
      for (const m of JSON.stringify(st.request).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
        const k = m[1] as string;
        scope[k] = `SWVAR${shellVar(k)}SWVAR`;
      }
      tpl = substitute(st.request, scope, missing);
      line = this.curl(tpl).replace(/SWVAR([A-Z0-9_]+)SWVAR/g, (_m, v: string) => `'"$${v}"'`);
    }
    const caps = Object.entries(st.extract ?? {}).filter(([k]) => needed.has(k));
    if (caps.length > 0) {
      const [k, ptr] = caps[0] as [string, string];
      const js = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of ${JSON.stringify(ptr)}.split("/").slice(1))v=v==null?v:v[k.replace(/~1/g,"/").replace(/~0/g,"~")];process.stdout.write(String(v))})`;
      line = `${shellVar(k)}=$(${line} | node -e ${shellQuote(js)})`;
    }
    if (st.burst && st.burst > 1) {
      const during = mix
        .filter((m) => m.phase === "during")
        .map((m) => {
          const one = this.curl(m.request);
          return m.count > 1 ? `for j in $(seq 1 ${m.count}); do ${one} & done; ` : `${one} & `;
        })
        .join("");
      line = `for i in $(seq 1 ${st.burst}); do ${line} & done; ${during}wait`;
    }
    return line;
  }

  async close(): Promise<void> {
    if (this.ownsExecutor) await this.executor.close();
  }
}

/** POSIX single-quote shell quoting. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function jsonAt(ex: Exchange, pointer: string): unknown {
  return ex.json === undefined ? undefined : getPointer(ex.json, pointer);
}
