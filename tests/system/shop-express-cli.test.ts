/**
 * shop-express end to end with its SHIPPED config (owner: sw-qa, wave 5): the docs/quickstart.md workflow.
 * The user copies the example, points the config at the running app and runs every engine from a
 * SUBFOLDER (config discovered by walking up), in a path with spaces.
 * docs/08-configuration.md §1 "Relative paths", docs/09-cli-and-api.md §1 (exit codes),
 * docs/11-safety-security-privacy.md (no secrets in artifacts), README "Reports".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { encodeTraceRequest } from "../unit/model/otlp-pb-encoder.js";
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
  walkFiles,
} from "./helpers.js";

let tmp: TmpDir;
let userCfg: TmpDir;
let shopA: RunningExample;
let shopB: { url: string; close(): Promise<void> };
let proxyPort: number;
let project: string;
let sub: string;
let examplesBefore: Record<string, string>;
const outputs: string[] = [];
const runIds: Record<string, string> = {};

/** Every command runs from <project>/src/routes: the config is found by walking up. */
async function sw(args: string[], timeoutMs = 90_000) {
  const r = await runCli(args, {
    cwd: sub,
    env: { SW_USER_CONFIG_DIR: userCfg.path, SW_FAULT_LEDGER: path.join(tmp.path, "ledger.json") },
    timeoutMs,
  });
  outputs.push(r.stdout, r.stderr);
  return r;
}

beforeAll(async () => {
  examplesBefore = snapshotTree(EXAMPLES_DIR);
  tmp = await makeTmpDir("sw-sys-express-");
  userCfg = await makeTmpDir("sw-sys-express-ucfg-");
  shopA = await startExample("shop-express");
  proxyPort = await freePort();
  const m = await import("../../examples/shop-express/src/server.js");
  shopB = await m.start(0, { paymentsUrl: `http://127.0.0.1:${proxyPort}`, queryDelayMs: 1 });
  project = path.join(tmp.path, "my shop");
  copyExample(
    "shop-express",
    project,
    { "http://127.0.0.1:3000": shopA.url, "http://127.0.0.1:4010": shopA.payments.url },
    proxyPort,
  );
  mkdirSync(path.join(project, ".git")); // a project root, like a real checkout
  sub = path.join(project, "src", "routes");
}, 60_000);

afterAll(async () => {
  await shopB?.close();
  await shopA?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

describe("shop-express: shipped sw.config.ts, run from a subfolder", () => {
  it("config validate finds the config by walking up; print masks the tokens", async () => {
    const v = await sw(["config", "validate"]);
    expect(v.exitCode, v.stderr).toBe(0);
    expect(v.stdout).toContain(path.join(project, "sw.config.ts"));
    const p = await sw(["config", "print"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toMatch(/redacted/);
  });

  it("perf writes every report format; reports land under the config folder's .second-world", async () => {
    const out = path.join(tmp.path, "perf reports");
    const r = await sw(["perf", "--duration", "2s", "-f", "tty,json,md,junit,sarif,html", "-o", out]);
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    for (const f of ["report.json", "report.md", "report.junit.xml", "report.sarif", "report.html"])
      expect(existsSync(path.join(out, f)), f).toBe(true);
    const rep = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    expect(rep.results[0].data.totals.requests).toBeGreaterThan(0);
    runIds.perf = rep.runId;
    expect(existsSync(path.join(project, ".second-world", "history"))).toBe(true);
    expect(existsSync(path.join(sub, ".second-world"))).toBe(false);
  });

  it("bugs with the shipped concurrency config reproduces stock-race, BOLA and idempotency", async () => {
    const r = await sw(["--yes", "bugs", "--json"], 120_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const rep = parseJson(r.stdout);
    runIds.bugs = rep.runId;
    const res = rep.results[0];
    expectTrustLadder([res]);
    const reproduced = new Set(
      res.findings.filter((f: any) => f.classification === "reproduced-defect").map((f: any) => f.ruleId),
    );
    for (const rule of [
      "bugs/race-lost-update",
      "bugs/bola",
      "bugs/idempotency-key-ignored",
      "bugs/schema-mismatch",
    ])
      expect([...reproduced], rule).toContain(rule);
    const race = res.findings.find((f: any) => f.ruleId === "bugs/race-lost-update");
    const replay = await sw(["replay", race.fingerprint]);
    expect(replay.exitCode, replay.stderr.slice(-1000)).toBe(1); // still reproduces
  }, 180_000);

  it("reliability run with the shipped workload + invariants; the fault proxy is gone afterwards", async () => {
    const list = await sw(["reliability", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("dependency-latency");
    const blocked = await sw(["reliability", "run", "dependency-latency", "--target", shopB.url]);
    expect(blocked.exitCode).toBe(3); // needs --approve-disruptive
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
      120_000,
    );
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    const res = parseJson(r.stdout).results[0];
    expectTrustLadder([res]);
    expect(JSON.stringify(res.data)).toContain("orders-per-operation");
    expect(await portRefuses(proxyPort)).toBe(true);
    const c = await sw(["reliability", "cleanup"]);
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toMatch(/0 in-process, 0 from ledger, 0 error/);
  }, 180_000);

  it("model build from code + contract + OTLP protobuf traces (CLI path relative to the shell cwd)", async () => {
    const traces = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "model", "shop-traces.json"), "utf8"),
    );
    writeFileSync(path.join(sub, "traces.pb"), encodeTraceRequest(traces));
    const r = await sw(["model", "build", "--traces", "traces.pb"]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toMatch(/runtime traces ✓/);
    expect(r.stdout).not.toMatch(/MODEL_NO_TRACES/);
    const show = await sw(["model", "show", "--graph", "mermaid"]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toMatch(/graph|flowchart/);
  });

  it("analyze --last and history: list, show by report runId, verify", async () => {
    const a = await sw(["analyze", "--last", "--json"]);
    expect(a.exitCode, a.stderr).toBe(0);
    expect(parseJson(a.stdout).counts.runs).toBe(1);
    const list = await sw(["history", "list"]);
    expect(list.exitCode).toBe(0);
    for (const label of ["perf", "bugs", "reliability", "model"]) expect(list.stdout).toContain(label);
    const show = await sw(["history", "show", runIds.bugs as string]);
    expect(show.exitCode, show.stderr).toBe(0);
    const verify = await sw(["history", "verify"]);
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/history intact/);
  });

  it("no demo token in any output or written file (except the user's own config); examples/ untouched", () => {
    for (const t of DEMO_TOKENS) expect(outputs.join("\n").includes(t), `${t} in CLI output`).toBe(false);
    const hits = findSecrets(project, [...DEMO_TOKENS], {
      exclude: (f) =>
        f.endsWith("sw.config.ts") ||
        f.includes(`${path.sep}src${path.sep}`) ||
        (/README\.md$|\.json$/.test(f) && !f.includes(".second-world")),
    });
    expect(hits).toEqual([]);
    expect(findSecrets(path.join(tmp.path, "perf reports"), [...DEMO_TOKENS])).toEqual([]);
    const after = snapshotTree(EXAMPLES_DIR);
    const added = Object.keys(after).filter((k) => !(k in examplesBefore));
    expect(added).toEqual([]);
    expect(walkFiles(EXAMPLES_DIR).some((f) => f.includes(".second-world"))).toBe(false);
  });
});
