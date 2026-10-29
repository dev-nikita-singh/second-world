/**
 * Generic helpers for test servers: listen on 127.0.0.1:0, wait until ready, robust close.
 * docs/06-environments-and-portability.md §2 (ports: always 0, loopback only).
 */
import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface Listening {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Listen a node http.Server on 127.0.0.1 port 0, tracking sockets so that
 * `close()` also destroys idle keep-alive connections (otherwise close hangs).
 */
export async function listenOnRandomPort(server: Server, host = "127.0.0.1"): Promise<Listening> {
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => {
      closing ??= closeServer(server, sockets);
      return closing;
    },
  };
}

/** Close a server, destroying all open sockets. Never rejects on "not running". */
export function closeServer(server: Server, sockets?: Iterable<Socket>): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
    if (sockets) for (const s of sockets) s.destroy();
  });
}

/**
 * Poll `url` until it answers with a status < 500 or the timeout elapses.
 * Uses short backoff (10 → 100 ms), no long fixed sleeps.
 */
export async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let delay = 10;
  let lastErr: unknown;
  while (performance.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(Math.max(100, Math.min(2000, deadline - performance.now()))) });
      await r.arrayBuffer();
      if (r.status < 500) return;
      lastErr = new Error(`status ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(100, delay * 2);
  }
  throw new Error(`server at ${url} not ready after ${timeoutMs} ms: ${String(lastErr)}`);
}
