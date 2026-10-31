/** Orders service. */
import type { Db, Order, OrderItem } from "../db.js";
import { charge } from "../payments-client.js";
import { unitPrice } from "../pricing.js";
import { reserve } from "./inventory.js";

export class OrderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface PlaceOrderDeps {
  db: Db;
  paymentsUrl: string;
  stop: AbortSignal;
}

export async function placeOrder(
  deps: PlaceOrderDeps,
  userId: string,
  lines: { productId: number; qty: number }[],
): Promise<Order> {
  const items: OrderItem[] = [];
  for (const line of lines) {
    const product = await deps.db.getProduct(line.productId);
    if (!product) throw new OrderError(404, "product_not_found");
    const price = unitPrice(product.price, line.qty);
    const r = await reserve(deps.db, line.productId, line.qty);
    if (!r.ok) throw new OrderError(r.reason === "not_found" ? 404 : 409, r.reason);
    items.push({ productId: line.productId, qty: line.qty, unitPrice: price });
  }
  const total = Math.round(items.reduce((s, i) => s + i.unitPrice * i.qty, 0) * 100) / 100;
  const order = await deps.db.insertOrder({ userId, items, total, status: "pending" });
  const ch = await charge(deps.paymentsUrl, order.id, total, deps.stop);
  return (await deps.db.updateOrder(order.id, { status: "paid", chargeId: ch.id })) ?? order;
}

/** Quantity of a product in orders that are still pending payment. */
export async function pendingQuantity(db: Db, productId: number): Promise<number> {
  const orders = await db.allOrders();
  let q = 0;
  for (const o of orders) if (o.status === "pending") for (const i of o.items) if (i.productId === productId) q += i.qty;
  return q;
}
