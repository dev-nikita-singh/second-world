/**
 * Integration helpers for the agent: a counting reverse proxy (exact request count as seen by
 * the server, test-control endpoints excluded) and seeded-defect scoring.
 */
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Finding } from "../../../src/core/evidence/schemas.js";
import { expectedBugs } from "../bugs/ground-truth.js";

export interface CountingProxy {
  url: string;
  /** Requests forwarded, excluding /__test/* control calls. */
  count(): number;
  close(): Promise<void>;
}

export async function startCountingProxy(upstream: string): Promise<CountingProxy> {
  const up = new URL(upstream);
  let n = 0;
  const server: Server = createServer((req, res) => {
    if (!(req.url ?? "").startsWith("/__test/")) n++;
    const p = request(
      { host: up.hostname, port: up.port, method: req.method, path: req.url, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    p.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(p);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    count: () => n,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

/** Seeded bugs-engine defects (expected-findings.json) matched by reproduced-defect findings. */
export function matchedDefects(app: string, findings: Finding[]): string[] {
  const expected = expectedBugs(app);
  const out = new Set<string>();
  for (const f of findings) {
    if (f.classification !== "reproduced-defect") continue;
    const op = f.affected[0] ?? "";
    const hit = expected.find(
      (d) =>
        d.ruleId === f.ruleId &&
        [d.endpoint, ...(d.alsoEndpoints ?? [])].some(
          (e) => e !== undefined && e.replace(/\?.*$/, "").trim() === op,
        ),
    );
    if (hit) out.add(hit.id);
  }
  return [...out].sort();
}

export const SHOP_AUTH = {
  roles: {
    user: { type: "bearer" as const, token: "alice-token" },
    other: { type: "bearer" as const, token: "bob-token" },
    admin: { type: "bearer" as const, token: "admin-token" },
  },
};
