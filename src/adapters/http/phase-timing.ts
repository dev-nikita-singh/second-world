/**
 * Detailed phase timing for the undici executor (`timing: "detailed"`).
 * See docs/03-engines/performance-lab.md §4 (Timing breakdown) and docs/05-optimization.md §2 item 5.
 *
 * Connection phases (DNS, TCP connect, TLS handshake) come from a wrapped undici connector plus a
 * wrapped DNS lookup (timed from call to callback; net.connect invokes it synchronously, so the
 * call is attributed to the connection being opened) and the socket's `connect` event. The
 * socket `lookup` event is not used: it is not emitted on the autoSelectFamily path. undici v8's
 * diagnostics channels (`undici:client:beforeConnect` / `undici:client:connected`) only bracket
 * the whole connect and expose no DNS or TLS split, so they cannot provide these phases.
 * Request phases (queue/connect wait, server time to first byte, transfer) come from a dispatch
 * interceptor that wraps the request handler. The interceptor sees our tracker via `opts.opaque`,
 * so correlation is exact even when the Pool queues the request.
 *
 * Nothing here is installed when timing is "basic", so that mode pays no cost.
 */
import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction, Socket } from "node:net";
import { buildConnector, type Dispatcher } from "undici";

export interface ConnectionTiming {
  origin: string;
  /** DNS resolution (absent for IP literals: no lookup happens). */
  dnsMs?: number;
  /** TCP handshake. */
  tcpMs?: number;
  /** TLS handshake (https only). */
  tlsMs?: number;
  /** Connector call → usable socket. */
  totalMs: number;
  /** Set when the connection failed. */
  error?: string;
}

/** Per-request timestamps filled in by the interceptor (clock ms). */
export class RequestTracker {
  /** Handed to undici (our execute call). */
  tQueued = 0;
  /** Request assigned to a connected socket and about to be written. */
  tSent = -1;
  /** Response headers received. */
  tResponse = -1;
}

export interface RequestPhases {
  /** Pool queue + connection establishment before the request could be written. */
  waitMs: number;
  /** Request written → response headers (server time + network RTT). */
  serverMs: number;
  /** Response headers → body fully read. */
  transferMs: number;
}

type ConnectFn = (opts: buildConnector.Options, cb: buildConnector.Callback) => unknown;

/** Builds a connector that records DNS/TCP/TLS timings for each new connection. */
export function timedConnector(
  build: buildConnector.BuildOptions,
  now: () => number,
  onConnection: (t: ConnectionTiming) => void,
): buildConnector.connector {
  // One shared lookup wrapper; `current` points at the connection being opened right now.
  const inner: LookupFunction =
    (build as { lookup?: LookupFunction }).lookup ?? (dnsLookup as unknown as LookupFunction);
  let current: { tLookup: number } | null = null;
  const timedLookup = ((hostname: string, options: unknown, callback: (...a: unknown[]) => void) => {
    const conn = current;
    (inner as unknown as (h: string, o: unknown, c: (...a: unknown[]) => void) => void)(
      hostname,
      options,
      (...a) => {
        if (conn && conn.tLookup < 0) conn.tLookup = now();
        callback(...a);
      },
    );
  }) as unknown as LookupFunction;
  const base = buildConnector({
    ...build,
    lookup: timedLookup,
  } as buildConnector.BuildOptions) as unknown as ConnectFn;
  return (opts, cb) => {
    const t0 = now();
    const conn = { tLookup: -1 };
    let tConnect = -1;
    const origin = `${opts.protocol}//${opts.hostname}${opts.port ? `:${opts.port}` : ""}`;
    current = conn;
    let socket: Socket | undefined;
    try {
      socket = base(opts, (err, sock) => {
        const tEnd = now();
        const t: ConnectionTiming = { origin, totalMs: tEnd - t0 };
        const tLookup = conn.tLookup;
        const tcpStart = tLookup >= 0 ? tLookup : t0;
        if (tLookup >= 0) t.dnsMs = tLookup - t0;
        if (opts.protocol !== "https:") {
          // undici's own 'connect' listener (registered first) is what calls us: TCP ends now.
          if (!err) t.tcpMs = tEnd - tcpStart;
        } else if (tConnect >= 0) {
          t.tcpMs = tConnect - tcpStart;
          t.tlsMs = tEnd - tConnect;
        }
        if (err) t.error = err.message;
        onConnection(t);
        if (err) cb(err, null);
        else cb(null, sock as Socket);
      }) as Socket | undefined;
    } finally {
      current = null;
    }
    if (socket && typeof socket.once === "function") {
      socket.once("connect", () => {
        tConnect = now();
      });
    }
  };
}

type Handler = Dispatcher.DispatchHandler;

/** Wraps a dispatch handler to timestamp request start and response start. */
class TimingHandler implements Handler {
  constructor(
    private readonly inner: Handler,
    private readonly tracker: RequestTracker,
    private readonly now: () => number,
  ) {}
  onRequestStart(...args: Parameters<NonNullable<Handler["onRequestStart"]>>): void {
    this.tracker.tSent = this.now();
    this.inner.onRequestStart?.(...args);
  }
  onRequestUpgrade(...args: Parameters<NonNullable<Handler["onRequestUpgrade"]>>): void {
    this.inner.onRequestUpgrade?.(...args);
  }
  onResponseStart(...args: Parameters<NonNullable<Handler["onResponseStart"]>>): void {
    this.tracker.tResponse = this.now();
    this.inner.onResponseStart?.(...args);
  }
  onResponseData(...args: Parameters<NonNullable<Handler["onResponseData"]>>): void {
    this.inner.onResponseData?.(...args);
  }
  onResponseEnd(...args: Parameters<NonNullable<Handler["onResponseEnd"]>>): void {
    this.inner.onResponseEnd?.(...args);
  }
  onResponseError(...args: Parameters<NonNullable<Handler["onResponseError"]>>): void {
    this.inner.onResponseError?.(...args);
  }
}

/** Dispatch interceptor: requests whose `opaque` is a RequestTracker get timestamped. */
export function timingInterceptor(now: () => number): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (opts, handler) => {
    const tracker = (opts as { opaque?: unknown }).opaque;
    if (tracker instanceof RequestTracker) return dispatch(opts, new TimingHandler(handler, tracker, now));
    return dispatch(opts, handler);
  };
}

export function requestPhases(tr: RequestTracker, tEnd: number): RequestPhases | undefined {
  if (tr.tSent < 0 || tr.tResponse < 0) return undefined;
  return {
    waitMs: Math.max(0, tr.tSent - tr.tQueued),
    serverMs: Math.max(0, tr.tResponse - tr.tSent),
    transferMs: Math.max(0, tEnd - tr.tResponse),
  };
}
