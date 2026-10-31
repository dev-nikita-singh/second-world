/**
 * Calibrated fixture server for the measurement-accuracy suite.
 * Spec: docs/12-testing-and-quality.md §2 (calibrated server + acceptance tolerances).
 *
 * Pure `node:http`, bound to 127.0.0.1 on port 0, keep-alive enabled.
 *
 * Routes:
 *   GET  /fixed/:ms                         respond after exactly :ms (precise timer)
 *   GET  /dist/uniform?min=&max=            latency ~ U(min, max) ms (seeded PRNG)
 *   GET  /dist/lognormal?median=&sigma=     latency ~ median * exp(sigma * Z) ms
 *   GET  /dist/bimodal?a=&b=&p=             latency a ms with prob p (0..1), else b ms
 *   GET  /error/:pct[?ms=]                  exactly pct% of requests (by per-pct counter) → 500
 *   GET  /stall[?ms=]                       held while a stall is active (see setBehavior)
 *   GET  /status/:code                      responds with that status
 *   POST /echo                              echoes the JSON (or raw) body
 *   GET  /slow-body/:ms[?chunks=]           streams the body over :ms milliseconds
 *   GET  /reset-conn                        destroys the socket without a response
 *   GET  /capacity/:n[?ms=&maxQueue=]       capacity cliff: n workers, service time ms (default 10);
 *                                           beyond n in-flight requests queue FIFO, so latency grows
 *                                           with the queue and throughput caps at n*1000/ms rps;
 *                                           queue > maxQueue (default unbounded) → 503 (load shedding)
 *   GET  /healthz                           200 {"ok":true}
 *
 * Determinism: all random latencies come from a seeded PRNG (mulberry32), so the
 * sequence of sampled latencies for a given seed is fixed (request *order* under
 * concurrency is of course up to the client).
 *
 * Timer precision: plain `setTimeout` overshoots by up to ~15 ms on Windows
 * (system timer resolution). We sleep coarsely until ~20 ms before the deadline
 * and then spin on `setImmediate` against `process.hrtime`, which gives sub-ms
 * accuracy on all three OSes. Disable with `{ precise: false }`.
 *
 * In-process vs child process — which to use:
 *   - `startCalibratedServer()` (this file, in-process): functional tests, fixture
 *     behaviour, anything that does not judge the load generator's health. Fast start,
 *     synchronous control methods.
 *   - `startCalibratedServerInChild()` (./calibrated-child.ts): load tests where the
 *     Performance Lab / Stress Lab self-check matters (accuracy suite, stress stages,
 *     long runs). The spin above burns CPU on the server's event loop; in-process that
 *     is attributed to the generator and causes a false "generator-saturated". Same API,
 *     control methods are async (RPC over stdio).
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface CalibratedServerOptions {
  /** PRNG seed for distribution routes. Default 42. */
  seed?: number;
  /** Use the precise (spin-assisted) timer. Default true. */
  precise?: boolean;
  /** Keep-alive timeout for idle sockets (ms). Default 5000. */
  keepAliveTimeoutMs?: number;
}

export interface CalibratedBehavior {
  /**
   * Absolute epoch ms (Date.now() scale) until which `/stall` requests are held.
   * `0` or a past value releases all held requests immediately.
   */
  stallUntilMs?: number;
  /** When true, a stall holds requests on *every* route, not only `/stall`. Default false. */
  stallAllRoutes?: boolean;
}

export interface CalibratedStats {
  requests: number;
  inFlight: number;
  inFlightMax: number;
  byRoute: Record<string, number>;
  /** Count of responses by status code. */
  byStatus: Record<string, number>;
}

export interface CalibratedServer {
  url: string;
  port: number;
  close(): Promise<void>;
  stats(): CalibratedStats;
  resetStats(): void;
  setBehavior(b: CalibratedBehavior): void;
  /** Convenience: stall for `ms` from now. */
  stallFor(ms: number, opts?: { allRoutes?: boolean }): void;
}

/** mulberry32: tiny, fast, good-enough seeded PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller using the provided uniform source. */
function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const nowNs = (): bigint => process.hrtime.bigint();

/** Shared precise sleeper: one spin loop serves all waiters near their deadline. */
class PreciseSleeper {
  private spinning: { end: bigint; resolve: () => void }[] = [];
  private loopScheduled = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly precise: boolean) {}

  sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      if (!this.precise) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          resolve();
        }, ms);
        this.timers.add(t);
        return;
      }
      const end = nowNs() + BigInt(Math.round(ms * 1e6));
      const coarse = ms - 20;
      const enter = () => {
        this.spinning.push({ end, resolve });
        this.schedule();
      };
      if (coarse > 0) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          enter();
        }, coarse);
        this.timers.add(t);
      } else enter();
    });
  }

  private schedule(): void {
    if (this.loopScheduled) return;
    this.loopScheduled = true;
    setImmediate(this.tick);
  }

  private readonly tick = (): void => {
    this.loopScheduled = false;
    const now = nowNs();
    const remaining: { end: bigint; resolve: () => void }[] = [];
    for (const w of this.spinning) {
      if (w.end <= now || this.closed) w.resolve();
      else remaining.push(w);
    }
    this.spinning = remaining;
    if (remaining.length > 0) this.schedule();
  };

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of this.spinning) w.resolve();
    this.spinning = [];
  }
}

function num(v: string | null | undefined, dflt: number): number {
  if (v === null || v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

/** Start the calibrated server. See file header for the route list. */
export async function startCalibratedServer(opts: CalibratedServerOptions = {}): Promise<CalibratedServer> {
  const rand = mulberry32(opts.seed ?? 42);
  const sleeper = new PreciseSleeper(opts.precise ?? true);
  const sockets = new Set<Socket>();
  const errorCounters = new Map<number, number>();
  /** Capacity pools keyed by n: busy workers + FIFO queue of waiters. */
  const pools = new Map<number, { busy: number; queue: (() => void)[] }>();

  let behavior: Required<CalibratedBehavior> = { stallUntilMs: 0, stallAllRoutes: false };
  let stallWaiters: (() => void)[] = [];
  let stallTimer: NodeJS.Timeout | undefined;
  let closed = false;

  let stats: CalibratedStats = { requests: 0, inFlight: 0, inFlightMax: 0, byRoute: {}, byStatus: {} };

  const releaseCapacityQueues = (): void => {
    for (const p of pools.values()) {
      const q = p.queue;
      p.queue = [];
      for (const w of q) w();
    }
  };

  const releaseStall = (): void => {
    const ws = stallWaiters;
    stallWaiters = [];
    for (const w of ws) w();
  };

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
    const remaining = behavior.stallUntilMs - Date.now();
    if (remaining <= 0) {
      releaseStall();
      return;
    }
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      // Re-check: setTimeout may fire a hair early relative to Date.now().
      if (Date.now() < behavior.stallUntilMs) armStall();
      else releaseStall();
    }, remaining);
  };

  const waitStall = (): Promise<void> => {
    if (closed || Date.now() >= behavior.stallUntilMs) return Promise.resolve();
    return new Promise((resolve) => stallWaiters.push(resolve));
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const head = parts[0] ?? "";
    const q = url.searchParams;
    const routeKey = head === "dist" ? `/dist/${parts[1] ?? ""}` : head === "" ? "/" : `/${head}`;
    stats.byRoute[routeKey] = (stats.byRoute[routeKey] ?? 0) + 1;

    if (behavior.stallAllRoutes && head !== "healthz") await waitStall();

    switch (head) {
      case "healthz":
        return sendJson(res, 200, { ok: true });
      case "fixed": {
        const ms = num(parts[1], 0);
        const t0 = nowNs();
        await sleeper.sleep(ms);
        // heldMs: actual server-side hold time (hrtime), independent of client-side noise.
        return sendJson(res, 200, { ok: true, delayMs: ms, heldMs: Number(nowNs() - t0) / 1e6 });
      }
      case "dist": {
        const kind = parts[1];
        let ms: number;
        if (kind === "uniform") {
          const min = num(q.get("min"), 0);
          const max = num(q.get("max"), min);
          ms = min + rand() * (max - min);
        } else if (kind === "lognormal") {
          const median = num(q.get("median"), 50);
          const sigma = num(q.get("sigma"), 0.5);
          ms = median * Math.exp(sigma * normal(rand));
        } else if (kind === "bimodal") {
          const a = num(q.get("a"), 10);
          const b = num(q.get("b"), 100);
          const p = num(q.get("p"), 0.9);
          ms = rand() < p ? a : b;
        } else return sendJson(res, 404, { error: "unknown distribution" });
        await sleeper.sleep(ms);
        return sendJson(res, 200, { ok: true, delayMs: ms });
      }
      case "error": {
        const pct = Math.min(100, Math.max(0, num(parts[1], 0)));
        const n = errorCounters.get(pct) ?? 0;
        errorCounters.set(pct, n + 1);
        // Request n fails iff floor((n+1)*pct/100) > floor(n*pct/100): exactly pct per 100.
        const fail = Math.floor(((n + 1) * pct) / 100) > Math.floor((n * pct) / 100);
        await sleeper.sleep(num(q.get("ms"), 0));
        return fail ? sendJson(res, 500, { error: "injected" }) : sendJson(res, 200, { ok: true });
      }
      case "capacity": {
        const n = Math.max(1, Math.trunc(num(parts[1], 10)));
        const ms = num(q.get("ms"), 10);
        const maxQueue = num(q.get("maxQueue"), Number.POSITIVE_INFINITY);
        let pool = pools.get(n);
        if (!pool) pools.set(n, (pool = { busy: 0, queue: [] }));
        const t0 = performance.now();
        if (pool.busy >= n) {
          if (pool.queue.length >= maxQueue)
            return sendJson(res, 503, { error: "overloaded", queue: pool.queue.length });
          const p = pool;
          await new Promise<void>((resolve) => p.queue.push(resolve)); // slot handed over by the finisher
        } else pool.busy++;
        const queuedMs = performance.now() - t0;
        try {
          await sleeper.sleep(ms);
        } finally {
          const next = closed ? undefined : pool.queue.shift();
          if (next) next();
          else pool.busy--;
        }
        return sendJson(res, 200, { ok: true, delayMs: ms, queuedMs });
      }
      case "stall": {
        await waitStall();
        await sleeper.sleep(num(q.get("ms"), 0));
        return sendJson(res, 200, { ok: true });
      }
      case "status": {
        const code = Math.trunc(num(parts[1], 200));
        if (code < 100 || code > 599) return sendJson(res, 400, { error: "bad status" });
        if (code === 204 || code === 304 || code < 200) {
          res.writeHead(code);
          res.end();
          return;
        }
        return sendJson(res, code, { status: code });
      }
      case "echo": {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks);
        const ct = req.headers["content-type"] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": ct, "content-length": raw.length });
        res.end(raw);
        return;
      }
      case "slow-body": {
        const ms = num(parts[1], 100);
        const nChunks = Math.max(1, Math.min(1000, Math.trunc(num(q.get("chunks"), 10))));
        res.writeHead(200, { "content-type": "text/plain" }); // chunked
        const step = ms / nChunks;
        for (let i = 0; i < nChunks; i++) {
          if (closed || res.destroyed) return;
          res.write(`chunk ${i}\n`);
          await sleeper.sleep(step);
        }
        res.end();
        return;
      }
      case "reset-conn":
        req.socket.destroy();
        return;
      default:
        return sendJson(res, 404, { error: "not found" });
    }
  };

  const server = http.createServer({ keepAlive: true }, (req, res) => {
    stats.requests++;
    stats.inFlight++;
    if (stats.inFlight > stats.inFlightMax) stats.inFlightMax = stats.inFlight;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      stats.inFlight--;
    };
    res.on("finish", () => {
      stats.byStatus[String(res.statusCode)] = (stats.byStatus[String(res.statusCode)] ?? 0) + 1;
      finish();
    });
    res.on("close", finish);
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "fixture failure" });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = opts.keepAliveTimeoutMs ?? 5000;
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats: () => ({
      ...stats,
      byRoute: { ...stats.byRoute },
      byStatus: { ...stats.byStatus },
    }),
    resetStats: () => {
      stats = {
        requests: 0,
        inFlight: stats.inFlight,
        inFlightMax: stats.inFlight,
        byRoute: {},
        byStatus: {},
      };
      errorCounters.clear();
    },
    setBehavior: (b) => {
      behavior = { ...behavior, ...b };
      armStall();
    },
    stallFor: (ms, o) => {
      behavior = { stallUntilMs: Date.now() + ms, stallAllRoutes: o?.allRoutes ?? behavior.stallAllRoutes };
      armStall();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (stallTimer) clearTimeout(stallTimer);
      releaseStall();
      releaseCapacityQueues();
      sleeper.close();
      const p = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
      await p;
    },
  };
}
