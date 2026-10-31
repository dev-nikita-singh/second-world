/**
 * shop-express: a small shop API on Express 5 with SEEDED, DOCUMENTED defects
 * (see expected-findings.json). The intended (correct) contract is openapi.yaml.
 * docs/12-testing-and-quality.md §3.
 */
import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pathToFileURL } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import { login, requireAdmin } from "./auth.js";
import { Db } from "./db.js";
import { cartRouter } from "./routes/cart.js";
import { ordersRouter } from "./routes/orders.js";
import { productsRouter } from "./routes/products.js";
import { stockReport } from "./services/inventory.js";

export interface ShopOptions {
  /** Base URL of the payments provider (examples/payments-fake). Default env PAYMENTS_URL or http://127.0.0.1:4010. */
  paymentsUrl?: string;
  /** Artificial delay per DB query (ms). Default 1. */
  queryDelayMs?: number;
}

export interface ShopApp extends Express {
  locals: Express["locals"] & { db: Db; stop: AbortController };
}

export function createApp(opts: ShopOptions = {}): ShopApp {
  const paymentsUrl = opts.paymentsUrl ?? process.env.PAYMENTS_URL ?? "http://127.0.0.1:4010";
  const db = new Db(opts.queryDelayMs ?? 1);
  const stop = new AbortController();
  const app = express() as ShopApp;
  app.locals.db = db;
  app.locals.stop = stop;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/auth/login", (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const user = login(username, password);
    if (!user) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    res.json({ token: user.token, userId: user.id, role: user.role });
  });

  app.use(productsRouter(db));
  app.use(cartRouter(db));
  app.use(ordersRouter(db, paymentsUrl, stop.signal));

  app.get("/admin/stats", requireAdmin, async (_req, res) => {
    const orders = await db.allOrders();
    res.json({
      orders: orders.length,
      revenue: orders.reduce((s, o) => s + o.total, 0),
      stock: await stockReport(db),
    });
  });

  // Test-only hooks (a real app would not expose these).
  app.post("/__test/reset", (_req, res) => {
    db.reset();
    res.json({ ok: true });
  });
  app.get("/__test/stats", (_req, res) => {
    res.json({ queries: db.queries });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status =
      typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
  };
  app.use(onError);
  return app;
}

export interface RunningShop {
  url: string;
  port: number;
  app: ShopApp;
  close(): Promise<void>;
}

/** Start on 127.0.0.1:`port` (0 = random). */
export async function start(port = 0, opts: ShopOptions = {}): Promise<RunningShop> {
  const app = createApp(opts);
  const sockets = new Set<Socket>();
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve(s)));
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const actual = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    app,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        app.locals.stop.abort();
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
  const shop = await start(Number(process.env.PORT ?? 3000));
  process.stdout.write(`shop-express listening on ${shop.url}\n`);
}
/* c8 ignore stop */
