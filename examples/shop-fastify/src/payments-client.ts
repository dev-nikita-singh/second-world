/** Client for examples/payments-fake. Has a timeout (correct) but naive retries. */
export interface ChargeResult {
  ok: boolean;
  attempts: number;
  chargeId?: string;
}

export const RETRY_DELAY_MS = 50;
export const MAX_ATTEMPTS = 4;

export async function charge(
  baseUrl: string,
  orderId: string,
  amount: number,
  stop?: AbortSignal,
): Promise<ChargeResult> {
  // SEEDED-DEFECT:no-circuit-breaker — every request keeps calling a provider that has been failing for minutes.
  let attempts = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (stop?.aborted) break;
    attempts++;
    try {
      const res = await fetch(`${baseUrl}/charges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, amount }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { id: string };
        return { ok: true, attempts, chargeId: body.id };
      }
      await res.arrayBuffer();
    } catch {
      // fall through to retry
    }
    // SEEDED-DEFECT:retry-no-jitter — constant delay, no jitter: concurrent clients retry in lock-step (retry storm).
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { ok: false, attempts };
}
