/** Client for the payments provider (examples/payments-fake). */
export interface Charge {
  id: string;
  orderId: string;
  amount: number;
  status: string;
  attempts: number;
}

/**
 * Charge an order. `stop` only exists so tests can shut the app down cleanly;
 * it does not bound the retries during normal operation.
 */
export async function charge(baseUrl: string, orderId: string, amount: number, stop?: AbortSignal): Promise<Charge> {
  let attempts = 0;
  // SEEDED-DEFECT:unbounded-retry — retries forever, immediately, with no backoff/jitter and no attempt cap.
  while (true) {
    if (stop?.aborted) throw new Error("shutting down");
    attempts++;
    try {
      // SEEDED-DEFECT:no-timeout-outbound — no timeout/AbortSignal: a hanging provider hangs the request forever.
      const res = await fetch(`${baseUrl}/charges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, amount }),
      });
      if (res.ok) {
        const body = (await res.json()) as Omit<Charge, "attempts">;
        return { ...body, attempts };
      }
      await res.arrayBuffer();
    } catch {
      // swallow and retry immediately
    }
  }
}
