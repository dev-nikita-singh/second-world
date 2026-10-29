/**
 * In-memory "mini shop" behind the real BugsHttp (fake executor, real budget lease), wrapped in a
 * bugs Session, for engine unit tests. Seeded defects (defective mode):
 * - POST /orders ignores Idempotency-Key (new id per request);
 * - GET /orders/{id} has no ownership check (any account can read any order);
 * - GET /items?limit=0 answers 500 instead of 400.
 * Correct mode fixes all three.
 */
import type {
  HttpExecutor,
  HttpRequestSpec,
  HttpResult,
} from "../../../src/adapters/http/undici-executor.js";
import { createRng } from "../../../src/core/rng.js";
import type { EngineContext } from "../../../src/core/types.js";
import { Dictionary } from "../../../src/engines/bugs/dictionary.js";
import { BugsHttp } from "../../../src/engines/bugs/http.js";
import type { BugsInput } from "../../../src/engines/bugs/schema.js";
import type { Session } from "../../../src/engines/bugs/session.js";
import { miniContract } from "./fixtures.js";

export const TOKENS: Record<string, string> = {
  "Bearer t1": "user",
  "Bearer t2": "other",
  "Bearer t3": "admin",
};
export const ROLES = {
  user: { type: "bearer" as const, token: "t1" },
  other: { type: "bearer" as const, token: "t2" },
  admin: { type: "bearer" as const, token: "t3" },
};

export class MiniShop {
  orders = new Map<string, { id: string; owner: string; qty: number; key?: string }>();
  next = 1;
  requests = 0;
  resets = 0;
  constructor(readonly correct = false) {}

  reset(): void {
    this.orders.clear();
    this.next = 1;
    this.resets++;
  }

  handle(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body?: string,
  ): { status: number; json?: unknown } {
    this.requests++;
    const who = TOKENS[headers.authorization ?? ""];
    const seg = url.pathname.split("/").filter(Boolean);
    if (method === "GET" && url.pathname === "/items") {
      const raw = url.searchParams.get("limit");
      if (raw !== null) {
        const n = Number(raw);
        if (n === 0 && !this.correct) return { status: 500, json: { error: "division by zero" } };
        if (!Number.isInteger(n) || n < 1 || n > 100) return { status: 400, json: { error: "limit" } };
      }
      return { status: 200, json: { items: [] } };
    }
    if (method === "GET" && seg[0] === "items" && seg.length === 2) {
      const id = Number(seg[1]);
      return id >= 1 && id <= 10 ? { status: 200, json: { id } } : { status: 404, json: { error: "nf" } };
    }
    if (method === "DELETE" && seg[0] === "items") return who === "admin" ? { status: 204 } : { status: 403 };
    if (method === "POST" && url.pathname === "/admin/reset") return { status: 204 };
    if (!who) return { status: 401, json: { error: "auth" } };
    if (method === "POST" && url.pathname === "/orders") {
      let qty: unknown;
      try {
        qty = (JSON.parse(body ?? "{}") as { qty?: unknown }).qty;
      } catch {
        return { status: 400 };
      }
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 100)
        return { status: 400, json: { error: "qty" } };
      const key = headers["idempotency-key"];
      if (this.correct && key) {
        const prior = [...this.orders.values()].find((o) => o.key === key && o.owner === who);
        if (prior) return { status: 201, json: { id: prior.id } };
      }
      const id = `o${this.next++}`;
      this.orders.set(id, { id, owner: who, qty, ...(key ? { key } : {}) });
      return { status: 201, json: { id } };
    }
    if (method === "GET" && seg[0] === "orders" && seg.length === 2) {
      const o = this.orders.get(decodeURIComponent(seg[1] as string));
      if (!o || (this.correct && o.owner !== who && who !== "admin"))
        return { status: 404, json: { error: "nf" } };
      return { status: 200, json: { id: o.id, qty: o.qty } };
    }
    return { status: 404 };
  }
}

function executor(app: MiniShop): HttpExecutor {
  return {
    inFlight: 0,
    openSockets: 0,
    async execute(req: HttpRequestSpec): Promise<HttpResult> {
      const h: Record<string, string> = {};
      if (Array.isArray(req.headers))
        for (let i = 0; i + 1 < req.headers.length; i += 2)
          h[(req.headers[i] as string).toLowerCase()] = req.headers[i + 1] as string;
      else for (const [k, v] of Object.entries(req.headers ?? {})) h[k.toLowerCase()] = v;
      const r = app.handle(
        req.method,
        new URL(req.path, req.origin),
        h,
        req.body === undefined ? undefined : String(req.body),
      );
      const text = r.json === undefined ? "" : JSON.stringify(r.json);
      return {
        status: r.status,
        headers: { "content-type": "application/json" },
        body: Buffer.from(text),
        bytesIn: text.length,
        bytesOut: 0,
        tStart: 0,
        tHeaders: 1,
        tEnd: 1,
      };
    },
    async close() {},
  };
}

/** deps.openSession replacement backed by a MiniShop. */
export function mockOpenSession(app: MiniShop, opts: { mutationsAllowed?: boolean } = {}) {
  return async (input: BugsInput, ctx: EngineContext): Promise<Session> => {
    const contract = miniContract();
    const lease = ctx.safety.reserve({ maxRequests: input.budget.maxRequests });
    const mutationsAllowed = opts.mutationsAllowed ?? true;
    const http = new BugsHttp(ctx, {
      target: input.target,
      timeoutMs: 1000,
      headers: {},
      roles: input.auth.roles,
      defaultRole: "user",
      invalidToken: input.auth.invalidToken,
      mutationsAllowed,
      lease,
      executor: executor(app),
    });
    const dict = new Dictionary(input.values);
    const roles = {
      default: "user",
      owner: "user",
      attacker: "other",
      privileged: ["admin"],
      unprivileged: ["user", "other"],
    };
    const seed = input.seed ?? 1;
    const hooks = {
      runs: 0,
      has: (n: string) => n === "reset",
      async run(n: string) {
        hooks.runs++;
        if (n === "reset") app.reset();
      },
      async close() {},
    };
    return {
      input,
      ctx,
      cwd: process.cwd(),
      seed,
      contract,
      http,
      hooks,
      env: {
        http,
        contract,
        opsByKey: new Map(contract.operations.map((o) => [o.key, o])),
        assertions: [],
        invariants: [],
        concurrency: [],
        concurrencyFns: new Map(),
        dict,
      },
      gen: { contract, dict, rng: createRng(seed), seed, input, roles },
      dict,
      lease,
      mutationsAllowed,
      limitations: [],
      roles,
      close: async () => {
        lease.release();
      },
    } as Session;
  };
}

export const BASE_INPUT = {
  target: "http://127.0.0.1:9",
  openapi: "(mock)",
  seed: 5,
  allowMutations: true,
  auth: { roles: ROLES },
};
