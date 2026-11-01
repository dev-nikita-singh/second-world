/**
 * provider: a fake payment service provider (PSP) for orders-jobs-api. Not part of the app under
 * test (`sw inspect` only reads src/).
 *
 *   POST /charges         { orderId, amount } + Idempotency-Key → 201 { id, orderId, amount, status: "pending" }
 *                         (same key → the same charge, 200); then, after `webhookDelayMs`, it delivers
 *                         `charge.succeeded` to the webhook URL (at least once: retried on non-2xx)
 *   GET  /charges/:id     → 200 charge | 404
 *   GET  /healthz
 *   GET  /__control       behaviour + stats;  POST /__control { latencyMs?, failPct?, hang?, duplicateWebhooks? }
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pathToFileURL } from "node:url";

export interface ProviderBehavior {
  /** Added latency per charge request (ms). */
  latencyMs: number;
  /** Deterministic failure percentage of charge attempts → 503. */
  failPct: number;
  /** Charge requests never get an answer while true. */
  hang: boolean;
  /** Deliver every webhook event twice (what at-least-once delivery does after a lost 2xx). */
  duplicateWebhooks: boolean;
  /** Delay before a webhook is delivered (ms). */
  webhookDelayMs: number;
}

export interface ProviderStats {
  chargeRequests: number;
  charges: number;
  webhooksDelivered: number;
  webhooksFailed: number;
}

interface Charge {
  id: string;
  orderId: number;
  amount: number;
  status: "pending" | "succeeded";
}

export interface RunningProvider {
  url: string;
  port: number;
  setBehavior(b: Partial<ProviderBehavior>): void;
  /** Where webhooks go (the app's POST /webhooks/payments). */
  setWebhookUrl(url: string): void;
  stats(): ProviderStats;
  close(): Promise<void>;
}

const DEFAULTS: ProviderBehavior = {
  latencyMs: 0,
  failPct: 0,
  hang: false,
  duplicateWebhooks: false,
  webhookDelayMs: 20,
};

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

export async function startProvider(
  opts: Partial<ProviderBehavior> & { port?: number; webhookUrl?: string } = {},
): Promise<RunningProvider> {
  const { port: wanted = 0, webhookUrl: initialHook, ...initial } = opts;
  let behavior: ProviderBehavior = { ...DEFAULTS, ...initial };
  let webhookUrl = initialHook;
  const stats: ProviderStats = { chargeRequests: 0, charges: 0, webhooksDelivered: 0, webhooksFailed: 0 };
  const byKey = new Map<string, Charge>();
  const byId = new Map<string, Charge>();
  const timers = new Set<NodeJS.Timeout>();
  const hanging = new Set<http.ServerResponse>();
  const sockets = new Set<Socket>();
  const stop = new AbortController();
  let nextCharge = 1;
  let nextEvent = 1;
  let counter = 0;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  async function deliver(charge: Charge, eventKey: string, attempt: number): Promise<void> {
    if (!webhookUrl || stop.signal.aborted) return;
    let ok = false;
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": eventKey },
        body: JSON.stringify({
          type: "charge.succeeded",
          data: { orderId: charge.orderId, chargeId: charge.id, amount: charge.amount },
        }),
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(2_000)]),
      });
      await res.arrayBuffer();
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      stats.webhooksDelivered++;
      charge.status = "succeeded";
    } else if (attempt < 3 && !stop.signal.aborted) {
      later(100 * 2 ** attempt * (0.5 + Math.random()), () => void deliver(charge, eventKey, attempt + 1));
    } else stats.webhooksFailed++;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname === "/__control") {
        if (req.method === "POST") behavior = { ...behavior, ...(await readJson(req)) };
        return send(res, 200, { behavior, stats });
      }
      const one = /^\/charges\/([^/]+)$/.exec(url.pathname);
      if (one && req.method === "GET") {
        const c = byId.get(decodeURIComponent(one[1] as string));
        return c ? send(res, 200, c) : send(res, 404, { error: "no such charge" });
      }
      if (url.pathname === "/charges" && req.method === "POST") {
        const body = await readJson(req);
        stats.chargeRequests++;
        if (behavior.hang) {
          hanging.add(res);
          res.on("close", () => hanging.delete(res));
          return;
        }
        if (behavior.latencyMs > 0) await new Promise<void>((r) => later(behavior.latencyMs, r));
        const n = counter++;
        if (
          behavior.failPct > 0 &&
          Math.floor(((n + 1) * behavior.failPct) / 100) > Math.floor((n * behavior.failPct) / 100)
        )
          return send(res, 503, { error: "provider unavailable" });
        const key = String(req.headers["idempotency-key"] ?? "");
        const existing = key ? byKey.get(key) : undefined;
        if (existing) return send(res, 200, existing);
        const orderId = Number(body.orderId);
        const amount = Number(body.amount);
        if (!Number.isInteger(orderId) || !Number.isInteger(amount) || amount <= 0)
          return send(res, 400, { error: "orderId and amount are required" });
        const charge: Charge = { id: `ch_${nextCharge++}`, orderId, amount, status: "pending" };
        stats.charges++;
        if (key) byKey.set(key, charge);
        byId.set(charge.id, charge);
        send(res, 201, charge);
        const eventKey = `evt_${nextEvent++}`;
        later(behavior.webhookDelayMs, () => void deliver(charge, eventKey, 0));
        if (behavior.duplicateWebhooks)
          later(behavior.webhookDelayMs * 2 + 10, () => void deliver(charge, eventKey, 0));
        return;
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
    server.listen(wanted, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setBehavior: (b) => {
      behavior = { ...behavior, ...b };
    },
    setWebhookUrl: (u) => {
      webhookUrl = u;
    },
    stats: () => ({ ...stats }),
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        stop.abort();
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.close(() => resolve());
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
        hanging.clear();
      });
      return closing;
    },
  };
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = await startProvider({
    port: Number(process.env.PORT ?? 4020),
    latencyMs: Number(process.env.LATENCY_MS ?? 300),
    webhookUrl: process.env.WEBHOOK_URL ?? "http://127.0.0.1:3200/webhooks/payments",
  });
  process.stdout.write(`payment provider listening on ${p.url}\n`);
}
/* c8 ignore stop */
