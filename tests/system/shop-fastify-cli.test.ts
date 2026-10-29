/**
 * shop-fastify end to end with its SHIPPED config (owner: sw-qa, wave 5): bug hunt precision/recall from the
 * config alone, reliability with duplicate-operation invariants, and a What-If A/B (seeded vs FIXED=1) whose
 * experiment file path is typed relative to the shell cwd. Runs with `--config` pointing at the copy from
 * another folder. docs/08-configuration.md §1 "Relative paths", docs/03-engines/experiments.md Part A,
 * docs/03-engines/reliability-lab.md "Duplicate-operation invariants".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import {
  copyExample,
  DEMO_TOKENS,
  EXAMPLES_DIR,
  expectTrustLadder,
  findSecrets,
  freePort,
  parseJson,
  portRefuses,
  REPO_ROOT,
  snapshotTree,
} from "./helpers.js";

let tmp: TmpDir;
let userCfg: TmpDir;
let shopA: RunningExample;
let shopB: { url: string; close(): Promise<void> };
let proxyPort: number;
let project: string;
let elsewhere: string;
let cfgPath: string;
let examplesBefore: Record<string, string>;
const outputs: string[] = [];

/** Runs from an unrelated folder with `--config <copy>/sw.config.ts`. */
async function sw(args: string[], timeoutMs = 120_000) {
  const r = await runCli(["--config", cfgPath, ...args], {
    cwd: elsewhere,
    env: { SW_USER_CONFIG_DIR: userCfg.path, SW_FAULT_LEDGER: path.join(tmp.path, "ledger.json") },
    timeoutMs,
  });
  outputs.push(r.stdout, r.stderr);
  return r;
}

beforeAll(async () => {
  examplesBefore = snapshotTree(EXAMPLES_DIR);
  tmp = await makeTmpDir("sw-sys-fastify-");
  userCfg = await makeTmpDir("sw-sys-fastify-ucfg-");
  shopA = await startExample("shop-fastify");
  proxyPort = await freePort();
  const m = await import("../../examples/shop-fastify/src/server.js");
  shopB = await m.start(0, { paymentsUrl: `http://127.0.0.1:${proxyPort}`, queryDelayMs: 1 });
  project = path.join(tmp.path, "fastify copy");
  cfgPath = copyExample(
    "shop-fastify",
    project,
    { "http://127.0.0.1:3001": shopA.url, "http://127.0.0.1:4010": shopA.payments.url },
    proxyPort,
  );
  elsewhere = path.join(tmp.path, "work dir");
  mkdirSync(elsewhere);
}, 60_000);

afterAll(async () => {
  await shopB?.close();
  await shopA?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

describe("shop-fastify: shipped sw.config.ts via --config from another folder", () => {
  it("bugs: the planted API defects are reproduced; the atomic stock is not reported (precision)", async () => {
    const r = await sw(["--yes", "bugs", "--json"]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const res = parseJson(r.stdout).results[0];
    expectTrustLadder([res]);
    const reproduced = res.findings.filter((f: any) => f.classification === "reproduced-defect");
    const rules = new Set(reproduced.map((f: any) => f.ruleId));
    for (const rule of [
      "bugs/bfla",
      "bugs/server-error-on-boundary",
      "bugs/schema-mismatch",
      "bugs/race-lost-update",
    ])
      expect([...rules], rule).toContain(rule);
    const races = reproduced
      .filter((f: any) => f.ruleId === "bugs/race-lost-update")
      .map((f: any) => f.title as string);
    expect(races.some((t: string) => /Idempotency-Key/i.test(t))).toBe(true);
    expect(races.some((t: string) => /last item/i.test(t))).toBe(false); // stock decrement is atomic here
    expect(res.findings.some((f: any) => f.ruleId === "bugs/bola")).toBe(false); // ownership is checked
    // contract path inside the config is relative to the config's folder, not the shell cwd
    expect(r.stderr).not.toMatch(/openapi\.yaml.*(not found|ENOENT)/);
  }, 180_000);

  it("reliability: shipped workload + invariants through the fault proxy; nothing left behind", async () => {
    const r = await sw(
      [
        "--approve-disruptive",
        "reliability",
        "run",
        "dependency-latency",
        "--target",
        shopB.url,
        "--repeat",
        "1",
        "--json",
      ],
      150_000,
    );
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    const res = parseJson(r.stdout).results[0];
    expectTrustLadder([res]);
    const data = JSON.stringify(res.data);
    expect(data).toContain("one-order-per-key");
    expect(data).toContain("orders-per-operation");
    expect(await portRefuses(proxyPort)).toBe(true);
    const c = await sw(["reliability", "cleanup"]);
    expect(c.stdout).toMatch(/0 in-process, 0 from ledger, 0 error/);
  }, 180_000);

  it("whatif <file typed relative to the shell cwd>: FIXED=1 search improves p95", async () => {
    const loader = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const server = path.join(REPO_ROOT, "examples", "shop-fastify", "src", "server.ts");
    mkdirSync(path.join(elsewhere, "exp"));
    writeFileSync(
      path.join(elsewhere, "exp", "search fix.json"),
      JSON.stringify({
        name: "search-fix",
        hypothesis: "Indexed search lowers p95 by >= 15%",
        baseline: {
          start: [process.execPath, "--import", loader, server],
          cwd: tmp.path,
          env: { FIXED: "0", PAYMENTS_URL: shopA.payments.url },
          readyWhen: { path: "/healthz", timeout: "20s", interval: 100 },
        },
        variants: [
          {
            name: "fixed",
            env: { FIXED: "1" },
            readyWhen: { path: "/healthz", bodyContains: '"fixed"', timeout: "20s", interval: 100 },
          },
        ],
        workload: {
          vus: 4,
          duration: "1200ms",
          warmup: "300ms",
          scenarios: [{ name: "s", steps: [{ path: "/products/search", query: { q: "red" } }] }],
        },
        metrics: ["p95", "error_rate"],
        success: { p95: { improvement: ">= 15%" }, error_rate: { notWorse: true } },
        design: { repetitions: 5, order: "interleaved", seed: 7 },
      }),
    );
    const r = await sw(["whatif", path.join("exp", "search fix.json"), "--json"], 150_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const d = parseJson(r.stdout).results[0].data;
    const p95 = d.comparisons.find((c: any) => c.metric === "p95");
    expect(p95.verdict).toBe("improved");
    expect(d.verdicts[0].hypothesis).toBe("supported");
  }, 180_000);

  it("history lives in the config's folder; no token leaks; examples/ untouched", async () => {
    const list = await sw(["history", "list"]);
    expect(list.exitCode).toBe(0);
    for (const label of ["bugs", "reliability", "whatif"]) expect(list.stdout).toContain(label);
    expect(Object.keys(snapshotTree(elsewhere)).some((k) => k.startsWith(".second-world"))).toBe(false);
    for (const t of DEMO_TOKENS) expect(outputs.join("\n").includes(t), `${t} in CLI output`).toBe(false);
    expect(findSecrets(path.join(project, ".second-world"), [...DEMO_TOKENS])).toEqual([]);
    const added = Object.keys(snapshotTree(EXAMPLES_DIR)).filter((k) => !(k in examplesBefore));
    expect(added).toEqual([]);
  });
});
