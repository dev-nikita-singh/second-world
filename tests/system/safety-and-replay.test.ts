/**
 * System test: safety budgets, secret handling and replay fidelity across CLI + engines
 * (docs/11-safety-security-privacy.md §1/§2/§4, docs/03-engines/api-bug-hunter.md replay).
 * Each test guards a bug sw-qa reported to main (all fixed as of 2026-10-29).
 * Owner: sw-qa.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, SafetyError } from "../../src/index.js";
import { runCli } from "../helpers/cli.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";

const SECRET = "s3cr3t-Zq9vX2pL7wK4-sys";

let shop: RunningExample;
let tmp: TmpDir;
let userCfg: TmpDir;

const sw = (args: string[], timeoutMs = 90_000) =>
  runCli(args, {
    cwd: tmp.path,
    env: { SW_USER_CONFIG_DIR: userCfg.path, SHOP_USER_TOKEN: "alice-token", SYS_SECRET: SECRET },
    timeoutMs,
  });

beforeAll(async () => {
  shop = await startExample("shop-express");
  tmp = await makeTmpDir("sw-sys-safety-");
  userCfg = await makeTmpDir("sw-sys-usercfg-");
  mkdirSync(tmp.join(".git"));
  writeFileSync(
    tmp.join("sw.config.json"),
    JSON.stringify({
      targets: { api: { url: shop.url } },
      safety: { allowHosts: ["127.0.0.1"], allowMutations: true },
      auth: {
        user: { type: "bearer", token: { env: "SHOP_USER_TOKEN" } },
        other: { type: "bearer", token: "bob-token" },
        probe: { type: "header", name: "x-sys-probe", value: { env: "SYS_SECRET" } },
      },
      hooks: { reset: { http: { method: "POST", url: `${shop.url}/__test/reset` } } },
      performance: {
        auth: "user",
        scenarios: [{ name: "a", steps: [{ method: "GET", path: "/healthz" }] }],
      },
      bugs: { contract: `${process.cwd()}/examples/shop-express/openapi.yaml` },
    }),
  );
}, 60_000);

afterAll(async () => {
  await shop?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

describe("safety budgets", () => {
  it("open model: a rate above safety.maxRps is refused before sending", async () => {
    const world = await createWorld({
      config: { targets: { api: { url: shop.url } }, safety: { allowHosts: ["127.0.0.1"], maxRps: 50 } },
      cwd: tmp.path,
      probe: false,
      auditFile: false,
      userConfig: false,
    });
    try {
      await expect(
        world.performance.run({
          rate: 200,
          duration: "1s",
          scenarios: [{ name: "a", steps: [{ method: "GET", path: "/healthz" }] }],
        }),
      ).rejects.toBeInstanceOf(SafetyError);
    } finally {
      await world.close();
    }
  }, 30_000);

  // was a bug (throttle only on performance.budget.maxRps), fixed after sw-qa's report
  it("closed model: achieved rate stays within safety.maxRps (or the run is refused)", async () => {
    const world = await createWorld({
      config: { targets: { api: { url: shop.url } }, safety: { allowHosts: ["127.0.0.1"], maxRps: 50 } },
      cwd: tmp.path,
      probe: false,
      auditFile: false,
      userConfig: false,
    });
    try {
      const r = await world.performance
        .run({
          model: "closed",
          vus: 10,
          duration: "2s",
          warmup: 0,
          scenarios: [{ name: "a", steps: [{ method: "GET", path: "/healthz" }] }],
        })
        .catch((e) => e);
      if (r instanceof SafetyError) return;
      const d = (r as { data: { totals: { requests: number } } }).data;
      expect(d.totals.requests / 2).toBeLessThanOrEqual(50 * 1.1);
    } finally {
      await world.close();
    }
  }, 30_000);
});

describe("secrets", () => {
  it("sw config print masks env secrets", async () => {
    const r = await sw(["config", "print", "--resolved", "--json"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.includes(SECRET)).toBe(false);
    expect(r.stdout.includes("alice-token")).toBe(false);
  }, 60_000);

  // was a bug (dry-run plan printed the resolved auth), fixed after sw-qa's report
  it("sw --dry-run perf never prints a resolved secret", async () => {
    const r = await sw(["--dry-run", "perf"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("alice-token");
  }, 60_000);
});

describe("replay fidelity", () => {
  // was a bug (artifact stored an index into input.concurrency), fixed after sw-qa's report
  it("sw replay of a concurrency finding still reproduces (exit 1)", async () => {
    const hunt = await sw(
      [
        "--yes",
        "bugs",
        "--allow-mutations",
        "--techniques",
        "concurrency",
        "--concurrency-test",
        "POST /orders",
        "--burst",
        "5",
        "--role",
        "user",
        "--body",
        '{"items":[{"productId":20,"qty":1}]}',
        "--invariant",
        "linearizable:stock:1",
        "--json",
      ],
      120_000,
    );
    expect(hunt.exitCode, hunt.stderr.slice(-2000)).toBe(1);
    const f = JSON.parse(hunt.stdout).results[0].findings.find(
      (x: { ruleId: string }) => x.ruleId === "bugs/race-lost-update",
    );
    expect(f).toBeDefined();
    const r = await sw(["replay", String(f.fingerprint).slice(0, 10), "--runs", "3"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(1);
  }, 180_000);
});
