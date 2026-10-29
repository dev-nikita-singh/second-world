/**
 * System test: a full investigation of shop-express through the CLI, as a user runs it
 * (docs/09-cli-and-api.md §1, docs/12-testing-and-quality.md §1/§3):
 *   sw inspect → sw perf → sw bugs → sw reliability run → sw model build → sw analyze
 *   → combined report in every format → history.
 * Asserts: each engine reports its seeded defects, every finding sits on its engine's rung of the
 * trust ladder (docs/01 §5), no credential ends up in any written file (docs/11), nothing is
 * written into examples/, and reliability leaves no fault or proxy behind.
 *
 * Setup: shop A (payments direct) serves perf/bugs; shop B talks to payments through a port that
 * only the Reliability Lab's built-in proxy listens on during the experiment.
 * Owner: sw-qa.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { combineResults, writeReports } from "../../src/engines/reporting/index.js";
import { runCli } from "../helpers/cli.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import {
  EXAMPLES_DIR,
  expectTrustLadder,
  findSecrets,
  freePort,
  parseJson,
  portRefuses,
  snapshotTree,
  walkFiles,
} from "./helpers.js";

const PROJECT = path.join(EXAMPLES_DIR, "shop-express");
const TOKENS = {
  SHOP_USER_TOKEN: "alice-token",
  SHOP_OTHER_TOKEN: "bob-token",
  SHOP_ADMIN_TOKEN: "admin-token",
};

let tmp: TmpDir;
let userCfg: TmpDir;
let shopA: RunningExample;
let shopB: { url: string; close(): Promise<void> };
let proxyPort: number;
let examplesBefore: Record<string, string>;
const results: Record<string, any> = {};

const env = () => ({
  ...TOKENS,
  SW_USER_CONFIG_DIR: userCfg.path,
  SW_FAULT_LEDGER: tmp.join("fault-ledger.json"),
});
const sw = (args: string[], timeoutMs = 90_000) => runCli(args, { cwd: tmp.path, env: env(), timeoutMs });

/** Runs an engine command with `--json`, checks the exit code and keeps its EngineResult. */
async function engineRun(name: string, args: string[], okExit: number[], timeoutMs?: number): Promise<any> {
  const r = await sw(["-o", `reports/${name}`, ...args, "--json"], timeoutMs);
  expect(okExit, `${name} exit ${r.exitCode}\n${r.stderr.slice(-3000)}`).toContain(r.exitCode);
  const rep = parseJson(r.stdout, `sw ${name} stdout`);
  expect(rep.kind).toBe("second-world-report");
  const res = rep.results[0];
  results[name] = res;
  return res;
}

beforeAll(async () => {
  examplesBefore = snapshotTree(EXAMPLES_DIR);
  tmp = await makeTmpDir("sw-sys-inv-");
  userCfg = await makeTmpDir("sw-sys-usercfg-");
  mkdirSync(tmp.join(".git"));
  shopA = await startExample("shop-express");
  proxyPort = await freePort();
  const m = await import("../../examples/shop-express/src/server.js");
  shopB = await m.start(0, { paymentsUrl: `http://127.0.0.1:${proxyPort}`, queryDelayMs: 1 });

  const config = {
    $schemaVersion: 1,
    project: { root: PROJECT, name: "shop-express" },
    environment: "local",
    targets: {
      api: { url: shopA.url, health: "/healthz" },
      "api-rel": { url: shopB.url, health: "/healthz" },
    },
    safety: {
      allowHosts: ["127.0.0.1", "localhost"],
      maxRps: 500,
      maxConcurrency: 100,
      allowMutations: true,
    },
    auth: {
      user: { type: "bearer", token: { env: "SHOP_USER_TOKEN" } },
      other: { type: "bearer", token: { env: "SHOP_OTHER_TOKEN" } },
      admin: { type: "bearer", token: { env: "SHOP_ADMIN_TOKEN" } },
    },
    hooks: { reset: { http: { method: "POST", url: `${shopA.url}/__test/reset` } } },
    performance: {
      target: "api",
      model: "open",
      rate: 20,
      duration: "3s",
      warmup: "0s",
      seed: 42,
      scenarios: [
        {
          name: "browse",
          weight: 8,
          steps: [{ method: "GET", path: "/products/{{rand 1 20}}", expect: { status: 200 } }],
        },
        {
          name: "reviews",
          weight: 2,
          steps: [{ method: "GET", path: "/products?include=reviews", expect: { status: 200 } }],
        },
      ],
      // deliberately tight: the N+1 reviews route (~21 sequential queries) must breach it
      thresholds: { "http.p99": "< 1ms" },
    },
    architecture: { include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] },
    bugs: { contract: path.join(PROJECT, "openapi.yaml") },
    reliability: {
      dependencies: { payments: { injector: "builtin", upstream: shopA.payments.url, listen: proxyPort } },
      workload: {
        rate: 5,
        routes: [
          {
            name: "orders",
            method: "POST",
            path: "/orders",
            // the reliability workload has no auth-role reference, so the user's config holds a literal header
            headers: { "content-type": "application/json", authorization: "Bearer alice-token" },
            body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
            dependsOn: ["payments"],
          },
        ],
      },
    },
    report: { formats: ["json", "md", "junit", "sarif", "html"], outDir: "reports" },
  };
  writeFileSync(tmp.join("sw.config.json"), JSON.stringify(config, null, 2));
}, 60_000);

afterAll(async () => {
  await shopB?.close();
  await shopA?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

describe("full investigation on shop-express (CLI)", () => {
  it("sw inspect: static findings for the seeded architecture defects (suspected-risk)", async () => {
    const res = await engineRun("inspect", ["inspect", "--cache-dir", tmp.join("arch-cache")], [0, 1]);
    expect(res.engine).toBe("architecture");
    expect(res.findings.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(res.findings);
    expect(text).toMatch(/inventory/); // module-cycle inventory.ts <-> orders.ts
    expect(text).toMatch(/payments-client/); // outbound call without timeout
  }, 90_000);

  it("sw perf: measures and reports the threshold breach (observation / threshold-breach)", async () => {
    const res = await engineRun("perf", ["perf"], [1]);
    expect(res.engine).toBe("performance");
    expect(res.status).toBe("failed");
    expect(res.data.totals.requests).toBeGreaterThan(30);
    expect(res.findings.some((f: any) => f.classification === "threshold-breach")).toBe(true);
  }, 90_000);

  it("sw bugs: reproduces the seeded API defects (reproduced-defect)", async () => {
    const res = await engineRun(
      "bugs",
      [
        "--yes",
        "bugs",
        "--allow-mutations",
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
      ],
      [1],
      150_000,
    );
    expect(res.engine).toBe("bugs");
    const rules = new Set(res.findings.map((f: any) => f.ruleId));
    for (const r of [
      "bugs/bola",
      "bugs/schema-mismatch",
      "bugs/server-error-on-boundary",
      "bugs/race-lost-update",
    ]) {
      expect(rules, `missing ${r}; got ${[...rules].join(", ")}`).toContain(r);
    }
    expect(res.findings.some((f: any) => f.classification === "reproduced-defect")).toBe(true);
  }, 160_000);

  it("sw reliability run dependency-5xx: retry storm found; proxy closed, nothing left to clean up", async () => {
    const res = await engineRun(
      "reliability",
      [
        "--approve-disruptive",
        "--seed",
        "5",
        "reliability",
        "run",
        "dependency-5xx",
        "--target",
        "api-rel",
        "--dependency",
        "payments",
        "--steady-phase",
        "2s",
        "--duration",
        "2s",
        "--recovery",
        "3s",
      ],
      [0, 1],
    );
    expect(res.engine).toBe("reliability");
    expect(res.findings.map((f: any) => f.ruleId)).toContain("reliability/retry-without-backoff");
    expect(await portRefuses(proxyPort)).toBe(true);
    const clean = await sw(["reliability", "cleanup", "--json"]);
    expect(clean.exitCode, clean.stderr).toBe(0);
    const c = parseJson(clean.stdout, "cleanup");
    expect(c.errors ?? []).toEqual([]);
  }, 90_000);

  it("sw model build: one graph from code + contract, no findings", async () => {
    const r = await sw(["model", "build", "--cache-dir", tmp.join("arch-cache"), "--json"]);
    expect(r.exitCode, r.stderr.slice(-3000)).toBe(0);
    const model = parseJson(r.stdout, "sw model build");
    expect(model.nodes.length).toBeGreaterThan(3);
    expect(JSON.stringify(model.nodes)).toMatch(/POST \/orders/);
    expect(existsSync(tmp.join(".second-world", "model", "latest.json"))).toBe(true);
  }, 90_000);

  it("sw analyze: deterministic summary over all reports, no secret", async () => {
    const reports = ["inspect", "perf", "bugs", "reliability"].map((n) => `reports/${n}/report.json`);
    for (const p of reports) expect(existsSync(tmp.join(p)), p).toBe(true);
    const r = await sw(["analyze", ...reports, "--json"]);
    expect(r.exitCode, r.stderr.slice(-3000)).toBe(0);
    const summary = parseJson(r.stdout, "analyze");
    expect(summary.counts.runs).toBe(4);
    expect(summary.counts.findings).toBeGreaterThan(0);
    for (const s of Object.values(TOKENS)) {
      expect(r.stdout.includes(s), `analyze output leaks ${s}`).toBe(false);
    }
  }, 90_000);

  it("combined report in every format; every finding on its engine's trust-ladder rung", async () => {
    const all = ["inspect", "perf", "bugs", "reliability"].map((n) => results[n]).filter(Boolean);
    expect(all.length).toBe(4);
    expectTrustLadder(all);
    const combined = combineResults(all);
    expect(new Set(combined.results.map((r: any) => r.engine))).toEqual(
      new Set(["architecture", "performance", "bugs", "reliability"]),
    );
    const { files } = await writeReports(all, {
      formats: ["json", "md", "junit", "sarif", "html"],
      outDir: tmp.join("reports", "combined"),
      failOn: "high",
    });
    expect(files.map((f) => f.format).sort()).toEqual(["html", "json", "junit", "md", "sarif"]);
    const json = JSON.parse(readFileSync(tmp.join("reports", "combined", "report.json"), "utf8"));
    expect(json.results).toHaveLength(4);
    const md = readFileSync(tmp.join("reports", "combined", "report.md"), "utf8");
    for (const e of ["architecture", "performance", "bugs", "reliability"])
      expect(md.toLowerCase()).toContain(e);
    const sarif = JSON.parse(readFileSync(tmp.join("reports", "combined", "report.sarif"), "utf8"));
    expect(sarif.runs.flatMap((r: any) => r.results).length).toBeGreaterThan(5);
  }, 60_000);

  it("history holds every measured run and verifies", async () => {
    const list = await sw(["history", "list", "--json"]);
    expect(list.exitCode, list.stderr).toBe(0);
    const entries = parseJson(list.stdout, "history list") as Array<{ engines: string[]; label?: string }>;
    const engines = new Set(entries.flatMap((e) => e.engines));
    for (const e of ["architecture", "performance", "bugs", "reliability"]) expect(engines, e).toContain(e);
    const v = await sw(["history", "verify", "--json"]);
    expect(v.exitCode, v.stdout + v.stderr).toBe(0);
  }, 60_000);

  it("no credential in any written file; nothing written into examples/", async () => {
    const secrets = [...Object.values(TOKENS), "alice-pass", "bob-pass", "admin-pass"];
    // sw.config.json is the user's own input (literal workload header); everything SECOND WORLD wrote is checked
    const hits = findSecrets(tmp.path, secrets, { exclude: (f) => path.basename(f) === "sw.config.json" });
    // the scan must actually cover what was written: per-engine reports, combined report, history, model, audit
    const written = walkFiles(tmp.path).map((f) => path.relative(tmp.path, f).split(path.sep).join("/"));
    for (const re of [
      /^reports\/bugs\/report\.(json|md|html|sarif|junit\.xml)$/,
      /^reports\/combined\/report\.html$/,
      /^\.second-world\/history\//,
      /^\.second-world\/model\/latest\.json$/,
      /^\.second-world\/audit\.log$/,
    ]) {
      expect(
        written.some((w) => re.test(w)),
        `${re} not among ${written.length} written files`,
      ).toBe(true);
    }
    expect(hits, hits.join("\n")).toEqual([]);
    // SECOND WORLD output would be new files/dirs; existing files may be edited concurrently by developers
    const added = Object.keys(snapshotTree(EXAMPLES_DIR)).filter((k) => !(k in examplesBefore));
    expect(added, `written into examples/: ${added.join(", ")}`).toEqual([]);
  });
});
