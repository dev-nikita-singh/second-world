/**
 * `sw reliability run dependency-latency` end to end (owner: sw-core):
 * shop-express → built-in fault proxy (started by the engine on a fixed port) → payments-fake.
 * The CLI runs as a subprocess with --approve-disruptive; the test asserts the fault was applied
 * and reverted (proxy port closed afterwards) and that the run was saved to history.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { runCli } from "../../helpers/cli.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function refuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.on("connect", () => {
      c.destroy();
      resolve(false);
    });
    c.on("error", () => resolve(true));
  });
}

describe("sw reliability run (subprocess, built-in proxy)", () => {
  let payments: PaymentsFake;
  let app: { url: string; close(): Promise<void> };
  let proxyPort: number;
  let dir: string;
  const env = {
    SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config"),
    SW_FAULT_LEDGER: join(mkdtempSync(join(tmpdir(), "sw-ledger-")), "ledger.json"),
    // F10: the route uses auth role "user" whose token comes from this env var (never a literal header)
    SW_TEST_USER_TOKEN: "alice-token",
  };

  beforeAll(async () => {
    payments = await startPaymentsFake();
    proxyPort = await freePort();
    const m = await import("../../../examples/shop-express/src/server.js");
    app = await m.start(0, { paymentsUrl: `http://127.0.0.1:${proxyPort}`, queryDelayMs: 1 });
    dir = mkdtempSync(join(tmpdir(), "sw-rel-int-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: app.url } },
        auth: { user: { type: "bearer", token: { env: "SW_TEST_USER_TOKEN" } } },
        reliability: {
          dependencies: { payments: { injector: "builtin", upstream: payments.url, listen: proxyPort } },
          workload: {
            rate: 5,
            routes: [
              {
                name: "orders",
                method: "POST",
                path: "/orders",
                auth: "user",
                body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
                dependsOn: ["payments"],
              },
            ],
          },
        },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await payments?.close();
  });

  it("dependency-latency with --approve-disruptive: fault applied + reverted, report + history", async () => {
    const r = await runCli(
      [
        "--approve-disruptive",
        "--seed",
        "7",
        "-f",
        "json,md,html",
        "reliability",
        "run",
        "dependency-latency",
        "--dependency",
        "payments",
        "--param",
        "latencyMs=300",
        "--steady-phase",
        "2s",
        "--duration",
        "3s",
        "--recovery",
        "2s",
        "--hypothesis",
        "p95<5s",
        "--json",
      ],
      { cwd: dir, env, timeoutMs: 40_000 },
    );
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    const rep = JSON.parse(r.stdout);
    const res = rep.results[0];
    expect(res.engine).toBe("reliability");
    expect(["passed", "failed"]).toContain(res.status);
    expect(res.data.scenario).toBe("dependency-latency");
    expect(res.data.injector).toBeDefined();
    // F10: the role resolved (no limitation) and requests were authenticated (shop returns 401 otherwise)
    expect(res.limitations.map((l: { code: string }) => l.code)).not.toContain("RELIABILITY_AUTH_UNRESOLVED");
    expect(res.data.runs[0].steady.requests).toBeGreaterThan(0);
    expect(res.data.runs[0].steady.errorRate).toBeLessThan(0.5);
    // the token never appears in stdout or any written report
    expect(r.stdout).not.toContain("alice-token");
    const repDir = join(dir, ".second-world", "reports");
    for (const f of readdirSync(repDir))
      expect(readFileSync(join(repDir, f), "utf8"), f).not.toContain("alice-token");
    // the engine closed its proxy: nothing is left listening on the dependency port
    expect(await refuses(proxyPort)).toBe(true);
    const list = await runCli(["history", "list", "--json"], { cwd: dir, env });
    expect(JSON.parse(list.stdout)[0]).toMatchObject({ label: "reliability" });
    const clean = await runCli(["reliability", "cleanup", "--json"], { cwd: dir, env });
    expect(clean.exitCode).toBe(0);
  }, 45_000);
});
