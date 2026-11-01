/**
 * POST /webhooks/payments: payment events from the provider (`charge.succeeded`, `charge.failed`).
 * Providers deliver at least once and retry with the same `Idempotency-Key` until they get a 2xx.
 *
 * Authenticity: the example has no provider signature; the event must name one of our orders and
 * the exact amount we charged for it (a real deployment also verifies the provider's signature).
 */
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import { HttpError, int, invalid, notFound, object, type Request, type Route, send, str } from "../http.js";

const EVENT_TYPES = new Set(["charge.succeeded", "charge.failed"]);
const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const CHARGE_RE = /^ch_[A-Za-z0-9_]{1,60}$/;

interface EventRow {
  id: number;
  idempotency_key: string;
  type: string;
  order_id: number;
  charge_id: string;
  amount: number;
  received_at: string;
}

function view(e: EventRow) {
  return {
    id: e.id,
    type: e.type,
    orderId: e.order_id,
    chargeId: e.charge_id,
    amount: e.amount,
    receivedAt: e.received_at,
  };
}

export function webhookRoutes(db: Db, now: () => string): Route[] {
  async function paymentEvent(req: Request, res: ServerResponse): Promise<void> {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !KEY_RE.test(key))
      throw new HttpError(400, "bad_request", "Idempotency-Key header is required");
    const b = object(req.body, "body");
    const type = str(b, "type", { required: true, max: 40 }) as string;
    if (!EVENT_TYPES.has(type)) throw invalid("type is not a supported event type");
    const data = object(b.data, "data");
    const orderId = int(data, "orderId", { required: true, min: 1, max: 1_000_000_000 }) as number;
    const chargeId = str(data, "chargeId", { required: true, max: 64, pattern: CHARGE_RE }) as string;
    const amount = int(data, "amount", { required: true, min: 1, max: 100_000_000 }) as number;
    const event = db.tx(() => {
      const order = db.get<{ id: number; total: number; charge_id: string | null }>(
        "SELECT id, total, charge_id FROM orders WHERE id = ?",
        orderId,
      );
      if (!order) throw notFound("order");
      if (amount !== order.total) throw invalid("amount does not match the order total");
      if (order.charge_id !== null && order.charge_id !== chargeId)
        throw invalid("chargeId does not match the order");
      // SEEDED-DEFECT:webhook-replay-not-idempotent — the Idempotency-Key is stored but never looked up, and the amount is added on every delivery: a replayed charge.succeeded event records a new event and counts the payment twice.
      const id = db.run(
        `INSERT INTO webhook_events (idempotency_key, type, order_id, charge_id, amount, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        key,
        type,
        orderId,
        chargeId,
        amount,
        now(),
      ).lastInsertRowid;
      if (type === "charge.succeeded") {
        db.run(
          `UPDATE orders SET amount_paid = amount_paid + ?, charge_id = ?,
             payment_status = CASE WHEN amount_paid + ? >= total THEN 'paid' ELSE payment_status END
           WHERE id = ?`,
          amount,
          chargeId,
          amount,
          orderId,
        );
      } else {
        db.run(
          "UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'pending'",
          orderId,
        );
      }
      return db.get<EventRow>("SELECT * FROM webhook_events WHERE id = ?", id) as EventRow;
    });
    send(res, 200, view(event));
  }

  return [{ method: "POST", pattern: /^\/webhooks\/payments$/, handler: paymentEvent }];
}
