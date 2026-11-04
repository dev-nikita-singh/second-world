/**
 * Process lifecycle of real `sw` processes (Plan wave 7 §A; docs/09-cli-and-api.md §1 "Ctrl+C = graceful
 * stop and partial report"): a command exits on its own (no leaked handle keeps it alive), Ctrl+C during a
 * run exits 130 with a complete partial report and no temp/lock/pending leftovers.
 * Ctrl+C is emulated in-process (fixtures/sw-entry.ts) because Windows cannot deliver SIGINT to a child;
 * tests/e2e/cli.test.ts covers the OS signal on macOS/Linux.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CalibratedServer, startCalibratedServer } from "../../fixtures/servers/calibrated.js";
import { REPO_ROOT } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { LEFTOVER, startGatedProxy, sw, walk } from "./helpers.js";

let srv: CalibratedServer;
let shop: { url: string; close(): Promise<void> };
let userCfg: TmpDir;
let tmp: TmpDir;

beforeAll(async () => {
  srv = await startCalibratedServer({ precise: false });
  const m = await import("../../../examples/shop-express/src/server.js");
  shop = await m.start(0, { queryDelayMs: 1 });
  userCfg = await makeTmpDir("sw-life-ucfg-");
});
afterAll(async () => {
  await srv?.close();
  await shop?.close();
  await userCfg?.cleanup();
});
beforeEach(async () => {
  tmp = await makeTmpDir("sw-life-");
});
afterEach(async () => {
  await tmp.cleanup();
});

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  SW_USER_CONFIG_DIR: userCfg.path,
  ...extra,
});

function leftovers(): string[] {
  return walk(tmp.path).filter((f) => LEFTOVER.test(f));
}

describe("commands exit on their own", () => {
  it("perf, stress and bugs finish without a forced exit", async () => {
    const CONTRACT = path.join(REPO_ROOT, "examples", "shop-express", "openapi.yaml");
    const cmds: string[][] = [
      [
        "perf",
        `${srv.url}/fixed/1`,
        "--rate",
        "20",
        "--duration",
        "1s",
        "--warmup",
        "0s",
        "-f",
        "json",
        "-o",
        "out",
      ],
      ["stress", `${srv.url}/fixed/1`, "--steps", "2", "--hold", "500ms", "-f", "json", "-o", "out-s"],
      [
        "bugs",
        "--target",
        shop.url,
        "--openapi",
        CONTRACT,
        "--techniques",
        "contract",
        "-f",
        "json",
        "-o",
        "out-b",
      ],
    ];
    for (const args of cmds) {
      const r = await sw(args, { cwd: tmp.path, env: env(), timeoutMs: 120_000 });
      expect(r.mainReturned, `${args[0]}: ${r.stderr.slice(-1500)}`).toBe(true);
      expect(r.timedOut, `${args[0]} kept running after main() returned`).toBe(false);
      expect([0, 1], `${args[0]}: ${r.stderr.slice(-1500)}`).toContain(r.exitCode);
    }
    expect(leftovers()).toEqual([]);
  }, 400_000);
});

describe("Ctrl+C during a run", () => {
  it("perf: exit 130, partial report written completely, no leftovers, process exits by itself", async () => {
    const t0 = Date.now();
    const r = await sw(
      [
        "perf",
        `${srv.url}/fixed/5`,
        "--rate",
        "50",
        "--duration",
        "60s",
        "--warmup",
        "0s",
        "-f",
        "json,md",
        "-o",
        "out",
      ],
      { cwd: tmp.path, env: env({ SW_TEST_SIGINT_AFTER_MS: "2500" }), timeoutMs: 60_000 },
    );
    expect(r.exitCode, r.stderr.slice(-1500)).toBe(130);
    expect(r.mainReturned && !r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
    const rep = JSON.parse(readFileSync(tmp.join("out", "report.json"), "utf8"));
    expect(rep.results[0].status).toBe("cancelled");
    expect(leftovers()).toEqual([]);
  }, 90_000);

  it("stress: exit 130, no leftovers", async () => {
    const r = await sw(
      ["stress", `${srv.url}/fixed/2`, "--steps", "6", "--hold", "5s", "-f", "json", "-o", "out"],
      {
        cwd: tmp.path,
        env: env({ SW_TEST_SIGINT_AFTER_MS: "3000" }),
        timeoutMs: 60_000,
      },
    );
    expect(r.exitCode, r.stderr.slice(-1500)).toBe(130);
    expect(r.mainReturned && !r.timedOut).toBe(true);
    expect(leftovers()).toEqual([]);
  }, 90_000);

  it("bugs: exit 130, artifacts dir not left as pending-*, no leftovers", async () => {
    const CONTRACT = path.join(REPO_ROOT, "examples", "shop-express", "openapi.yaml");
    // A fixed delay raced the run (a fast Linux box finished `bugs` before 2.5 s). Instead, Ctrl+C is
    // sent shortly after the target has seen 15 requests, and every later request is held for 3 s,
    // so the run is guaranteed to be in flight (requests outstanding) when the signal arrives.
    const trigger = path.join(userCfg.path, `sigint-${Date.now()}`);
    const proxy = await startGatedProxy(shop.url, { afterRequests: 15, triggerFile: trigger, holdMs: 3000 });
    let r: Awaited<ReturnType<typeof sw>>;
    try {
      r = await sw(["bugs", "--target", proxy.url, "--openapi", CONTRACT, "-f", "json", "-o", "out"], {
        cwd: tmp.path,
        env: env({ SW_TEST_SIGINT_WHEN_FILE: trigger, SW_TEST_SIGINT_DELAY_MS: "100" }),
        timeoutMs: 90_000,
      });
    } finally {
      await proxy.close();
    }
    expect(proxy.seen).toBeGreaterThan(15);
    expect([130], r.stderr.slice(-1500)).toContain(r.exitCode);
    expect(r.mainReturned && !r.timedOut).toBe(true);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it("a second Ctrl+C aborts at once with exit 130", async () => {
    const r = await sw(
      ["perf", `${srv.url}/fixed/5`, "--rate", "50", "--duration", "60s", "--warmup", "0s"],
      {
        cwd: tmp.path,
        env: env({ SW_TEST_SIGINT_AFTER_MS: "2500", SW_TEST_SIGINT_COUNT: "2" }),
        timeoutMs: 60_000,
      },
    );
    expect(r.exitCode, r.stderr.slice(-1500)).toBe(130);
    expect(r.stderr).toContain("aborted");
  }, 90_000);
});
