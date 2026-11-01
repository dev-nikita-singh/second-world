/**
 * Client for the payment provider (provider/server.ts in tests, a PSP in real life):
 *   POST /charges        { orderId, amount } + Idempotency-Key → 201 { id, orderId, amount, status }
 *   GET  /charges/:id    → 200 charge | 404
 * The provider confirms captures asynchronously with a `charge.succeeded` webhook.
 */
export interface Charge {
  id: string;
  orderId: number;
  amount: number;
  status: string;
}

/** A 4xx from the provider: retrying the same request cannot succeed. */
export class PermanentProviderError extends Error {}

/** Per-attempt timeout of a charge request (ms). */
export const CHARGE_TIMEOUT_MS = 2_000;
/** Attempts per charge (1 + retries). */
export const MAX_ATTEMPTS = 8;
/** Pause between attempts (ms). */
export const RETRY_DELAY_MS = 100;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ProviderClient {
  /** Requests sent to the provider (GET /__test/stats). */
  calls = 0;

  constructor(
    private readonly baseUrl: string,
    /** Aborted when the app shuts down. */
    private readonly stop: AbortSignal,
  ) {}

  /**
   * Create the charge for an order. Every attempt sends the same Idempotency-Key (one per order),
   * so a retried attempt can never charge twice. Returns the charge and the number of attempts made.
   */
  async createCharge(
    orderId: number,
    amount: number,
    idempotencyKey: string,
  ): Promise<{ charge: Charge; attempts: number }> {
    let lastError = "no attempt";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.stop.aborted) throw new Error("shutting down");
      try {
        this.calls++;
        const res = await fetch(`${this.baseUrl}/charges`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ orderId, amount }),
          signal: AbortSignal.any([this.stop, AbortSignal.timeout(CHARGE_TIMEOUT_MS)]),
        });
        if (res.status === 200 || res.status === 201)
          return { charge: (await res.json()) as Charge, attempts: attempt };
        await res.arrayBuffer();
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
          throw new PermanentProviderError(`provider rejected the charge: ${res.status}`);
        lastError = `provider answered ${res.status}`;
      } catch (e) {
        if (e instanceof PermanentProviderError) throw e;
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (attempt === MAX_ATTEMPTS) break;
      // SEEDED-DEFECT:retry-storm-no-jitter — every failed attempt waits the same fixed 100 ms: no exponential backoff, no jitter, no circuit breaker; while the provider fails, every worker hammers it in lock-step.
      await sleep(RETRY_DELAY_MS, this.stop);
    }
    throw new Error(`charge failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  }

  /** Current state of a charge at the provider, or undefined when the provider does not know it. */
  async getCharge(chargeId: string): Promise<Charge | undefined> {
    this.calls++;
    // SEEDED-DEFECT:refresh-no-timeout — no timeout / AbortSignal: when the provider hangs, GET /orders/{id}/payment?refresh=true hangs with it.
    const res = await fetch(`${this.baseUrl}/charges/${encodeURIComponent(chargeId)}`);
    if (res.status === 404) {
      await res.arrayBuffer();
      return undefined;
    }
    if (!res.ok) {
      await res.arrayBuffer();
      throw new Error(`provider answered ${res.status}`);
    }
    return (await res.json()) as Charge;
  }
}
