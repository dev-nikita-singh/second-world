/** Cart routes (per authenticated user). */
import { Router } from "express";
import { currentUser, requireAuth } from "../auth.js";
import type { Db } from "../db.js";
import { unitPrice } from "../pricing.js";

export function cartRouter(db: Db): Router {
  const r = Router();
  r.use("/cart", requireAuth);

  r.get("/cart", async (_req, res) => {
    const items = await db.getCart(currentUser(res).id);
    const total = Math.round(items.reduce((s, i) => s + i.unitPrice * i.qty, 0) * 100) / 100;
    res.json({ items, total });
  });

  r.post("/cart/items", async (req, res) => {
    const body = (req.body ?? {}) as { productId?: unknown; qty?: unknown };
    const productId = body.productId;
    const qty = body.qty;
    if (typeof productId !== "number" || !Number.isInteger(qty)) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const product = await db.getProduct(productId);
    if (!product) {
      res.status(404).json({ error: "product_not_found" });
      return;
    }
    // qty range is not validated here: unitPrice() throws for qty outside 1..100 (seeded boundary defect).
    const price = unitPrice(product.price, qty as number);
    const user = currentUser(res);
    const items = await db.getCart(user.id);
    const existing = items.find((i) => i.productId === productId);
    if (existing) {
      existing.qty = qty as number;
      existing.unitPrice = price;
    } else items.push({ productId, qty: qty as number, unitPrice: price });
    await db.setCart(user.id, items);
    res.status(201).json({ items });
  });

  r.delete("/cart", async (_req, res) => {
    await db.setCart(currentUser(res).id, []);
    res.status(204).end();
  });

  return r;
}
