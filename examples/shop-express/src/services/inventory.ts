/** Inventory service. */
import type { Db } from "../db.js";
// SEEDED-DEFECT:module-cycle — inventory.ts <-> orders.ts import each other.
import { pendingQuantity } from "./orders.js";

export type ReserveResult = { ok: true } | { ok: false; reason: "not_found" | "out_of_stock" };

/** Reserve stock for an order line. */
export async function reserve(db: Db, productId: number, qty: number): Promise<ReserveResult> {
  const product = await db.getProduct(productId);
  if (!product) return { ok: false, reason: "not_found" };
  if (product.stock < qty) return { ok: false, reason: "out_of_stock" };
  // SEEDED-DEFECT:stock-race — check-then-await-then-write: concurrent orders read the same stock (lost update / oversell).
  await db.query(() => null); // e.g. an "audit log" round-trip between the read and the write
  await db.setStock(productId, product.stock - qty);
  return { ok: true };
}

/** Stock report used by the admin dashboard. */
export async function stockReport(db: Db): Promise<{ productId: number; stock: number; pending: number }[]> {
  const products = await db.listProducts();
  const out: { productId: number; stock: number; pending: number }[] = [];
  for (const p of products) out.push({ productId: p.id, stock: p.stock, pending: await pendingQuantity(db, p.id) });
  return out;
}
