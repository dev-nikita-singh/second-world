/**
 * orders-jobs-api system test (owner: sw-real2-w8, wave 8): orders + background payment job queue +
 * outbound payment provider + webhooks with idempotency keys + a read cache, with five seeded
 * defects (examples/orders-jobs-api/expected-findings.json). The provider fake and the app run
 * in-process on 127.0.0.1:0; the user's project is a copy of the example in a temp path with a
 * space, its sw.config.ts pointed at the running stack. Every engine is scored with that config:
 * each detectable defect must be found by its command (recall 1.0) and every other finding must be
 * a documented observation (precision 1.0).
 *
 * The packed-tarball user journey is the last describe block: it needs the npm registry for
 * dependencies and takes minutes, so it only runs with SW_SYSTEM_PACK=1 (see the example README).
 * docs/12-testing-and-quality.md §3, docs/09-cli-and-api.md §1 (exit codes).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import {
  EXAMPLES_DIR,
  expectTrustLadder,
  freePort,
  portRefuses,
  REPO_ROOT,
  snapshotTree,
} from "./helpers.js";
import {
  copyOrders,
  describeScore,
  engineResult,
  ORDERS_DIR,
  ORDERS_TOKENS,
  type OrdersStack,
  ordersTruth,
  score,
  startOrdersStack,
} from "./orders-jobs/helpers.js";

const log = (s: string) => process.stderr.write(`${s}\n`);

describe("orders-jobs-api: ground truth", () => {
  it("every defect is detectable from sw.config.ts and has a marker in the code", () => {
    const truth = ordersTruth();
    expect(truth.defects.map((d) => d.id).sort()).toEqual([
      "refresh-no-timeout",
      "retry-storm-no-jitter",
      "stale-cache-after-update",
      "unbounded-queue",
      "webhook-replay-not-idempotent",
    ]);
    for (const d of truth.defects) {
      expect(d.detectableFromConfig, d.id).toBe(true);
      expect(d.detectedBy?.length, d.id).toBeGreaterThan(0);
      const src = readFileSync(path.join(ORDERS_DIR, d.location.file), "utf8").split("\n");
      expect(src[d.location.line - 2], d.id).toContain(`SEEDED-DEFECT:${d.id}`);
    }
  });

  it("the defects reproduce by hand (HTTP), so the expectations describe real behaviour", async () => {
    const stack = await startOrdersStack({ latencyMs: 20 });
    try {
      const A = { authorization: "Bearer alice-token", "content-type": "application/json" };
      const get = async (p: string) => (await fetch(`${stack.url}${p}`, { headers: A })).json();
      // stale cache: read → update → read
      expect(((await get("/orders/1")) as { note: string }).note).toBe("leave at the door");
      const put = await fetch(`${stack.url}/orders/1`, {
        method: "PUT",
        headers: A,
        body: JSON.stringify({ shippingAddress: "1 Main St", note: "new" }),
      });
      expect(((await put.json()) as { note: string }).note).toBe("new");
      expect(((await get("/orders/1")) as { note: string }).note).toBe("leave at the door");
      // webhook replay: same key twice → two records, payment counted twice
      const wh = {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "evt_manual" },
        body: JSON.stringify({
          type: "charge.succeeded",
          data: { orderId: 1, chargeId: "ch_seed_1", amount: 2500 },
        }),
      };
      const r1 = (await (await fetch(`${stack.url}/webhooks/payments`, wh)).json()) as { id: number };
      const r2 = (await (await fetch(`${stack.url}/webhooks/payments`, wh)).json()) as { id: number };
      expect(r2.id).not.toBe(r1.id);
      expect(((await get("/orders/1/payment")) as { amountPaid: number }).amountPaid).toBe(7500);
      // the happy path still works: order → job → charge → webhook → paid
      const o = (await (
        await fetch(`${stack.url}/orders`, {
          method: "POST",
          headers: A,
          body: JSON.stringify({ sku: "TEA-001", quantity: 2, shippingAddress: "x" }),
        })
      ).json()) as { id: number; paymentJobId: number };
      expect(((await get(`/jobs/${o.paymentJobId}?wait=5000`)) as { status: string }).status).toBe(
        "succeeded",
      );
      let paid = "";
      for (let i = 0; i < 50 && paid !== "paid"; i++) {
        paid = ((await get(`/orders/${o.id}/payment`)) as { status: string }).status;
        if (paid !== "paid") await new Promise((r) => setTimeout(r, 20));
      }
      expect(paid).toBe("paid");
    } finally {
      await stack.close();
    }
  }, 60_000);
});

describe("orders-jobs-api: sw from source with the example's sw.config.ts", () => {
  let tmp: TmpDir;
  let userCfg: TmpDir;
  let direct: OrdersStack;
  let viaProxy: OrdersStack;
  let project: string;
  let relProject: string;
  let proxyPort: number;
  let examplesBefore: Record<string, string>;
  const outputs: string[] = [];
  const table: string[] = [];

  async function sw(args: string[], cwd: string, timeoutMs = 240_000) {
    const r = await runCli(args, {
      cwd,
      env: { SW_USER_CONFIG_DIR: userCfg.path, SW_FAULT_LEDGER: path.join(tmp.path, "ledger.json") },
      timeoutMs,
    });
    outputs.push(r.stdout, r.stderr);
    return r;
  }
  async function reset(stack: OrdersStack) {
    await fetch(`${stack.url}/__test/reset`, { method: "POST" });
  }
  function scored(command: string, stdout: string, what: string) {
    const rep = engineResult(stdout, what);
    const s = score(command, rep);
    log(describeScore(command, s, rep));
    table.push(
      `${command.padEnd(40)} recall ${s.matched.length}/${s.expected.length}  precision ${s.precision.toFixed(2)}`,
    );
    return { rep, s };
  }

  beforeAll(async () => {
    examplesBefore = snapshotTree(EXAMPLES_DIR);
    tmp = await makeTmpDir("sw-sys-orders-");
    userCfg = await makeTmpDir("sw-sys-orders-ucfg-");
    proxyPort = await freePort();
    direct = await startOrdersStack();
    viaProxy = await startOrdersStack({ proxyPort });
    project = path.join(tmp.path, "orders project");
    relProject = path.join(tmp.path, "orders project (reliability)");
    copyOrders(project, direct, proxyPort);
    copyOrders(relProject, viaProxy, proxyPort);
  }, 60_000);

  afterAll(async () => {
    if (table.length > 0) log(`[orders-jobs] recall/precision\n${table.join("\n")}`);
    await direct?.close();
    await viaProxy?.close();
    await tmp?.cleanup();
    await userCfg?.cleanup();
  });

  it("config validate", async () => {
    const r = await sw(["config", "validate"], project);
    expect(r.exitCode, r.stderr).toBe(0);
  }, 60_000);

  it("sw inspect sees the node:http route table and finds the missing timeout (ARCH001) and the fixed-delay retry (ARCH002)", async () => {
    const r = await sw(["inspect", "--json"], project);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1); // ARCH001 is high
    const { rep, s } = scored("sw inspect", r.stdout, "inspect");
    expectTrustLadder([rep]);
    expect(s.matched.sort()).toEqual(["refresh-no-timeout", "retry-storm-no-jitter"]);
    expect(s.falsePositives).toEqual([]);
    const routes = (rep.data as { routes: { method: string; path: string }[] }).routes.map(
      (x) => `${x.method} ${x.path}`,
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        "POST /orders",
        "GET /orders/:id",
        "PUT /orders/:id",
        "GET /orders/:id/payment",
        "GET /jobs/:id",
        "POST /webhooks/payments",
      ]),
    );
    expect((rep.limitations ?? []).map((l) => l.code)).not.toContain("ARCH_NO_ROUTES");
  }, 120_000);

  it("sw bugs finds the webhook replay and the stale cached read; no false positives", async () => {
    await reset(direct);
    const r = await sw(["--yes", "bugs", "--json"], project, 300_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const { rep, s } = scored("sw bugs", r.stdout, "bugs");
    expectTrustLadder([rep]);
    expect(s.matched.sort()).toEqual(["stale-cache-after-update", "webhook-replay-not-idempotent"]);
    expect(s.falsePositives).toEqual([]);
  }, 320_000);

  it("sw agent finds the webhook replay and the stale cached read; no false positives", async () => {
    await reset(direct);
    const r = await sw(["agent", "--json"], project, 200_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const { s } = scored("sw agent", r.stdout, "agent");
    expect(s.matched.sort()).toEqual(["stale-cache-after-update", "webhook-replay-not-idempotent"]);
    expect(s.falsePositives).toEqual([]);
  }, 220_000);

  it("sw perf holds its thresholds at the configured load", async () => {
    await reset(direct);
    const r = await sw(["perf", "--duration", "6s", "--json"], project, 120_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const { s } = scored("sw perf", r.stdout, "perf");
    expect(s.falsePositives).toEqual([]);
  }, 150_000);

  it("sw stress: the job-wait SLO breaks once orders outpace the workers (unbounded queue)", async () => {
    await reset(direct);
    const r = await sw(["stress", "--json"], project, 200_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const { rep, s } = scored("sw stress", r.stdout, "stress");
    expectTrustLadder([rep]);
    expect(s.matched).toEqual(["unbounded-queue"]);
    expect(s.falsePositives).toEqual([]);
  }, 220_000);

  it("sw reliability dependency-5xx: retry storm from the payment workers", async () => {
    await reset(viaProxy);
    const r = await sw(
      ["--approve-disruptive", "reliability", "run", "dependency-5xx", "--json"],
      relProject,
      150_000,
    );
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    const { rep, s } = scored("sw reliability run dependency-5xx", r.stdout, "reliability");
    expectTrustLadder([rep]);
    expect(s.matched).toEqual(["retry-storm-no-jitter"]);
    expect(s.falsePositives).toEqual([]);
    expect(await portRefuses(proxyPort)).toBe(true);
  }, 180_000);

  it("sw reliability dependency-timeout: the payment refresh has no outbound timeout", async () => {
    await reset(viaProxy);
    const r = await sw(
      ["--approve-disruptive", "reliability", "run", "dependency-timeout", "--json"],
      relProject,
      150_000,
    );
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    const { rep, s } = scored("sw reliability run dependency-timeout", r.stdout, "reliability");
    expectTrustLadder([rep]);
    expect(s.matched).toEqual(["refresh-no-timeout"]);
    expect(s.falsePositives).toEqual([]);
    expect(await portRefuses(proxyPort)).toBe(true);
  }, 180_000);

  it("no demo token in any output; examples/ untouched", () => {
    for (const t of ORDERS_TOKENS) expect(outputs.join("\n").includes(t), `${t} in CLI output`).toBe(false);
    const after = snapshotTree(EXAMPLES_DIR);
    expect(Object.keys(after).filter((k) => !(k in examplesBefore))).toEqual([]);
  });
});

// ------------------------------------------------------------------ packed tarball journey (opt-in)

/** npm's JS entry, run with this node (no shell, no npm.cmd shim). */
const NPM_CLI = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((p): p is string => typeof p === "string" && /npm-cli.js$/.test(p) && existsSync(p));
const TSDOWN = path.join(REPO_ROOT, "node_modules", "tsdown", "dist", "run.mjs");
const PACK = process.env.SW_SYSTEM_PACK === "1" && NPM_CLI !== undefined && existsSync(TSDOWN);

describe.skipIf(!PACK)("orders-jobs-api: packed tarball user journey (SW_SYSTEM_PACK=1)", () => {
  let tmp: TmpDir;
  let direct: OrdersStack;
  let viaProxy: OrdersStack;
  let proj: string;
  let relProj: string;
  let proxyPort: number;
  const journal: string[] = [];

  const npm = (args: string[], cwd: string) =>
    execFileSync(process.execPath, [NPM_CLI as string, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    }).toString();

  /** `npx sw …` without a shell: the installed bin's JS entry. */
  async function sw(args: string[], cwd = proj, timeout = 300_000) {
    const r = await execa(
      process.execPath,
      [path.join(proj, "node_modules", "second-world", "dist", "cli.mjs"), ...args],
      {
        cwd,
        reject: false,
        timeout,
        env: {
          NO_COLOR: "1",
          CI: "1",
          SW_USER_CONFIG_DIR: path.join(tmp.path, "usercfg"),
          SW_FAULT_LEDGER: path.join(tmp.path, "ledger.json"),
        },
        windowsHide: true,
        stdin: "ignore",
      },
    );
    const exitCode = typeof r.exitCode === "number" ? r.exitCode : -1;
    journal.push(`sw ${args.join(" ")} → exit ${exitCode}`);
    return { exitCode, stdout: String(r.stdout), stderr: String(r.stderr) };
  }

  beforeAll(async () => {
    tmp = await makeTmpDir("sw-sys-orders-pack-");
    mkdirSync(path.join(tmp.path, "usercfg"));
    const stage = path.join(tmp.path, "stage");
    mkdirSync(stage);
    execFileSync(process.execPath, [TSDOWN, "--out-dir", path.join(stage, "dist")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    for (const f of ["package.json", "README.md", "LICENSE"])
      if (existsSync(path.join(REPO_ROOT, f))) cpSync(path.join(REPO_ROOT, f), path.join(stage, f));
    const out = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", tmp.path], stage);
    const tgz = path.join(
      tmp.path,
      (JSON.parse(out.slice(out.indexOf("["))) as { filename: string }[])[0]!.filename,
    );
    // A fresh project outside the repo, in a path with a space; typescript for `sw inspect`.
    proj = path.join(tmp.path, "my orders project");
    mkdirSync(proj);
    npm(["init", "-y"], proj);
    npm(["i", tgz, "typescript@6", "--no-audit", "--no-fund"], proj);
    proxyPort = await freePort();
    direct = await startOrdersStack();
    viaProxy = await startOrdersStack({ proxyPort });
    // The user's code + contract + config next to the installed package (two configs: direct, via proxy).
    copyOrders(path.join(tmp.path, "orders-src"), direct, proxyPort);
    for (const f of ["src", "openapi.yaml", "sw.config.ts"])
      cpSync(path.join(tmp.path, "orders-src", f), path.join(proj, f), { recursive: true });
    relProj = path.join(tmp.path, "orders-rel");
    copyOrders(relProj, viaProxy, proxyPort);
  }, 900_000);

  afterAll(async () => {
    log(`[orders-jobs pack journey]\n${journal.join("\n")}`);
    await direct?.close();
    await viaProxy?.close();
    await tmp?.cleanup();
  });

  it("every engine runs from the tarball; inspect, bugs, stress and reliability keep recall/precision 1.0", async () => {
    const d = await sw(["doctor"]);
    expect(d.exitCode, d.stdout + d.stderr).toBe(0);
    const v = await sw(["config", "validate"]);
    expect(v.exitCode, v.stderr).toBe(0);

    const ins = await sw(["inspect", "--json"]);
    expect(ins.exitCode, ins.stderr.slice(-1500)).toBe(1);
    const si = score("sw inspect", engineResult(ins.stdout, "inspect"));
    expect([si.missed, si.falsePositives]).toEqual([[], []]);

    await fetch(`${direct.url}/__test/reset`, { method: "POST" });
    const bugs = await sw(["--yes", "bugs", "--json"]);
    expect(bugs.exitCode, bugs.stderr.slice(-1500)).toBe(1);
    const sb = score("sw bugs", engineResult(bugs.stdout, "bugs"));
    expect([sb.missed, sb.falsePositives]).toEqual([[], []]);

    await fetch(`${direct.url}/__test/reset`, { method: "POST" });
    const st = await sw(["stress", "--json"]);
    expect(st.exitCode, st.stderr.slice(-1500)).toBe(1);
    const ss = score("sw stress", engineResult(st.stdout, "stress"));
    expect([ss.missed, ss.falsePositives]).toEqual([[], []]);

    // The installed CLI with the reliability copy's config (app → fault proxy → provider).
    const rel = await sw(
      [
        "--config",
        path.join(relProj, "sw.config.ts"),
        "--approve-disruptive",
        "reliability",
        "run",
        "dependency-timeout",
        "--json",
      ],
      relProj,
    );
    expect([0, 1], rel.stderr.slice(-1500)).toContain(rel.exitCode);
    const sr = score("sw reliability run dependency-timeout", engineResult(rel.stdout, "reliability"));
    expect([sr.missed, sr.falsePositives]).toEqual([[], []]);

    await fetch(`${direct.url}/__test/reset`, { method: "POST" });
    const steps: [string[], number[]][] = [
      [["agent"], [1]],
      [["perf", "--duration", "3s"], [0]],
      [["model", "build"], [0]],
      [["analyze", "--last"], [0]],
      [["history", "list"], [0]],
      [["history", "verify"], [0]],
      [["reliability", "cleanup"], [0]],
    ];
    for (const [args, codes] of steps) {
      const r = await sw(args);
      expect(codes, `sw ${args.join(" ")}\n${r.stderr.slice(-1500)}`).toContain(r.exitCode);
    }
    writeFileSync(path.join(tmp.path, "journal.txt"), journal.join("\n"));
  }, 1_200_000);
});
