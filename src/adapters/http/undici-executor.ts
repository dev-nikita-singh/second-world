/**
 * HTTP executor for load generation on top of undici `Pool`.
 * See docs/05-optimization.md §2 (pooling, pre-serialised bodies, body.dump, performance.now timing)
 * and docs/03-engines/performance-lab.md §4.
 *
 * One Pool per origin, keep-alive by default, bounded `connections`.
 * Bodies are only buffered when the caller needs them (expect/extract); otherwise the stream
 * is drained chunk by chunk, counting bytes without allocating strings.
 */

import type { IncomingHttpHeaders } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { type Dispatcher, Pool } from "undici";
import { DEFAULT_REDACT_HEADERS } from "../../core/log/redact.js";
import type { SafetyDecision } from "../../core/types.js";
import { classifyError, errorMessage, type TransportErrorKind } from "./errors.js";
import {
  type ConnectionTiming,
  type RequestPhases,
  RequestTracker,
  requestPhases,
  timedConnector,
  timingInterceptor,
} from "./phase-timing.js";

export type { ConnectionTiming, RequestPhases } from "./phase-timing.js";

export interface HttpExecutorOptions {
  /** Max sockets per origin. Default 64. */
  connections?: number;
  /** Keep connections alive between requests. Default true. */
  keepAlive?: boolean;
  /** HTTP/1.1 pipelining factor. Default 1 (no pipelining). */
  pipelining?: number;
  /** Total per-request timeout in ms (headers + body). Default 10_000. */
  timeoutMs?: number;
  /** TCP connect timeout in ms. Default 5_000. */
  connectTimeoutMs?: number;
  /** Monotonic time source in ms. Default performance.now. */
  now?: () => number;
  /** Max body bytes buffered when `readBody` is set. Default 1 MiB (the rest is counted and discarded). */
  maxBodyBytes?: number;
  /** Allow HTTP/2 negotiation (TLS only). Default false. */
  allowH2?: boolean;
  /**
   * DNS lookup used for every new connection (e.g. the Safety Guard's pinned lookup, F5).
   * Node `net.LookupFunction`; must honour `options.all`. Not called for IP-literal hosts.
   */
  lookup?: LookupFunction;
  /** "detailed" records DNS/TCP/TLS per connection and wait/server/transfer per request. Default "basic". */
  timing?: "basic" | "detailed";
  /** Detailed timing: called once per new connection (success or failure). */
  onConnection?: (t: ConnectionTiming) => void;
  /**
   * Safety Guard hooks (F5/F6), usually `ctx.safety`: `lookup` pins DNS (used when `lookup` above
   * is not given), `checkRedirect` vets every redirect hop, `recheckDns` detects DNS rebinding.
   */
  safety?: ExecutorSafety | undefined;
  /** Minimum interval between DNS re-checks of one host (F6). Default 10_000 ms. */
  dnsRecheckIntervalMs?: number;
}

/** The subset of the Safety Guard the executor uses (all optional; duck-typed from ctx.safety). */
export interface ExecutorSafety {
  lookup?: LookupFunction;
  recheckDns?(host: string): Promise<void>;
  /** May be async (e.g. a worker_threads shard asking the main thread's guard over a MessagePort). */
  checkRedirect?(from: URL | string, location: string): SafetyDecision | Promise<SafetyDecision>;
}

/** Hop limit for `followRedirects: true`. */
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set(["content-type", "content-length", "transfer-encoding"]);
/**
 * Never forwarded to another origin on a redirect: the known credential headers plus anything whose
 * name looks like one (x-api-key, x-auth-token, x-session-id, x-signature, ...).
 */
const CREDENTIAL_HEADERS = new Set([
  ...DEFAULT_REDACT_HEADERS,
  "authorization",
  "cookie",
  "proxy-authorization",
]);
const CREDENTIAL_NAME = /auth|token|api[-_]?key|secret|session|cookie|signature|credential|password/i;

function stripHeaders(
  h: string[] | Record<string, string> | undefined,
  drop: Set<string>,
  dropPattern?: RegExp,
): string[] | undefined {
  if (h === undefined) return undefined;
  const out: string[] = [];
  const dropped = (k: string): boolean => drop.has(k.toLowerCase()) || (dropPattern?.test(k) ?? false);
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) {
      const k = h[i] as string;
      if (!dropped(k)) out.push(k, h[i + 1] as string);
    }
  } else {
    for (const [k, v] of Object.entries(h)) if (!dropped(k)) out.push(k, v);
  }
  return out;
}

export interface HttpRequestSpec {
  /** e.g. "http://127.0.0.1:3000" */
  origin: string;
  method: string;
  /** Path including the query string, e.g. "/api?x=1". */
  path: string;
  /** Flat header array [k1, v1, k2, v2, ...] (pre-merged) or a record. */
  headers?: string[] | Record<string, string>;
  body?: Buffer | string;
  /** Buffer the response body (for assertions / extraction). */
  readBody?: boolean;
  /** Follow 3xx redirects: true = up to MAX_REDIRECTS (5) hops, or a hop count. Default false. */
  followRedirects?: boolean | number;
}

export interface HttpResult {
  /** HTTP status, 0 when the request failed at transport level. */
  status: number;
  headers?: IncomingHttpHeaders;
  body?: Buffer;
  bytesIn: number;
  bytesOut: number;
  /** Clock ms when the request was handed to undici. */
  tStart: number;
  /** Clock ms when the response headers arrived (TTFB), or tEnd on error. */
  tHeaders: number;
  /** Clock ms when the body was fully consumed or the error occurred. */
  tEnd: number;
  error?: { kind: TransportErrorKind; message: string };
  /** Present only with `timing: "detailed"` when the request reached a socket and got headers. */
  phases?: RequestPhases;
  /** Redirect hops followed (only when > 0). */
  redirects?: number;
  /** URL of the final response when redirects were followed. */
  finalUrl?: string;
}

export interface HttpExecutor {
  execute(req: HttpRequestSpec, signal?: AbortSignal): Promise<HttpResult>;
  /** Number of requests currently in flight in this executor. */
  readonly inFlight: number;
  /** Open sockets across all pools (best effort, from undici stats). */
  readonly openSockets: number;
  /** F6: first error raised by an async DNS re-check (e.g. SW_SAFETY_DNS_REBIND), if any. */
  readonly safetyError?: Error | undefined;
  /** F6: DNS re-checks started so far. */
  readonly dnsRechecks?: number;
  close(): Promise<void>;
}

class UndiciExecutor implements HttpExecutor {
  private readonly pools = new Map<string, Pool>();
  private readonly dispatchers = new Map<string, Dispatcher>();
  private readonly opts: Required<
    Omit<HttpExecutorOptions, "now" | "lookup" | "onConnection" | "safety" | "dnsRecheckIntervalMs">
  >;
  private readonly safety: ExecutorSafety | undefined;
  private readonly dnsRecheckIntervalMs: number;
  private readonly hostOf = new Map<string, string>();
  private readonly lastDnsCheck = new Map<string, number>();
  safetyError: Error | undefined;
  dnsRechecks = 0;
  private readonly lookup: LookupFunction | undefined;
  private readonly onConnection: ((t: ConnectionTiming) => void) | undefined;
  private readonly detailed: boolean;
  private readonly now: () => number;
  private active = 0;
  private closed = false;

  constructor(opts: HttpExecutorOptions) {
    this.opts = {
      connections: opts.connections ?? 64,
      keepAlive: opts.keepAlive ?? true,
      pipelining: opts.pipelining ?? 1,
      timeoutMs: opts.timeoutMs ?? 10_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 5_000,
      maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
      allowH2: opts.allowH2 ?? false,
      timing: opts.timing ?? "basic",
    };
    this.now = opts.now ?? (() => performance.now());
    this.safety = opts.safety;
    this.lookup = opts.lookup ?? opts.safety?.lookup;
    this.dnsRecheckIntervalMs = opts.dnsRecheckIntervalMs ?? 10_000;
    this.onConnection = opts.onConnection;
    this.detailed = this.opts.timing === "detailed";
  }

  get inFlight(): number {
    return this.active;
  }

  get openSockets(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.stats.connected;
    return n;
  }

  private dispatcher(origin: string): Dispatcher {
    const d = this.dispatchers.get(origin);
    if (d) return d;
    const lookup = this.lookup ? { lookup: this.lookup } : {};
    let connect: Pool.Options["connect"];
    if (this.detailed) {
      const onConn = this.onConnection ?? (() => undefined);
      connect = timedConnector(
        { timeout: this.opts.connectTimeoutMs, allowH2: this.opts.allowH2, ...lookup },
        this.now,
        onConn,
      );
    } else if (this.lookup) {
      connect = { ...lookup };
    }
    const p = new Pool(origin, {
      connections: this.opts.connections,
      pipelining: this.opts.keepAlive ? this.opts.pipelining : 0,
      connectTimeout: this.opts.connectTimeoutMs,
      // Backstops: our AbortController enforces the total timeout precisely.
      headersTimeout: this.opts.timeoutMs + 1_000,
      bodyTimeout: this.opts.timeoutMs + 1_000,
      keepAliveTimeout: 4_000,
      allowH2: this.opts.allowH2,
      ...(connect ? { connect } : {}),
    });
    this.pools.set(origin, p);
    const out = this.detailed ? p.compose(timingInterceptor(this.now)) : p;
    this.dispatchers.set(origin, out);
    return out;
  }

  /**
   * F6: lazily re-checks DNS for a hostname origin at most once per `dnsRecheckIntervalMs`.
   * Timestamp check only (no timers); the recheck runs async and is never awaited here.
   * A rebind makes the guard throw SW_SAFETY_DNS_REBIND and fire its kill switch.
   */
  private maybeRecheckDns(origin: string): void {
    const recheck = this.safety?.recheckDns;
    if (!recheck) return;
    let host = this.hostOf.get(origin);
    if (host === undefined) {
      try {
        host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      } catch {
        host = "";
      }
      if (isIP(host) !== 0) host = ""; // IP literals are never resolved: nothing to re-check
      this.hostOf.set(origin, host);
    }
    if (host === "") return;
    const now = this.now();
    const last = this.lastDnsCheck.get(host);
    if (last === undefined) {
      // First sighting: the guard pinned it moments ago (preflight / first lookup).
      this.lastDnsCheck.set(host, now);
      return;
    }
    if (now - last < this.dnsRecheckIntervalMs) return;
    this.lastDnsCheck.set(host, now);
    this.dnsRechecks++;
    recheck.call(this.safety, host).catch((e: unknown) => {
      this.safetyError ??= e instanceof Error ? e : new Error(String(e));
    });
  }

  async execute(req: HttpRequestSpec, signal?: AbortSignal): Promise<HttpResult> {
    const bytesOut = req.body === undefined ? 0 : Buffer.byteLength(req.body);
    const tStart = this.now();
    if (this.closed || signal?.aborted) {
      return {
        status: 0,
        bytesIn: 0,
        bytesOut: 0,
        tStart,
        tHeaders: tStart,
        tEnd: tStart,
        error: { kind: "aborted", message: "executor closed or run cancelled" },
      };
    }
    const ac = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.opts.timeoutMs);
    const onCancel = (): void => {
      cancelled = true;
      ac.abort();
    };
    signal?.addEventListener("abort", onCancel, { once: true });
    this.active++;
    let tHeaders = tStart;
    let bytesIn = 0;
    let tracker: RequestTracker | undefined;
    if (this.detailed) {
      tracker = new RequestTracker();
      tracker.tQueued = tStart;
    }
    const maxHops =
      req.followRedirects === true
        ? MAX_REDIRECTS
        : Math.max(0, Math.floor(Number(req.followRedirects) || 0));
    let origin = req.origin;
    let path = req.path;
    let method = req.method;
    let headers = req.headers;
    let reqBody = req.body;
    let hops = 0;
    try {
      for (;;) {
        this.maybeRecheckDns(origin);
        const res = await this.dispatcher(origin).request({
          method: method as "GET",
          path,
          headers: headers ?? null,
          body: reqBody ?? null,
          signal: ac.signal,
          reset: !this.opts.keepAlive,
          ...(tracker ? { opaque: tracker } : {}),
        });
        tHeaders = tracker && tracker.tResponse >= 0 ? tracker.tResponse : this.now();
        const location = res.headers.location;
        const loc = Array.isArray(location) ? location[0] : location;
        const isRedirect =
          maxHops > 0 && REDIRECT_STATUS.has(res.statusCode) && typeof loc === "string" && loc !== "";
        let body: Buffer | undefined;
        if (req.readBody && !isRedirect) {
          const chunks: Buffer[] = [];
          let kept = 0;
          for await (const chunk of res.body as AsyncIterable<Buffer>) {
            bytesIn += chunk.length;
            const room = this.opts.maxBodyBytes - kept;
            if (room > 0) {
              // Never keep more than maxBodyBytes, even when one chunk crosses the cap.
              const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
              chunks.push(part);
              kept += part.length;
            }
          }
          body = Buffer.concat(chunks, kept);
        } else {
          for await (const chunk of res.body as AsyncIterable<Buffer>) bytesIn += chunk.length;
        }
        const tEnd = this.now();
        if (isRedirect) {
          const from = new URL(path, origin);
          const fail = (message: string, kind: TransportErrorKind): HttpResult => ({
            status: res.statusCode,
            headers: res.headers,
            bytesIn,
            bytesOut,
            tStart,
            tHeaders,
            tEnd,
            redirects: hops,
            error: { kind, message },
          });
          if (hops >= maxHops) return fail(`too many redirects (more than ${maxHops})`, "redirect-limit");
          const decision = await this.safety?.checkRedirect?.call(this.safety, from, loc as string);
          if (decision && !decision.allowed) return fail(`${decision.code}: ${decision.reason}`, "safety");
          let next: URL;
          try {
            next = new URL(loc as string, from);
          } catch {
            return fail(`invalid redirect location: ${String(loc)}`, "other");
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") {
            return fail(`redirect to unsupported protocol ${next.protocol}`, "safety");
          }
          hops++;
          // 303 always, and 301/302 for non-GET/HEAD, switch to GET without a body (fetch semantics).
          const toGet =
            res.statusCode === 303 ||
            ((res.statusCode === 301 || res.statusCode === 302) && method !== "GET" && method !== "HEAD");
          if (toGet) {
            if (method !== "HEAD") method = "GET";
            reqBody = undefined;
            headers = stripHeaders(headers, BODY_HEADERS);
          }
          if (next.origin !== origin) headers = stripHeaders(headers, CREDENTIAL_HEADERS, CREDENTIAL_NAME);
          origin = next.origin;
          path = `${next.pathname}${next.search}`;
          if (tracker) {
            tracker.tSent = -1;
            tracker.tResponse = -1;
          }
          continue;
        }
        const out: HttpResult = {
          status: res.statusCode,
          headers: res.headers,
          bytesIn,
          bytesOut,
          tStart,
          tHeaders,
          tEnd,
        };
        if (hops > 0) {
          out.redirects = hops;
          out.finalUrl = new URL(path, origin).href;
        }
        if (body !== undefined) out.body = body;
        if (tracker) {
          const ph = requestPhases(tracker, tEnd);
          if (ph) out.phases = ph;
        }
        return out;
      }
    } catch (e) {
      const tEnd = this.now();
      const out: HttpResult = {
        status: 0,
        bytesIn,
        bytesOut,
        tStart,
        tHeaders: tHeaders === tStart ? tEnd : tHeaders,
        tEnd,
        error: { kind: classifyError(e, { timedOut, cancelled }), message: errorMessage(e) },
      };
      if (hops > 0) out.redirects = hops;
      return out;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
      this.active--;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pools = [...this.pools.values()];
    this.pools.clear();
    this.dispatchers.clear();
    await Promise.all(pools.map((p) => p.destroy().catch(() => undefined)));
  }
}

export function createUndiciExecutor(opts: HttpExecutorOptions = {}): HttpExecutor {
  return new UndiciExecutor(opts);
}

/** Flattens a header record into undici's array form once (pre-merged headers). */
export function flattenHeaders(h: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(h)) {
    const v = h[k];
    if (v !== undefined) out.push(k, v);
  }
  return out;
}
