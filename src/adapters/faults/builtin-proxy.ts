/**
 * Built-in TCP/HTTP fault proxy (default injector). See docs/03-engines/reliability-lab.md §1, §3.
 *
 * The app's dependency URL points at this proxy (127.0.0.1, port 0 by default), which forwards
 * to the real upstream and injects faults that can be hot-swapped at runtime.
 *
 * - http mode (default): one decision per HTTP request. Faults: latency (+jitter), bandwidth,
 *   reset (RST; `when: "after-response"`: forwarded, upstream response consumed, then RST to the
 *   client), black-hole (request held; forwarded when the fault is reverted, destroyed on close),
 *   status injection, slow body. Counts requests and records arrival times (retry amplification,
 *   jitter detection).
 * - tcp mode: one decision per connection for reset/black-hole (reset after-response: the client is
 *   reset when the upstream's first bytes arrive, which are dropped); latency and bandwidth are applied
 *   per chunk in both directions (order preserved). Counts connections.
 *
 * Partial faults use exact counter selection (`selectByCounter`), flapping uses `flapActive`.
 * `close()` destroys every socket; the proxy also registers itself on the global cleanup stack so
 * SIGINT/SIGTERM/crash close it.
 */
import http from "node:http";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { RingBuffer } from "../../shared/ds/ring-buffer.js";
import { registerGlobalCleanup } from "./cleanup.js";
import {
  type AppliedFault,
  type Fault,
  type FaultInjector,
  type FaultInput,
  flapActive,
  type InjectorCapabilities,
  parseFault,
  selectByCounter,
} from "./types.js";

export interface BuiltinProxyOptions {
  /** Upstream: "http://host:port" (http mode) or "host:port" / URL (tcp mode). */
  upstream: string;
  mode?: "http" | "tcp";
  host?: string;
  /** Default 0 (random free port). */
  port?: number;
  /** Dependency name (for logs/evidence). */
  name?: string;
  /** Uniform [0,1) source for latency jitter (pass ctx.rng.next). Default: a fixed LCG (deterministic). */
  random?: () => number;
  /** Monotonic ms. Default performance.now. Must match the clock used to analyse arrivals. */
  now?: () => number;
  /** Arrival timestamps kept (ring). Default 200_000. */
  maxArrivals?: number;
  /** Register on the global cleanup stack (default true). */
  registerCleanup?: boolean;
}

export interface ProxyStats {
  /** HTTP requests (http mode) or connections (tcp mode) seen. */
  requests: number;
  connections: number;
  /** Requests forwarded to the upstream. */
  forwarded: number;
  /** Responses by status sent to the client (forwarded or injected). */
  responses: Record<string, number>;
  /** Injection counts by fault type. */
  injected: Record<string, number>;
  /** Requests currently held by a black-hole. */
  held: number;
  bytesToUpstream: number;
  bytesToClient: number;
  upstreamErrors: number;
}

interface ActiveFault {
  id: string;
  fault: Fault;
  appliedAt: number;
  counter: number;
  disarm: (() => void)[];
}

interface Plan {
  latencyMs: number;
  bytesPerSecond: number;
  slowBody?: { delayMs: number; chunkBytes: number };
  terminal?:
    | { kind: "reset" }
    | { kind: "reset-after-response" }
    | { kind: "blackhole"; faultId: string }
    | { kind: "status"; status: number; body?: string };
}

interface Held {
  faultId: string;
  release: () => void;
  destroy: () => void;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function parseUpstream(u: string, mode: "http" | "tcp"): { host: string; port: number; origin: string } {
  const withProto = /^[a-z]+:\/\//i.test(u) ? u : `${mode === "http" ? "http" : "tcp"}://${u}`;
  const url = new URL(withProto);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return { host, port, origin: `${url.protocol}//${url.host}` };
}

export class BuiltinFaultProxy implements FaultInjector {
  readonly name = "builtin-proxy";
  readonly mode: "http" | "tcp";
  readonly dependency: string;
  readonly upstream: { host: string; port: number; origin: string };
  private server: http.Server | net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly agent: http.Agent;
  private readonly faults = new Map<string, ActiveFault>();
  private readonly held = new Set<Held>();
  private readonly closeCtl = new AbortController();
  private readonly random: () => number;
  readonly now: () => number;
  private readonly arrivalRing: RingBuffer<number>;
  private s: ProxyStats = BuiltinFaultProxy.freshStats();
  private seq = 0;
  private heldTimer: ReturnType<typeof setInterval> | null = null;
  private unregisterCleanup: (() => void) | null = null;
  private closing: Promise<void> | null = null;
  private readonly opts: BuiltinProxyOptions;
  private boundPort = 0;
  private boundHost = "127.0.0.1";

  private constructor(opts: BuiltinProxyOptions) {
    this.opts = opts;
    this.mode = opts.mode ?? "http";
    this.dependency = opts.name ?? "dependency";
    this.upstream = parseUpstream(opts.upstream, this.mode);
    this.random = opts.random ?? lcg(0x5eed);
    this.now = opts.now ?? (() => performance.now());
    this.arrivalRing = new RingBuffer<number>(opts.maxArrivals ?? 200_000, { overwrite: true });
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  }

  /** Starts a proxy listening on 127.0.0.1:0 (or the configured host/port). */
  static async start(opts: BuiltinProxyOptions): Promise<BuiltinFaultProxy> {
    const p = new BuiltinFaultProxy(opts);
    await p.listen();
    return p;
  }

  private static freshStats(): ProxyStats {
    return {
      requests: 0,
      connections: 0,
      forwarded: 0,
      responses: {},
      injected: {},
      held: 0,
      bytesToUpstream: 0,
      bytesToClient: 0,
      upstreamErrors: 0,
    };
  }

  get port(): number {
    return this.boundPort;
  }

  get host(): string {
    return this.boundHost;
  }

  /** "http://127.0.0.1:<port>" (also usable as host:port in tcp mode). */
  get url(): string {
    return `${this.mode === "http" ? "http" : "tcp"}://${this.boundHost}:${this.boundPort}`;
  }

  get closed(): boolean {
    return this.closeCtl.signal.aborted;
  }

  private async listen(): Promise<void> {
    const server =
      this.mode === "http"
        ? http.createServer({ keepAliveTimeout: 5000 }, (req, res) => void this.onHttp(req, res))
        : net.createServer((c) => this.onTcp(c));
    server.on("connection", (sock: net.Socket) => {
      this.sockets.add(sock);
      sock.on("close", () => this.sockets.delete(sock));
      sock.on("error", () => {});
    });
    server.on("error", () => {});
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => reject(e);
      server.once("error", onErr);
      server.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", () => {
        server.off("error", onErr);
        resolve();
      });
    });
    const addr = server.address() as net.AddressInfo;
    this.boundPort = addr.port;
    this.boundHost = this.opts.host ?? "127.0.0.1";
    if (this.opts.registerCleanup !== false) {
      this.unregisterCleanup = registerGlobalCleanup(
        `builtin-proxy:${this.dependency}:${this.boundPort}`,
        () => this.close(),
        () => this.destroyAllSync(),
      );
    }
  }

  // ------------------------------------------------------------------ FaultInjector

  async capabilities(): Promise<InjectorCapabilities> {
    return {
      injector: this.name,
      available: !this.closed,
      ...(this.closed ? { reason: "proxy closed" } : {}),
      faults:
        this.mode === "http"
          ? ["latency", "bandwidth", "reset", "blackhole", "http-status", "slow-body"]
          : ["latency", "bandwidth", "reset", "blackhole"],
      partial: true,
      flapping: true,
      countsRequests: true,
    };
  }

  async apply(input: FaultInput | Fault, signal?: AbortSignal): Promise<AppliedFault> {
    if (this.closed) throw new Error("fault proxy is closed");
    const fault = parseFault(input);
    const caps = await this.capabilities();
    if (!caps.faults.includes(fault.type)) {
      throw new Error(`builtin proxy (${this.mode} mode) does not support fault "${fault.type}"`);
    }
    const id = fault.id ?? `f${++this.seq}`;
    if (this.faults.has(id)) await this.revert(id);
    const af: ActiveFault = { id, fault, appliedAt: this.now(), counter: 0, disarm: [] };
    this.faults.set(id, af);
    if (fault.ttlMs !== undefined) {
      const t = setTimeout(() => void this.revert(id), fault.ttlMs);
      t.unref();
      af.disarm.push(() => clearTimeout(t));
    }
    if (signal) {
      const onAbort = (): void => void this.revert(id);
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        af.disarm.push(() => signal.removeEventListener("abort", onAbort));
      }
    }
    if (fault.type === "blackhole" && fault.flapping) this.ensureHeldTimer();
    return { id, fault, appliedAt: af.appliedAt, revert: () => this.revert(id) };
  }

  /** Hot-swap: replaces a fault in place (same id). */
  async update(id: string, input: FaultInput | Fault): Promise<AppliedFault> {
    const f = parseFault(input);
    return this.apply({ ...f, id });
  }

  async revert(id?: string): Promise<void> {
    const ids = id === undefined ? [...this.faults.keys()] : [id];
    for (const fid of ids) {
      const af = this.faults.get(fid);
      if (!af) continue;
      this.faults.delete(fid);
      for (const d of af.disarm) d();
    }
    this.releaseHeld();
  }

  active(): string[] {
    return [...this.faults.keys()];
  }

  activeFaults(): { id: string; fault: Fault; appliedAt: number }[] {
    return [...this.faults.values()].map((a) => ({ id: a.id, fault: a.fault, appliedAt: a.appliedAt }));
  }

  // ------------------------------------------------------------------ stats

  stats(): ProxyStats {
    return { ...structuredClone(this.s), held: this.held.size };
  }

  /** Arrival times (clock ms) of requests (http) / connections (tcp), optionally within [fromMs, toMs). */
  arrivals(fromMs = Number.NEGATIVE_INFINITY, toMs = Number.POSITIVE_INFINITY): number[] {
    const out: number[] = [];
    for (const t of this.arrivalRing) if (t >= fromMs && t < toMs) out.push(t);
    return out;
  }

  resetStats(): void {
    this.s = BuiltinFaultProxy.freshStats();
    this.arrivalRing.clear();
  }

  // ------------------------------------------------------------------ decisions

  private isOn(af: ActiveFault, t: number): boolean {
    const fl = af.fault.flapping;
    return fl ? flapActive(t - af.appliedAt, fl.onMs, fl.offMs) : true;
  }

  private plan(t: number): Plan {
    const p: Plan = { latencyMs: 0, bytesPerSecond: 0 };
    for (const af of this.faults.values()) {
      if (!this.isOn(af, t)) continue;
      const f = af.fault;
      if (f.type === "container") continue;
      if (!selectByCounter(af.counter++, f.percent)) continue;
      this.s.injected[f.type] = (this.s.injected[f.type] ?? 0) + 1;
      switch (f.type) {
        case "latency": {
          const j = f.jitterMs > 0 ? (this.random() * 2 - 1) * f.jitterMs : 0;
          p.latencyMs += Math.max(0, f.latencyMs + j);
          break;
        }
        case "bandwidth":
          p.bytesPerSecond =
            p.bytesPerSecond > 0 ? Math.min(p.bytesPerSecond, f.bytesPerSecond) : f.bytesPerSecond;
          break;
        case "slow-body":
          p.slowBody = { delayMs: f.delayMs, chunkBytes: f.chunkBytes };
          break;
        case "reset":
          p.terminal ??= f.when === "after-response" ? { kind: "reset-after-response" } : { kind: "reset" };
          break;
        case "blackhole":
          p.terminal ??= { kind: "blackhole", faultId: af.id };
          break;
        case "http-status":
          p.terminal ??= {
            kind: "status",
            status: f.status,
            ...(f.body !== undefined ? { body: f.body } : {}),
          };
          break;
      }
    }
    return p;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const sig = this.closeCtl.signal;
    return new Promise((resolve, reject) => {
      if (sig.aborted) {
        reject(new Error("proxy closed"));
        return;
      }
      const t = setTimeout(() => {
        sig.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new Error("proxy closed"));
      };
      sig.addEventListener("abort", onAbort, { once: true });
    });
  }

  private ensureHeldTimer(): void {
    if (this.heldTimer) return;
    this.heldTimer = setInterval(() => this.releaseHeld(), 25);
    this.heldTimer.unref();
  }

  /** Releases held requests whose black-hole fault is gone or in its off phase. */
  private releaseHeld(): void {
    const t = this.now();
    for (const h of [...this.held]) {
      const af = this.faults.get(h.faultId);
      if (!af || !this.isOn(af, t)) {
        this.held.delete(h);
        h.release();
      }
    }
    if (
      this.held.size === 0 &&
      this.heldTimer &&
      ![...this.faults.values()].some((a) => a.fault.type === "blackhole")
    ) {
      clearInterval(this.heldTimer);
      this.heldTimer = null;
    }
  }

  private hold(faultId: string, release: () => void, destroy: () => void): void {
    this.held.add({ faultId, release, destroy });
    this.ensureHeldTimer();
  }

  private countResponse(status: number): void {
    const k = String(status);
    this.s.responses[k] = (this.s.responses[k] ?? 0) + 1;
  }

  /** Copies `src` to `dst` honouring bandwidth / slow-body shaping. Resolves when src ends. */
  private async pump(
    src: Readable,
    dst: Writable,
    shape: () => { bps: number; slow?: Plan["slowBody"]; latencyMs?: number },
    count: (n: number) => void,
  ): Promise<void> {
    let nextDue = 0;
    for await (const raw of src) {
      const chunk = raw as Buffer;
      const sh = shape();
      const pieces: Buffer[] = [];
      if (sh.slow) {
        for (let i = 0; i < chunk.length; i += sh.slow.chunkBytes)
          pieces.push(chunk.subarray(i, i + sh.slow.chunkBytes));
      } else pieces.push(chunk);
      for (const piece of pieces) {
        const t = this.now();
        let due = t;
        if (sh.latencyMs) due = Math.max(due, t + sh.latencyMs);
        if (sh.slow) due = Math.max(due, (nextDue || t) + sh.slow.delayMs);
        if (sh.bps > 0) due = Math.max(due, (nextDue || t) + (piece.length / sh.bps) * 1000);
        nextDue = Math.max(nextDue, due);
        if (due > t) await this.sleep(due - t);
        if (dst.destroyed) return;
        count(piece.length);
        if (!dst.write(piece)) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              dst.off("drain", done);
              dst.off("close", done);
              resolve();
            };
            dst.on("drain", done);
            dst.on("close", done);
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------ http mode

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t = this.now();
    this.s.requests++;
    this.arrivalRing.push(t);
    const plan = this.plan(t);
    try {
      if (plan.latencyMs > 0) await this.sleep(plan.latencyMs);
      const term = plan.terminal;
      if (term?.kind === "reset") {
        const sock = req.socket;
        if (typeof sock.resetAndDestroy === "function") sock.resetAndDestroy();
        else sock.destroy();
        return;
      }
      if (term?.kind === "status") {
        req.resume();
        const body =
          term.body ?? JSON.stringify({ error: "fault injected by second-world", status: term.status });
        res.writeHead(term.status, {
          "content-type": term.body !== undefined ? "text/plain" : "application/json",
          "content-length": Buffer.byteLength(body),
          "x-sw-fault": "http-status",
        });
        res.end(body);
        this.countResponse(term.status);
        return;
      }
      if (term?.kind === "blackhole") {
        await new Promise<void>((resolve, reject) => {
          this.hold(term.faultId, resolve, () => reject(new Error("proxy closed")));
          res.on("close", () => {
            for (const h of this.held) if (h.release === resolve) this.held.delete(h);
            reject(new Error("client gone"));
          });
        });
      }
      await this.forwardHttp(req, res, plan, term?.kind === "reset-after-response");
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { "content-type": "application/json", "x-sw-fault": "proxy-error" });
        res.end(JSON.stringify({ error: "bad gateway (fault proxy)" }));
        this.countResponse(502);
      } else res.destroy();
    }
  }

  /** RST (or destroy) the client connection of `res`. */
  private resetClient(sock: net.Socket): void {
    if (typeof sock.resetAndDestroy === "function") sock.resetAndDestroy();
    else sock.destroy();
  }

  private forwardHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    plan: Plan,
    resetAfterResponse = false,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed || res.destroyed) {
        reject(new Error("closed"));
        return;
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers))
        if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
      headers.host = `${this.upstream.host}:${this.upstream.port}`;
      this.s.forwarded++;
      const up = http.request(
        {
          host: this.upstream.host,
          port: this.upstream.port,
          method: req.method,
          path: req.url,
          headers,
          agent: this.agent,
        },
        (upRes) => {
          if (resetAfterResponse) {
            // The upstream processed the request and answered; read its whole response (so the
            // operation is complete upstream), then reset the client instead of relaying it.
            upRes.resume();
            upRes.on("error", () => {});
            upRes.once("end", () => {
              this.resetClient(req.socket);
              resolve();
            });
            upRes.once("close", () => {
              if (!upRes.complete) {
                this.resetClient(req.socket);
                resolve();
              }
            });
            return;
          }
          const out: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(upRes.headers))
            if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
          const shaped = plan.bytesPerSecond > 0 || plan.slowBody !== undefined;
          if (shaped) {
            delete out["content-length"];
          }
          res.writeHead(upRes.statusCode ?? 502, out);
          this.countResponse(upRes.statusCode ?? 502);
          this.pump(
            upRes,
            res,
            () => ({ bps: plan.bytesPerSecond, ...(plan.slowBody ? { slow: plan.slowBody } : {}) }),
            (n) => {
              this.s.bytesToClient += n;
            },
          ).then(
            () => {
              res.end();
              resolve();
            },
            (e: unknown) => {
              res.destroy();
              upRes.destroy();
              reject(e);
            },
          );
        },
      );
      up.on("error", (e) => {
        this.s.upstreamErrors++;
        reject(e);
      });
      res.on("close", () => {
        if (!res.writableFinished) up.destroy();
      });
      req.on("data", (c: Buffer) => {
        this.s.bytesToUpstream += c.length;
      });
      req.pipe(up);
    });
  }

  // ------------------------------------------------------------------ tcp mode

  private onTcp(client: net.Socket): void {
    const t = this.now();
    this.s.connections++;
    this.s.requests++;
    this.arrivalRing.push(t);
    // Per-connection selection for terminal faults; latency/bandwidth are re-evaluated per chunk.
    const plan = this.plan(t);
    const term = plan.terminal;
    if (term?.kind === "reset") {
      if (typeof client.resetAndDestroy === "function") client.resetAndDestroy();
      else client.destroy();
      return;
    }
    const pending: Buffer[] = [];
    const buffer = (c: Buffer): void => {
      pending.push(c);
    };
    client.on("data", buffer);
    const connect = (): void => {
      if (this.closed || client.destroyed) return;
      client.off("data", buffer);
      client.pause();
      const up = net.connect({ host: this.upstream.host, port: this.upstream.port });
      this.sockets.add(up);
      up.on("close", () => this.sockets.delete(up));
      up.on("error", () => {
        this.s.upstreamErrors++;
        client.destroy();
      });
      client.on("error", () => up.destroy());
      client.on("close", () => up.destroy());
      up.on("close", () => client.destroy());
      up.once("connect", () => {
        this.s.forwarded++;
        for (const c of pending) {
          this.s.bytesToUpstream += c.length;
          up.write(c);
        }
        pending.length = 0;
        const shape = (): { bps: number; latencyMs: number } => this.liveShape();
        this.pump(client, up, shape, (n) => {
          this.s.bytesToUpstream += n;
        }).then(
          () => up.end(),
          () => up.destroy(),
        );
        if (term?.kind === "reset-after-response") {
          // The upstream answered: drop its bytes and reset the client instead of relaying them.
          up.once("data", () => {
            this.resetClient(client);
            up.destroy();
          });
          return;
        }
        this.pump(up, client, shape, (n) => {
          this.s.bytesToClient += n;
        }).then(
          () => client.end(),
          () => client.destroy(),
        );
      });
    };
    if (term?.kind === "blackhole") {
      this.hold(term.faultId, connect, () => client.destroy());
      client.on("close", () => {
        for (const h of this.held) if (h.release === connect) this.held.delete(h);
      });
      return;
    }
    connect();
  }

  /** Current latency/bandwidth for tcp chunks (flapping honoured, percent not re-applied per chunk). */
  private liveShape(): { bps: number; latencyMs: number } {
    const t = this.now();
    let bps = 0;
    let latencyMs = 0;
    for (const af of this.faults.values()) {
      if (!this.isOn(af, t)) continue;
      const f = af.fault;
      if (f.type === "latency")
        latencyMs += Math.max(0, f.latencyMs + (f.jitterMs > 0 ? (this.random() * 2 - 1) * f.jitterMs : 0));
      else if (f.type === "bandwidth") bps = bps > 0 ? Math.min(bps, f.bytesPerSecond) : f.bytesPerSecond;
    }
    return { bps, latencyMs };
  }

  // ------------------------------------------------------------------ close

  private destroyAllSync(): void {
    if (!this.closeCtl.signal.aborted) this.closeCtl.abort();
    this.faults.clear();
    for (const h of this.held) h.destroy();
    this.held.clear();
    if (this.heldTimer) clearInterval(this.heldTimer);
    this.heldTimer = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.agent.destroy();
    try {
      this.server?.close();
    } catch {
      // not listening
    }
  }

  /** Reverts all faults, destroys every socket and stops listening. Idempotent. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unregisterCleanup?.();
      this.unregisterCleanup = null;
      const server = this.server;
      const closed = server
        ? new Promise<void>((resolve) => {
            if (!server.listening) resolve();
            else server.once("close", () => resolve());
          })
        : Promise.resolve();
      this.destroyAllSync();
      await closed;
    })();
    return this.closing;
  }
}

/** Starts a built-in fault proxy in front of `upstream`. */
export function startFaultProxy(opts: BuiltinProxyOptions): Promise<BuiltinFaultProxy> {
  return BuiltinFaultProxy.start(opts);
}
