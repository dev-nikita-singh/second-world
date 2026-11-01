/** /orders routes: create (queues the payment job), list, read (cached), replace, delete, payment. */
import type { ServerResponse } from "node:http";
import { requireUser } from "../auth.js";
import type { ReadCache } from "../cache.js";
import type { Db } from "../db.js";
import {
  boolParam,
  idParam,
  int,
  intParam,
  invalid,
  notFound,
  object,
  type Request,
  type Route,
  send,
  str,
} from "../http.js";
import type { ProviderClient } from "../provider-client.js";
import type { JobQueue } from "../queue.js";

/** Catalogue prices in cents. */
export const PRICES: Readonly<Record<string, number>> = { "TEA-001": 1250, "MUG-002": 900, "BAG-003": 3400 };

interface OrderRow {
  id: number;
  user_id: number;
  sku: string;
  quantity: number;
  total: number;
  note: string;
  shipping_address: string;
  payment_job_id: number | null;
  payment_status: string;
  amount_paid: number;
  charge_id: string | null;
  created_at: string;
}

export interface OrderView {
  id: number;
  sku: string;
  quantity: number;
  total: number;
  note: string;
  shippingAddress: string;
  paymentJobId: number | null;
  createdAt: string;
}

function view(o: OrderRow): OrderView {
  return {
    id: o.id,
    sku: o.sku,
    quantity: o.quantity,
    total: o.total,
    note: o.note,
    shippingAddress: o.shipping_address,
    paymentJobId: o.payment_job_id,
    createdAt: o.created_at,
  };
}

const ADDRESS = { required: true, min: 1, max: 200 } as const;
const NOTE = { required: false, max: 200 } as const;

export interface OrderDeps {
  db: Db;
  cache: ReadCache<OrderView>;
  queue: JobQueue;
  provider: ProviderClient;
  now: () => string;
}

export function orderRoutes(deps: OrderDeps): Route[] {
  const { db, cache, queue, provider, now } = deps;

  /** The caller's order (another user's order is "not found", like a missing one). */
  function ownOrder(userId: number, rawId: string | undefined): OrderRow {
    const id = idParam(rawId, "order");
    const o = db.get<OrderRow>("SELECT * FROM orders WHERE id = ? AND user_id = ?", id, userId);
    if (!o) throw notFound("order");
    return o;
  }

  async function listOrders(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const limit = intParam(req.query, "limit", 1, 100, 20);
    const offset = intParam(req.query, "offset", 0, 1_000_000, 0);
    const rows = db.all<OrderRow>(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      user.id,
      limit,
      offset,
    );
    const total =
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE user_id = ?", user.id)?.n ?? 0;
    send(res, 200, { orders: rows.map(view), total });
  }

  async function createOrder(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const b = object(req.body, "body");
    const sku = str(b, "sku", { required: true, max: 20 }) as string;
    const price = PRICES[sku];
    if (price === undefined) throw invalid("sku is not in the catalogue");
    const quantity = int(b, "quantity", { required: true, min: 1, max: 10 }) as number;
    const shippingAddress = str(b, "shippingAddress", ADDRESS) as string;
    const note = str(b, "note", NOTE) ?? "";
    const created = db.tx(() => {
      const id = db.run(
        `INSERT INTO orders (user_id, sku, quantity, total, note, shipping_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        user.id,
        sku,
        quantity,
        price * quantity,
        note,
        shippingAddress,
        now(),
      ).lastInsertRowid;
      return id;
    });
    const job = queue.enqueue(created);
    db.run("UPDATE orders SET payment_job_id = ? WHERE id = ?", job.id, created);
    const o = db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", created) as OrderRow;
    send(res, 201, view(o), { location: `/orders/${o.id}` });
  }

  async function getOrder(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const id = idParam(req.params.id, "order");
    const key = `${user.id}:${id}`;
    const hit = cache.get(key);
    if (hit) {
      send(res, 200, hit, { "x-cache": "hit" });
      return;
    }
    const o = view(ownOrder(user.id, req.params.id));
    cache.set(key, o);
    send(res, 200, o, { "x-cache": "miss" });
  }

  async function updateOrder(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const o = ownOrder(user.id, req.params.id);
    const b = object(req.body, "body");
    const shippingAddress = str(b, "shippingAddress", ADDRESS) as string;
    const note = str(b, "note", { ...NOTE, required: true }) as string;
    db.run("UPDATE orders SET note = ?, shipping_address = ? WHERE id = ?", note, shippingAddress, o.id);
    // SEEDED-DEFECT:stale-cache-after-update — the cached view of this order is not invalidated (DELETE does it, PUT forgot): GET /orders/{id} keeps serving the old note/address until the entry expires.
    send(res, 200, view(db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", o.id) as OrderRow));
  }

  async function deleteOrder(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const o = ownOrder(user.id, req.params.id);
    db.run("DELETE FROM orders WHERE id = ?", o.id);
    cache.delete(`${user.id}:${o.id}`);
    send(res, 204);
  }

  async function getPayment(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const refresh = boolParam(req.query, "refresh");
    const o = ownOrder(user.id, req.params.id);
    const job = o.payment_job_id === null ? undefined : queue.get(o.payment_job_id);
    let atProvider: { status: string } | null = null;
    if (refresh && o.charge_id !== null) {
      try {
        const charge = await provider.getCharge(o.charge_id);
        atProvider = { status: charge?.status ?? "unknown" };
      } catch {
        atProvider = { status: "unavailable" };
      }
    }
    send(res, 200, {
      orderId: o.id,
      status: o.payment_status,
      amountDue: o.total,
      amountPaid: o.amount_paid,
      chargeId: o.charge_id,
      job: job ? { id: job.id, status: job.status, attempts: job.attempts } : null,
      provider: atProvider,
    });
  }

  return [
    { method: "GET", pattern: /^\/orders$/, handler: listOrders },
    { method: "POST", pattern: /^\/orders$/, handler: createOrder },
    { method: "GET", pattern: /^\/orders\/(?<id>[^/]+)$/, handler: getOrder },
    { method: "PUT", pattern: /^\/orders\/(?<id>[^/]+)$/, handler: updateOrder },
    { method: "DELETE", pattern: /^\/orders\/(?<id>[^/]+)$/, handler: deleteOrder },
    { method: "GET", pattern: /^\/orders\/(?<id>[^/]+)\/payment$/, handler: getPayment },
  ];
}
