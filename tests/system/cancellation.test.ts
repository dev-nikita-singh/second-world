/**
 * System test: cancellation mid-workflow through the public API (docs/09-cli-and-api.md §1
 * "Ctrl+C = graceful stop and partial report", docs/03-engines/reliability-lab.md cleanup).
 * A long perf run and a long fault experiment run in parallel; the caller aborts after ~3 s.
 * Expect: both engines return promptly with status "cancelled" (perf with partial data), the
 * downstream step is skipped, the fault proxy port is closed, `cleanupAll` has nothing to revert,
 * the ledger is empty and the shop works normally again.
 * (A CLI SIGINT variant exists in tests/e2e; Windows cannot deliver SIGINT to a child.)
 * Owner: sw-qa.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../examples/payments-fake/src/server.js";
import { cleanupAll } from "../../src/engines/reliability/index.js";
import { createWorld, type World } from "../../src/index.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { freePort, portRefuses } from "./helpers.js";

let tmp: TmpDir;
let payments: PaymentsFake;
let shop: { url: string; close(): Promise<void> };
let proxyPort: number;
let world: World;
let ledgerPath: string;
const prevLedger = process.env.SW_FAULT_LEDGER;

beforeAll(async () => {
  tmp = await makeTmpDir("sw-sys-cancel-");
  ledgerPath = tmp.join("fault-ledger.json");
  process.env.SW_FAULT_LEDGER = ledgerPath;
  payments = await startPaymentsFake();
  proxyPort = await freePort();
  const m = await import("../../examples/shop-express/src/server.js");
  shop = await m.start(0, { paymentsUrl: `http://127.0.0.1:${proxyPort}`, queryDelayMs: 1 });
  world = await createWorld({
    cwd: tmp.path,
    probe: false,
    auditFile: false,
    userConfig: false,
    approve: true,
    config: {
      targets: { api: { url: shop.url } },
      safety: { allowHosts: ["127.0.0.1"] },
      reliability: {
        dependencies: { payments: { injector: "builtin", upstream: payments.url, listen: proxyPort } },
        workload: {
          rate: 5,
          routes: [
            {
              name: "orders",
              method: "POST",
              path: "/orders",
              headers: { "content-type": "application/json", authorization: "Bearer alice-token" },
              body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
              dependsOn: ["payments"],
            },
          ],
        },
      },
      workflows: {
        long: {
          steps: {
            perf: {
              engine: "performance",
              input: {
                model: "open",
                rate: 20,
                duration: "60s",
                warmup: 0,
                scenarios: [{ name: "get", steps: [{ method: "GET", path: "/products/1" }] }],
              },
            },
            fault: {
              engine: "reliability",
              input: {
                scenario: "dependency-latency",
                dependency: "payments",
                params: { latencyMs: 200 },
                steady: "1s",
                duration: "60s",
                recovery: "1s",
              },
            },
            report: {
              engine: "performance",
              after: ["perf"],
              input: {
                model: "iterations",
                iterations: 1,
                vus: 1,
                scenarios: [{ name: "x", steps: [{ method: "GET", path: "/healthz" }] }],
              },
            },
          },
        },
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await world?.close();
  await shop?.close();
  await payments?.close();
  await tmp?.cleanup();
  if (prevLedger === undefined) delete process.env.SW_FAULT_LEDGER;
  else process.env.SW_FAULT_LEDGER = prevLedger;
});

describe("cancellation mid-workflow", () => {
  it("abort → partial results, skipped dependants, no leftover port / fault / ledger entry", async () => {
    const ac = new AbortController();
    let faultApplied = false;
    world.on("reliability.fault", (p) => {
      if ((p as { phase?: string }).phase === "applied") faultApplied = true;
    });
    const t0 = performance.now();
    const timer = setTimeout(() => ac.abort(new Error("user cancelled")), 3_000);
    const r = await world.run("long", { signal: ac.signal });
    clearTimeout(timer);
    const elapsed = performance.now() - t0;

    expect(elapsed, "engines must stop promptly after abort").toBeLessThan(15_000);
    expect(faultApplied, "the fault was active when the abort came").toBe(true);

    const perf = r.steps.perf as { status: string; result?: any };
    expect(perf.status).toBe("failed"); // orchestrator: a cancelled result is not "ok"
    expect(perf.result?.status).toBe("cancelled");
    expect(perf.result?.data?.totals?.requests ?? 0).toBeGreaterThan(10); // partial measurement kept

    const fault = r.steps.fault as { status: string; result?: any; error?: unknown };
    expect(fault.status).toBe("failed");
    expect(fault.result?.status, String(fault.error)).toBe("cancelled");

    expect(r.steps.report?.status).toBe("skipped");
    expect(r.ok).toBe(false);

    // nothing left behind
    expect(await portRefuses(proxyPort)).toBe(true);
    const c = await cleanupAll({ ledgerPath });
    expect(c).toEqual({ inProcess: 0, ledger: 0, errors: [] });
    if (existsSync(ledgerPath)) {
      const raw = readFileSync(ledgerPath, "utf8").trim();
      expect(raw === "" || raw === "[]" || JSON.parse(raw).entries?.length === 0, raw).toBe(true);
    }
    // the shop's payments path is simply down (no proxy) — not stuck behind an injected fault
    const res = await fetch(`${shop.url}/products/1`);
    expect(res.status).toBe(200);
  }, 60_000);
});
