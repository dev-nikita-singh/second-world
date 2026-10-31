/**
 * payments-fake: a tiny dependency service used by the shop examples.
 * Configurable latency, deterministic failure injection and a "hang" mode so the
 * shops' outbound-call defects (no timeout, retry storm) can be reproduced.
 *
 * Routes:
 *   POST /charges            { orderId, amount } → 201 { id, orderId, amount, status: "captured" }
 *   GET  /healthz
 *   GET  /__control          current behaviour + stats
 *   POST /__control          { latencyMs?, failPct?, failNext?, hang? }  (partial update)
 *   POST /__control/reset    reset behaviour and stats
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pathToFileURL } from "node:url";

export interface PaymentsBehavior {
  /** Added latency per charge (ms). */
  latencyMs: number;
  /** Deterministic failure percentage (by attempt counter): exactly failPct of every 100 attempts → 503. */
  failPct: number;
  /** The next N attempts fail with 503 (takes precedence over failPct). */
  failNext: number;
  /** When true, charges never respond (until hang is turned off or the server closes). */
  hang: boolean;
}

export interface PaymentsStats {
  attempts: number;
  succeeded: number;
  failed: number;
  /** Attempts per orderId. */
  attemptsByOrder: Record<string, number>;
  /** hrtime ms timestamps of each attempt (bounded to the last 1000). */
  attemptTimes: number[];
}

export interface PaymentsFake {
  url: string;
  port: number;
  setBehavior(b: Partial<PaymentsBehavior>): void;
  stats(): PaymentsStats;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULTS: PaymentsBehavior = { latencyMs: 0, failPct: 0, failNext: 0, hang: false };

function freshStats(): PaymentsStats {
  return { attempts: 0, succeeded: 0, failed: 0, attemptsByOrder: {}, attemptTimes: [] };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

/** Start the fake on 127.0.0.1 (port 0 by default). */
export async function startPaymentsFake(
  opts: Partial<PaymentsBehavior> & { port?: number } = {},
): Promise<PaymentsFake> {
  const { port: wantedPort = 0, ...initial } = opts;
  let behavior: PaymentsBehavior = { ...DEFAULTS, ...initial };
  let stats = freshStats();
  let counter = 0;
  let nextId = 1;
  const hanging = new Set<http.ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname === "/__control/reset" && req.method === "POST") {
        behavior = { ...DEFAULTS };
        stats = freshStats();
        counter = 0;
        return send(res, 200, behavior);
      }
      if (url.pathname === "/__control") {
        if (req.method === "POST") {
          const body = (await readJson(req)) as Partial<PaymentsBehavior> | undefined;
          behavior = { ...behavior, ...(body ?? {}) };
          if (!behavior.hang) for (const r of hanging) send(r, 503, { error: "released" });
        }
        return send(res, 200, { behavior, stats });
      }
      if (url.pathname === "/charges" && req.method === "POST") {
        const body = (await readJson(req)) as { orderId?: unknown; amount?: unknown } | undefined;
        const orderId = String(body?.orderId ?? "unknown");
        stats.attempts++;
        stats.attemptsByOrder[orderId] = (stats.attemptsByOrder[orderId] ?? 0) + 1;
        stats.attemptTimes.push(performance.now());
        if (stats.attemptTimes.length > 1000) stats.attemptTimes.shift();
        if (behavior.hang) {
          hanging.add(res);
          res.on("close", () => hanging.delete(res));
          return;
        }
        if (behavior.latencyMs > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(() => {
              timers.delete(t);
              r();
            }, behavior.latencyMs);
            timers.add(t);
          });
        }
        const n = counter++;
        let fail = false;
        if (behavior.failNext > 0) {
          behavior.failNext--;
          fail = true;
        } else if (behavior.failPct > 0) {
          fail = Math.floor(((n + 1) * behavior.failPct) / 100) > Math.floor((n * behavior.failPct) / 100);
        }
        if (fail) {
          stats.failed++;
          return send(res, 503, { error: "payment provider unavailable" });
        }
        stats.succeeded++;
        return send(res, 201, {
          id: `ch_${nextId++}`,
          orderId,
          amount: body?.amount ?? 0,
          status: "captured",
        });
      }
      return send(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal" });
    }
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(wantedPort, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setBehavior: (b) => {
      behavior = { ...behavior, ...b };
      if (!behavior.hang) for (const r of hanging) send(r, 503, { error: "released" });
    },
    stats: () => structuredClone(stats),
    reset: () => {
      behavior = { ...DEFAULTS };
      stats = freshStats();
      counter = 0;
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.close(() => resolve());
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
      });
      return closing;
    },
  };
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4010);
  const p = await startPaymentsFake({ port });
  process.stdout.write(`payments-fake listening on ${p.url}\n`);
}
/* c8 ignore stop */
