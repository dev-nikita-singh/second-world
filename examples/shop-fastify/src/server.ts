/**
 * shop-fastify: the shop domain on Fastify 5 with a DIFFERENT subset of seeded defects
 * than shop-express (see expected-findings.json), plus correct implementations of
 * sequential idempotency replay, ownership checks and stock decrement (useful for precision:
 * engines must NOT report those here). Known, discovered (not planted) defect: concurrent
 * requests with the same Idempotency-Key each create an order (`idempotency-key-race`).
 *
 * `FIXED=1` (or `{ fixed: true }`) switches the product search from the slow
 * full-scan (one query per product) to the indexed rewrite (one query). This is the
 * known-better variant for What-If / Evolution tests. Other defects remain.
 * docs/12-testing-and-quality.md §3.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Db, type Product } from "./db.js";
import { charge } from "./payments-client.js";

export interface ShopOptions {
  paymentsUrl?: string;
  queryDelayMs?: number;
  /** Use the fixed (indexed) search. Default: env FIXED === "1". */
  fixed?: boolean;
}

interface User {
  id: string;
  role: "customer" | "admin";
}
const TOKENS: Record<string, User> = {
  "alice-token": { id: "u_alice", role: "customer" },
  "bob-token": { id: "u_bob", role: "customer" },
  "admin-token": { id: "u_admin", role: "admin" },
};

const TERMS_FILE = new URL("../terms.txt", import.meta.url);

function authUser(req: FastifyRequest, reply: FastifyReply): User | undefined {
  const h = req.headers.authorization ?? "";
  const user = h.startsWith("Bearer ") ? TOKENS[h.slice(7)] : undefined;
  if (!user) void reply.code(401).send({ error: "unauthorized" });
  return user;
}

export function createApp(
  opts: ShopOptions = {},
): FastifyInstance & { shop: { db: Db; stop: AbortController; fixed: boolean } } {
  const paymentsUrl = opts.paymentsUrl ?? process.env.PAYMENTS_URL ?? "http://127.0.0.1:4010";
  const fixed = opts.fixed ?? process.env.FIXED === "1";
  const db = new Db(opts.queryDelayMs ?? 1);
  const stop = new AbortController();
  const app = Fastify({ logger: false, forceCloseConnections: true });

  app.get("/healthz", async () => ({ ok: true, variant: fixed ? "fixed" : "seeded" }));

  app.get<{ Querystring: { page?: string; limit?: string } }>("/products", async (req) => {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const limit = Number(req.query.limit ?? 10);
    const total = await db.countProducts();
    // SEEDED-DEFECT:boundary-500-limit — limit=0 or negative → Infinity/negative array length → RangeError → 500 (contract: 400; valid 1..100).
    const pages = Array.from(new Array(Math.ceil(total / limit)), (_, i) => i + 1);
    const items = await db.pageProducts((page - 1) * limit, limit);
    return { items, page, pages: pages.length, total };
  });

  app.get<{ Querystring: { q?: string } }>("/products/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (!q) return reply.code(400).send({ error: "q_required" });
    if (fixed) return { items: await db.searchIndexed(q) };
    // SEEDED-DEFECT:slow-search — full scan with one query per product; FIXED=1 uses the inverted index (1 query).
    const ids = await db.productIds();
    const items: Product[] = [];
    for (const id of ids) {
      const p = await db.getProduct(id);
      if (p && p.name.toLowerCase().split(/\s+/).includes(q)) items.push(p);
    }
    return { items };
  });

  app.get<{ Params: { id: string } }>("/products/:id", async (req, reply) => {
    const p = await db.getProduct(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    return p;
  });

  app.delete<{ Params: { id: string } }>("/products/:id", async (req, reply) => {
    const user = authUser(req, reply);
    if (!user) return reply;
    // SEEDED-DEFECT:bfla-delete-product — admin-only per contract, but any authenticated customer may delete.
    const ok = await db.deleteProduct(Number(req.params.id));
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });

  app.get("/terms", async (_req, reply) => {
    // SEEDED-DEFECT:sync-fs-in-handler — readFileSync on every request blocks the event loop.
    const text = readFileSync(TERMS_FILE, "utf8");
    return reply.type("text/plain").send(text);
  });

  // The caller's own orders (admins too: only their own), with the Idempotency-Key each was created with.
  // Correct by design: ownership-scoped, createdAt as an ISO string. Lets duplicate-operation
  // invariants (sw reliability) count orders per key.
  app.get("/orders", async (req, reply) => {
    const user = authUser(req, reply);
    if (!user) return reply;
    return { items: await db.ordersForUser(user.id) };
  });

  app.post<{ Body: { productId?: unknown; qty?: unknown } }>("/orders", async (req, reply) => {
    const user = authUser(req, reply);
    if (!user) return reply;
    const { productId, qty } = req.body ?? {};
    if (
      typeof productId !== "number" ||
      typeof qty !== "number" ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 100
    ) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const key = req.headers["idempotency-key"];
    // SEEDED-DEFECT:idempotency-key-race — DISCOVERED (not planted) by the agent: lookup → await … → insert is not atomic, so concurrent requests with one key each create an order (sequential repeats are replayed correctly).
    if (typeof key === "string" && key) {
      const prev = await db.byIdempotencyKey(user.id, key);
      if (prev) return reply.code(201).send(prev);
    }
    const product = await db.getProduct(productId);
    if (!product) return reply.code(404).send({ error: "product_not_found" });
    const dec = await db.decrementStock(productId, qty);
    if (dec !== "ok") return reply.code(dec === "not_found" ? 404 : 409).send({ error: dec });
    const total = Math.round(product.price * qty * 100) / 100;
    const ch = await charge(paymentsUrl, `${user.id}:${productId}`, total, stop.signal);
    const order = await db.insertOrder(
      { userId: user.id, productId, qty, total, status: ch.ok ? "paid" : "payment_failed" },
      typeof key === "string" && key ? key : undefined,
    );
    return reply.code(ch.ok ? 201 : 502).send(order);
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const user = authUser(req, reply);
    if (!user) return reply;
    const o = await db.getOrder(req.params.id);
    if (!o || (o.userId !== user.id && user.role !== "admin"))
      return reply.code(404).send({ error: "not_found" });
    // SEEDED-DEFECT:schema-drift-created-at — createdAt is sent as epoch millis (number); contract says date-time string.
    return { ...o, createdAt: Date.parse(o.createdAt) };
  });

  app.post("/__test/reset", async () => {
    db.reset();
    return { ok: true };
  });
  app.get("/__test/stats", async () => ({ queries: db.queries }));

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    void reply.code(status).send({ error: status >= 500 ? "internal_error" : "bad_request" });
  });

  app.addHook("onClose", async () => {
    stop.abort();
  });
  return Object.assign(app, { shop: { db, stop, fixed } });
}

export interface RunningShop {
  url: string;
  port: number;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** Start on 127.0.0.1:`port` (0 = random). */
export async function start(port = 0, opts: ShopOptions = {}): Promise<RunningShop> {
  const app = createApp(opts);
  await app.listen({ port, host: "127.0.0.1" });
  const addr = app.server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    app,
    close: () => {
      closing ??= app.close().then(() => undefined);
      return closing;
    },
  };
}

/* c8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shop = await start(Number(process.env.PORT ?? 3001));
  process.stdout.write(
    `shop-fastify (${shop.app.shop.fixed ? "fixed" : "seeded"}) listening on ${shop.url}\n`,
  );
}
/* c8 ignore stop */
