// @ts-nocheck — fixture: correct by design (bounded retries, exponential backoff + jitter, timeout)
const MAX_ATTEMPTS = 3;

export async function chargeWithRetry(body) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("https://payments.example.com/charges", {
        method: "POST",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, Math.random() * 100 * 2 ** attempt));
  }
  throw new Error("payment failed");
}
