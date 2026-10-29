/** Order routes. */
import { Router } from "express";
import { currentUser, requireAuth } from "../auth.js";
import type { Db } from "../db.js";
import { OrderError, placeOrder } from "../services/orders.js";

export function ordersRouter(db: Db, paymentsUrl: string, stop: AbortSignal): Router {
  const r = Router();
  r.use("/orders", requireAuth);

  r.get("/orders", async (_req, res) => {
    res.json({ items: await db.ordersForUser(currentUser(res).id) });
  });

  // SEEDED-DEFECT:idempotency-ignored — the Idempotency-Key header is never read: retries create duplicate orders.
  r.post("/orders", async (req, res) => {
    const body = (req.body ?? {}) as { items?: unknown };
    if (!Array.isArray(body.items) || body.items.length === 0) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const lines: { productId: number; qty: number }[] = [];
    for (const it of body.items as { productId?: unknown; qty?: unknown }[]) {
      if (typeof it?.productId !== "number" || !Number.isInteger(it.qty)) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      lines.push({ productId: it.productId, qty: it.qty as number });
    }
    try {
      // SEEDED-DEFECT:idempotency-key-race — DISCOVERED (not planted) by the agent: concurrent requests with one Idempotency-Key each create an order (here a consequence of idempotency-ignored).
      const order = await placeOrder({ db, paymentsUrl, stop }, currentUser(res).id, lines);
      res.status(201).json(order);
    } catch (e) {
      if (e instanceof OrderError) {
        res.status(e.status).json({ error: e.code });
        return;
      }
      throw e;
    }
  });

  r.get("/orders/:id", async (req, res) => {
    const order = await db.getOrder(req.params.id);
    // SEEDED-DEFECT:bola-orders — no ownership check: any authenticated user can read any order.
    if (!order) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(order);
  });

  return r;
}
