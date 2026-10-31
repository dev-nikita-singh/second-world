/**
 * conduit-api: a RealWorld "Conduit" style API (users, profiles, follows, articles, tags, comments,
 * favorites, feed) on node:http + node:sqlite, with SEEDED, DOCUMENTED defects
 * (see expected-findings.json). The intended (correct) contract is openapi.yaml.
 * docs/12-testing-and-quality.md §3.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { Db } from "./db.js";
import { Router, readJson, send, sendError } from "./http.js";
import { ArticleRepository } from "./repositories/articles.js";
import { CommentRepository } from "./repositories/comments.js";
import { UserRepository } from "./repositories/users.js";
import { articleRoutes } from "./routes/articles.js";
import { userRoutes } from "./routes/users.js";

export interface ConduitOptions {
  /** Simulated database round trip per query (ms). Default env QUERY_DELAY_MS or 1. */
  queryDelayMs?: number;
}

export interface Conduit {
  db: Db;
  server: Server;
}

export function createApp(opts: ConduitOptions = {}): Conduit {
  const db = new Db(opts.queryDelayMs ?? Number(process.env.QUERY_DELAY_MS ?? 1));
  const users = new UserRepository(db);
  const articles = new ArticleRepository(db);
  const comments = new CommentRepository(db);
  const router = new Router();
  router.get("/healthz", async (_req, res) => send(res, 200, { ok: true }));
  userRoutes(router, users);
  articleRoutes(router, { users, articles, comments, now: () => new Date().toISOString() });
  // Test-only hooks (a real deployment would not expose these).
  router.post("/__test/reset", async (_req, res) => {
    db.reset();
    send(res, 200, { ok: true });
  });
  router.get("/__test/stats", async (_req, res) => send(res, 200, { queries: db.queries }));

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = (req.method ?? "GET").toUpperCase();
        const m = router.match(method, url.pathname);
        if (m === undefined) {
          send(res, 404, { errors: { path: ["not found"] } });
          return;
        }
        if (m === "method-not-allowed") {
          send(res, 405, { errors: { method: ["not allowed"] } });
          return;
        }
        const body = method === "POST" || method === "PUT" ? await readJson(req) : undefined;
        await m.handler(
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
  return { db, server };
}

export interface RunningConduit {
  url: string;
  port: number;
  db: Db;
  close(): Promise<void>;
}

/** Start on 127.0.0.1:`port` (0 = random). */
export async function start(port = 0, opts: ConduitOptions = {}): Promise<RunningConduit> {
  const { db, server } = createApp(opts);
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    db,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
      });
      return closing;
    },
  };
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await start(Number(process.env.PORT ?? 3100));
  process.stdout.write(`conduit-api listening on ${app.url}\n`);
}
/* c8 ignore stop */
