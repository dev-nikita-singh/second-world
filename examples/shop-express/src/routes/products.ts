/** Product catalogue routes. */
import { Router } from "express";
import type { Db, Review } from "../db.js";

export function productsRouter(db: Db): Router {
  const r = Router();

  r.get("/products", async (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const products = await db.listProducts(category);
    if (req.query.include !== "reviews") {
      res.json({ items: products });
      return;
    }
    const items: ((typeof products)[number] & { reviews: Review[] })[] = [];
    for (const p of products) {
      // SEEDED-DEFECT:n-plus-one-reviews — one reviews query per product (use db.reviewsForMany(ids)).
      const reviews = await db.reviewsFor(p.id);
      items.push({ ...p, reviews });
    }
    res.json({ items });
  });

  r.get("/products/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const p = await db.getProduct(id);
    if (!p) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // SEEDED-DEFECT:schema-drift-price — price is serialised as a string here; the contract (and /products) say number.
    res.json({ ...p, price: p.price.toFixed(2) });
  });

  return r;
}
