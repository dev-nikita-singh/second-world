/**
 * Mini app with a configurable outbound-call policy, used to check the Reliability Lab detectors on
 * BOTH sides: defective policies (no timeout, constant retries) and correct-by-design ones
 * (timeout, capped exponential backoff with full jitter, circuit breaker with half-open probes).
 *
 * Routes: GET /checkout → POST <dependency>/charges with the policy (200 | 502 | 503 when the breaker is open)
 *         GET /browse   → 200, never touches the dependency (unrelated route)
 *         GET /healthz
 */
import http from "node:http";
import { type Listening, listenOnRandomPort } from "../../../helpers/servers.js";

export interface MiniAppPolicy {
  dependencyUrl: string;
  /** Per-attempt timeout (ms); undefined = none. */
  timeoutMs?: number;
  maxAttempts?: number;
  backoff?: "none" | "constant" | "full-jitter";
  baseMs?: number;
  capMs?: number;
  breaker?: { failures: number; cooldownMs: number };
  seed?: number;
}

export interface MiniApp extends Listening {
  stats(): { checkout: number; dependencyCalls: number; shortCircuited: number; breakerState: string };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export async function startMiniApp(p: MiniAppPolicy): Promise<MiniApp> {
  const rnd = lcg(p.seed ?? 7);
  const maxAttempts = p.maxAttempts ?? 1;
  const base = p.baseMs ?? 50;
  const cap = p.capMs ?? 1000;
  const stop = new AbortController();
  const st = { checkout: 0, dependencyCalls: 0, shortCircuited: 0 };
  let state: "closed" | "open" | "half-open" = "closed";
  let consecutive = 0;
  let openedAt = 0;
  let probing = false;

  const allow = (): boolean => {
    if (!p.breaker) return true;
    if (state === "open" && performance.now() - openedAt >= p.breaker.cooldownMs) state = "half-open";
    if (state === "open") return false;
    if (state === "half-open") {
      if (probing) return false;
      probing = true;
    }
    return true;
  };
  const onResult = (ok: boolean): void => {
    if (!p.breaker) return;
    probing = false;
    if (ok) {
      consecutive = 0;
      state = "closed";
      return;
    }
    consecutive++;
    if (state === "half-open" || consecutive >= p.breaker.failures) {
      state = "open";
      openedAt = performance.now();
    }
  };

  async function callOnce(): Promise<boolean> {
    st.dependencyCalls++;
    try {
      const signals = [stop.signal, ...(p.timeoutMs !== undefined ? [AbortSignal.timeout(p.timeoutMs)] : [])];
      const res = await fetch(`${p.dependencyUrl}/charges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "o", amount: 1 }),
        signal: AbortSignal.any(signals),
      });
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  }

  async function checkout(): Promise<number> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (stop.signal.aborted) return 503;
      if (!allow()) {
        st.shortCircuited++;
        return 503;
      }
      const ok = await callOnce();
      onResult(ok);
      if (ok) return 200;
      if (attempt + 1 < maxAttempts) {
        const d =
          p.backoff === "full-jitter"
            ? rnd() * Math.min(cap, base * 2 ** (attempt + 1))
            : p.backoff === "constant"
              ? base
              : 0;
        if (d > 0) await new Promise((r) => setTimeout(r, d));
      }
    }
    return 502;
  }

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const s = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
      res.end(s);
    };
    if (req.url === "/healthz" || req.url === "/browse") return send(200, { ok: true });
    if (req.url === "/checkout") {
      st.checkout++;
      void checkout().then((code) => send(code, { code }));
      return;
    }
    send(404, {});
  });
  const l = await listenOnRandomPort(server);
  return {
    ...l,
    close: async () => {
      stop.abort();
      await l.close();
    },
    stats: () => ({ ...st, breakerState: state }),
  };
}
