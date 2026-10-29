import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HttpExecutor, HttpResult } from "../../../src/adapters/http/undici-executor.js";
import { createEngineContext } from "../../../src/core/context.js";
import { embedContext, hydrateForReplay } from "../../../src/engines/bugs/artifact.js";
import {
  type BugCase,
  type EvalEnv,
  rebuildModelExpectations,
  runCase,
} from "../../../src/engines/bugs/cases.js";
import { indexContract } from "../../../src/engines/bugs/contract.js";
import { BugsHttp, type RequestTemplate } from "../../../src/engines/bugs/http.js";
import { BugsInputSchema } from "../../../src/engines/bugs/schema.js";
import type { Session } from "../../../src/engines/bugs/session.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const CONTRACT = indexContract({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  security: [{ bearer: [] }],
  paths: {
    "/orders": {
      post: { responses: { "201": { description: "c" }, "409": { description: "out of stock" } } },
    },
    "/orders/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "o" }, "404": { description: "nf" } },
      },
    },
  },
});

let tmp: TmpDir;
beforeAll(async () => {
  tmp = await makeTmpDir("sw-bugs-art-");
  await writeFile(
    tmp.join("inv.mjs"),
    "export default (b) => b.responses.filter((r) => r.status === 201).length <= 1 || 'oversold';\n",
  );
  await writeFile(tmp.join("each.mjs"), "export const ok = () => true;\n");
});
afterAll(() => tmp.cleanup());

function fakeExec(statuses: number[]): HttpExecutor {
  let i = 0;
  return {
    inFlight: 0,
    openSockets: 0,
    async execute(): Promise<HttpResult> {
      const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
      return {
        status,
        bytesIn: 0,
        bytesOut: 0,
        tStart: i,
        tHeaders: i + 1,
        tEnd: i + 1,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"id":"o1"}'),
      };
    },
    async close() {},
  };
}

/** Minimal Session for embed/hydrate. `cfg` is the (loose) Bug Hunter input of that session. */
function session(
  cfg: Record<string, unknown>,
  opts: { contract?: boolean; statuses?: number[]; cwd?: string } = {},
): Session {
  const input = BugsInputSchema.parse({ target: "http://127.0.0.1:9", ...cfg });
  const http = new BugsHttp(createEngineContext(), {
    target: input.target,
    timeoutMs: 1000,
    headers: {},
    roles: input.auth.roles,
    defaultRole: "user",
    invalidToken: "x",
    mutationsAllowed: true,
    lease: { take: () => true, remaining: 1e9, release() {} },
    executor: fakeExec(opts.statuses ?? [200]),
  });
  const env: EvalEnv = {
    http,
    opsByKey: new Map(CONTRACT.operations.map((o) => [o.key, o])),
    assertions: input.assertions,
    invariants: [],
    concurrency: input.concurrency,
    concurrencyFns: new Map(),
  };
  if (opts.contract !== false) env.contract = CONTRACT;
  const s = {
    input,
    cwd: opts.cwd ?? tmp.path,
    roles: { default: "user", privileged: [], unprivileged: ["user", "other"] },
    env,
  } as unknown as Session;
  if (opts.contract !== false) (s as { contract?: unknown }).contract = CONTRACT;
  return s;
}

const ROLES = { user: { type: "bearer", token: "a" }, other: { type: "bearer", token: "b" } };
const req = (over: Partial<RequestTemplate> = {}): RequestTemplate => ({
  operation: "POST /orders",
  method: "POST",
  path: "/orders",
  pathParams: {},
  query: {},
  headers: {},
  body: { kind: "json", value: { productId: 20 } },
  secured: true,
  ...over,
});
const getReq = (role?: string): RequestTemplate =>
  req({
    operation: "GET /orders/{id}",
    method: "GET",
    path: "/orders/{id}",
    pathParams: { id: "{{rid}}" },
    body: { kind: "none" },
    ...(role ? { role } : {}),
  });
const roundTrip = (c: BugCase): BugCase => JSON.parse(JSON.stringify(c)) as BugCase;
const base = { id: "c", technique: "contract" as const, operation: "POST /orders", label: "t", seed: 1 };

describe("self-contained artifacts: every check kind survives a JSON round trip", () => {
  it("conformance: contract required, matching assertions embedded, default role written into steps", async () => {
    const s = session({
      auth: { roles: ROLES },
      assertions: [
        { operation: "POST /orders", status: 201 },
        { operation: "GET /nothing", status: 200 },
      ],
    });
    const c = roundTrip(
      embedContext(
        { ...base, steps: [{ request: req(), expect: "valid" }], check: { kind: "conformance" } },
        s,
      ),
    );
    expect(c.context?.contract?.required).toBe(true);
    expect(c.context?.assertions).toEqual([expect.objectContaining({ operation: "POST /orders" })]);
    expect(c.steps[0]?.request.role).toBe("user");
    expect(c.context?.roles).toEqual(["user"]);
    // replay with a config that has neither assertions nor roles' defaults → still checks the assertion
    const replay = session({ auth: { roles: ROLES } }, { statuses: [409] });
    const h = await hydrateForReplay(c, replay);
    expect(h.ok).toBe(true);
    const run = await runCase((h as { case: BugCase }).case, replay.env);
    expect(run.failures.map((f) => f.ruleId)).toContain("bugs/assertion-failed");
  });

  it("conformance without a contract at replay time → inconclusive (never a silent pass)", async () => {
    const c = roundTrip(
      embedContext(
        { ...base, steps: [{ request: req(), expect: "valid" }], check: { kind: "conformance" } },
        session({ auth: { roles: ROLES } }),
      ),
    );
    const h = await hydrateForReplay(c, session({ auth: { roles: ROLES } }, { contract: false }));
    expect(h).toEqual({ ok: false, reason: expect.stringMatching(/contract/) });
    // and the evaluator itself refuses to pass an unchecked conformance step
    const s2 = session({ auth: { roles: ROLES } }, { contract: false });
    const run = await runCase(c, s2.env);
    expect(run.inconclusive).toBe(true);
  });

  it("denied (BOLA): both test accounts are recorded; a missing account → inconclusive", async () => {
    const c = roundTrip(
      embedContext(
        {
          ...base,
          technique: "auth",
          operation: "GET /orders/{id}",
          steps: [
            { request: req({ role: "user" }), extract: { rid: "/id" }, expect: "none" },
            { request: getReq("other"), expect: "none" },
          ],
          check: { kind: "denied", step: 1, rule: "bugs/bola", detail: "x" },
        },
        session({ auth: { roles: ROLES } }),
      ),
    );
    expect(c.context?.roles.sort()).toEqual(["other", "user"]);
    expect(c.context?.contract?.required).toBe(false);
    const h = await hydrateForReplay(c, session({ auth: { roles: { user: ROLES.user } } }));
    expect(h).toEqual({ ok: false, reason: expect.stringMatching(/other/) });
    const ok = session({ auth: { roles: ROLES } }, { statuses: [201, 200] });
    const h2 = await hydrateForReplay(c, ok);
    const run = await runCase((h2 as { case: BugCase }).case, ok.env);
    expect(run.failures.map((f) => f.ruleId)).toEqual(["bugs/bola"]);
  });

  it("idempotent and round-trip checks are self-contained", async () => {
    for (const check of [
      { kind: "idempotent", pointer: "/id" },
      { kind: "round-trip", create: 0, read: 1 },
    ] as const) {
      const c = roundTrip(
        embedContext(
          {
            ...base,
            technique: "stateful",
            steps: [
              { request: req(), extract: { rid: "/id" }, expect: "valid" },
              { request: check.kind === "idempotent" ? req() : getReq(), expect: "valid" },
            ],
            check,
          },
          session({ auth: { roles: ROLES } }),
        ),
      );
      expect(c.check).toEqual(check);
      expect(c.context?.contract?.required).toBe(false);
      expect((await hydrateForReplay(c, session({ auth: { roles: ROLES } }))).ok).toBe(true);
    }
  });

  it("concurrency (built-in invariant): spec embedded, replays with an EMPTY concurrency config", async () => {
    const spec = {
      operation: "POST /orders",
      burst: 5,
      role: "user",
      body: { items: [{ productId: 20, qty: 1 }] },
      invariant: { kind: "linearizable", model: "stock", initial: 1 },
    };
    const c = roundTrip(
      embedContext(
        {
          ...base,
          technique: "concurrency",
          steps: [{ request: req({ role: "user" }), burst: 5, expect: "none" }],
          check: { kind: "concurrency", test: 1 },
        },
        session({ auth: { roles: ROLES }, concurrency: [{ operation: "GET /x", burst: 2 }, spec] }),
      ),
    );
    // the case referenced index 1 of its source config; the artifact embeds that spec and re-indexes it
    expect(c.check).toEqual({ kind: "concurrency", test: 0 });
    expect(c.context?.concurrency).toMatchObject({
      operation: "POST /orders",
      burst: 5,
      invariant: { kind: "linearizable", model: "stock", initial: 1 },
    });
    const replay = session({ auth: { roles: ROLES } }, { statuses: [201, 201, 409, 409, 409] });
    expect(replay.env.concurrency).toEqual([]);
    const h = await hydrateForReplay(c, replay);
    expect(h.ok).toBe(true);
    const run = await runCase((h as { case: BugCase }).case, replay.env);
    expect(run.failures.map((f) => f.ruleId)).toEqual(["bugs/race-lost-update"]);
  });

  it("concurrency (user module): path absolutised; missing module → inconclusive", async () => {
    const mk = (inv: string): BugCase =>
      roundTrip(
        embedContext(
          {
            ...base,
            technique: "concurrency",
            steps: [{ request: req({ role: "user" }), burst: 3, expect: "none" }],
            check: { kind: "concurrency", test: 0 },
          },
          session(
            {
              auth: { roles: ROLES },
              concurrency: [{ operation: "POST /orders", burst: 3, invariant: inv }],
            },
            { cwd: tmp.path },
          ),
        ),
      );
    const c = mk("inv.mjs");
    expect(c.context?.concurrency?.invariant).toEqual({ module: tmp.join("inv.mjs") });
    const replay = session({ auth: { roles: ROLES } }, { statuses: [201, 201, 201], cwd: process.cwd() });
    const h = await hydrateForReplay(c, replay);
    expect(h.ok).toBe(true);
    const run = await runCase((h as { case: BugCase }).case, replay.env);
    expect(run.failures[0]?.message).toMatch(/oversold/);
    const missing = await hydrateForReplay(mk("does-not-exist.mjs"), session({ auth: { roles: ROLES } }));
    expect(missing).toEqual({ ok: false, reason: expect.stringMatching(/cannot be loaded/) });
  });

  it("per-exchange invariant modules are embedded (absolute) and must load", async () => {
    const c = roundTrip(
      embedContext(
        { ...base, steps: [{ request: req(), expect: "valid" }], check: { kind: "conformance" } },
        session({
          auth: { roles: ROLES },
          invariants: ["each.mjs#ok", { module: "gone.mjs", operations: ["GET /never"] }],
        }),
      ),
    );
    expect(c.context?.invariants).toEqual([{ module: `${tmp.join("each.mjs")}#ok` }]);
    expect((await hydrateForReplay(c, session({ auth: { roles: ROLES } }))).ok).toBe(true);
    const broken = {
      ...c,
      context: {
        ...(c.context as NonNullable<BugCase["context"]>),
        invariants: [{ module: tmp.join("nope.mjs") }],
      },
    };
    expect((await hydrateForReplay(broken, session({ auth: { roles: ROLES } }))).ok).toBe(false);
  });

  it("model: lifecycle commands survive and expectations rebuild identically", async () => {
    const steps = [
      {
        request: req(),
        extract: { id0: "/id" },
        expect: "none" as const,
        model: { cmd: "create" as const, v: "id0", fields: { productId: 20 } },
      },
      { request: getReq(), expect: "none" as const, model: { cmd: "delete" as const, v: "id0" } },
      { request: getReq(), expect: "none" as const, model: { cmd: "read" as const, v: "id0" } },
    ];
    const c = roundTrip(
      embedContext(
        { ...base, technique: "stateful", steps, check: { kind: "model" } },
        session({ auth: { roles: ROLES } }),
      ),
    );
    expect(rebuildModelExpectations(c.steps).map((s) => s.expect)).toEqual(
      rebuildModelExpectations(steps).map((s) => s.expect),
    );
    expect((await hydrateForReplay(c, session({ auth: { roles: ROLES } }))).ok).toBe(true);
  });

  it("legacy artifact (no context) referencing a concurrency index absent from config → inconclusive", async () => {
    const legacy: BugCase = {
      ...base,
      technique: "concurrency",
      steps: [{ request: req(), burst: 3, expect: "none" }],
      check: { kind: "concurrency", test: 0 },
    };
    const replay = session({ auth: { roles: ROLES } });
    expect(await hydrateForReplay(legacy, replay)).toEqual({
      ok: false,
      reason: expect.stringMatching(/not embedded/),
    });
    // even if called directly, the evaluator fails safe
    const run = await runCase(legacy, replay.env);
    expect(run.inconclusive).toBe(true);
  });
});
