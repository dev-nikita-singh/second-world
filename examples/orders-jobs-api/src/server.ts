/**
 * orders-jobs-api: orders whose payment runs in a background job queue + worker pool that charges
 * an outbound payment provider; the provider confirms with webhooks (idempotency keys); order reads
 * go through a read cache. node:http + node:sqlite, with SEEDED, DOCUMENTED defects
 * (see expected-findings.json). The intended (correct) contract is openapi.yaml.
 * docs/12-testing-and-quality.md §3.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { ReadCache } from "./cache.js";
import { Db } from "./db.js";
import { match, type Route, readJson, send, sendError } from "./http.js";
import { ProviderClient } from "./provider-client.js";
import { JobQueue } from "./queue.js";
import { jobRoutes } from "./routes/jobs.js";
import { type OrderView, orderRoutes } from "./routes/orders.js";
import { webhookRoutes } from "./routes/webhooks.js";

export interface OrdersAppOptions {
  /** Payment provider base URL. Default env PROVIDER_URL or http://127.0.0.1:4020. */
  providerUrl?: string;
  /** Payment worker loops. Default env WORKERS or 4. */
  workers?: number;
  /** Order read cache TTL (ms). Default 30 s. */
  cacheTtlMs?: number;
}

export interface OrdersApp {
  db: Db;
  server: Server;
  queue: JobQueue;
  provider: ProviderClient;
  cache: ReadCache<OrderView>;
  shutdown(): Promise<void>;
}

export function createApp(opts: OrdersAppOptions = {}): OrdersApp {
  const stop = new AbortController();
  const now = () => new Date().toISOString();
  const db = new Db();
  const provider = new ProviderClient(
    opts.providerUrl ?? process.env.PROVIDER_URL ?? "http://127.0.0.1:4020",
    stop.signal,
  );
  const cache = new ReadCache<OrderView>(1_000, opts.cacheTtlMs ?? 30_000);
  const queue = new JobQueue(db, provider, now);
  queue.start(opts.workers ?? Number(process.env.WORKERS ?? 4));

  const routes: Route[] = [
    { method: "GET", pattern: /^\/healthz$/, handler: async (_req, res) => send(res, 200, { ok: true }) },
    ...orderRoutes({ db, cache, queue, provider, now }),
    ...jobRoutes(db, queue),
    ...webhookRoutes(db, now),
    // Test-only hooks (a real deployment would not expose these).
    {
      method: "POST",
      pattern: /^\/__test\/reset$/,
      handler: async (_req, res) => {
        queue.clear();
        cache.clear();
        db.reset();
        send(res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      pattern: /^\/__test\/stats$/,
      handler: async (_req, res) =>
        send(res, 200, {
          queueDepth: queue.depth,
          workersBusy: queue.busy,
          providerCalls: provider.calls,
          cache: { size: cache.size, hits: cache.hits, misses: cache.misses },
        }),
    },
  ];

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = (req.method ?? "GET").toUpperCase();
        const m = match(routes, method, url.pathname);
        if (m === undefined) {
          send(res, 404, { error: { code: "not_found", message: "no such route" } });
          return;
        }
        if (m === "method-not-allowed") {
          send(res, 405, { error: { code: "method_not_allowed", message: "method not allowed" } });
          return;
        }
        const body = method === "POST" || method === "PUT" ? await readJson(req) : undefined;
        await m.route.handler(
          {
            method,
            path: url.pathname,
            params: m.params,
            query: url.searchParams,
            headers: req.headers,
            body,
          },
          res,
        );
      } catch (e) {
        sendError(res, e);
      }
    })();
  });
  server.keepAliveTimeout = 5_000;
  return {
    db,
    server,
    queue,
    provider,
    cache,
    shutdown: async () => {
      stop.abort();
      await queue.stop();
    },
  };
}

export interface RunningOrdersApp {
  url: string;
  port: number;
  app: OrdersApp;
  close(): Promise<void>;
}

/** Start on 127.0.0.1:`port` (0 = random). */
export async function start(port = 0, opts: OrdersAppOptions = {}): Promise<RunningOrdersApp> {
  const app = createApp(opts);
  const { server } = app;
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (e) {
    await app.shutdown();
    app.db.close();
    throw e;
  }
  const actual = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    app,
    close: () => {
      closing ??= (async () => {
        await app.shutdown();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
          for (const s of sockets) s.destroy();
        });
        app.db.close();
      })();
      return closing;
    },
  };
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await start(Number(process.env.PORT ?? 3200));
  process.stdout.write(`orders-jobs-api listening on ${app.url}\n`);
}
/* c8 ignore stop */
