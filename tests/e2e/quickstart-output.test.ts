/**
 * Regression for the two "known issue" notes that docs/quickstart.md carried until wave 9, checked on
 * the printed terminal report of the real CLI (the engine-level checks live in
 * tests/integration/stress/stress-lab.test.ts and tests/integration/bugs/shop-express.test.ts):
 *   §5  a stress run throttled by `safety.maxRps` says so in the report (capacity line, CAPPED column,
 *       STRESS-SAFETY-RATE-CAP limitation), instead of presenting the cap as the app's capacity;
 *   §7  printed curl reproductions are copy-paste ready: credentials as "$SW_AUTH_<ROLE>" (full header
 *       value), multi-step repros with the recorded ids, never `{{…}}` or `%7B%7B`, never a token.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CalibratedServer, startCalibratedServer } from "../fixtures/servers/calibrated.js";
import { REPO_ROOT, runCli } from "../helpers/cli.js";
import { type RunningExample, startExample } from "../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";

let srv: CalibratedServer;
let shop: RunningExample;
let tmp: TmpDir;
let userCfg: TmpDir;

beforeAll(async () => {
  srv = await startCalibratedServer();
  shop = await startExample("shop-express");
  tmp = await makeTmpDir("sw-e2e-qs-");
  userCfg = await makeTmpDir("sw-usercfg-");
});

afterAll(async () => {
  await srv?.close();
  await shop?.close();
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

const sw = (cwd: string, args: string[]) =>
  runCli(args, { cwd, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs: 120_000 });

describe("quickstart printed output", () => {
  it("a stress run limited by safety.maxRps names the cap in the terminal report", async () => {
    const dir = tmp.join("stress");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "sw.config.json"),
      JSON.stringify({ safety: { allowHosts: ["127.0.0.1"], maxRps: 50 } }),
    );
    const r = await sw(dir, [
      "stress",
      `${srv.url}/fixed/1`,
      "--vus",
      "2",
      "--steps",
      "2,4",
      "--hold",
      "1s",
      "--no-history",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("limited by safety.maxRps 50 req/s; the target's capacity was not reached");
    expect(r.stdout).toContain("This is not a capacity of the target.");
    expect(r.stdout).toMatch(/│ CAPPED +│/);
    expect(r.stdout).toContain("[STRESS-SAFETY-RATE-CAP] invalidates");
  }, 120_000);

  it("sw bugs prints copy-paste-ready curl reproductions (auth env var, recorded ids, no templates)", async () => {
    const dir = tmp.join("bugs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: shop.url } },
        safety: { allowHosts: ["127.0.0.1"], allowMutations: true },
        auth: {
          user: { type: "bearer", token: "alice-token" },
          other: { type: "bearer", token: "bob-token" },
        },
        hooks: { reset: { http: { method: "POST", url: `${shop.url}/__test/reset` } } },
        bugs: { contract: path.join(REPO_ROOT, "examples", "shop-express", "openapi.yaml") },
      }),
    );
    const r = await sw(dir, ["--yes", "bugs", "--techniques", "auth", "--allow-mutations", "--no-history"]);
    expect(r.exitCode, r.stderr).toBe(1); // BOLA is critical
    const repro = r.stdout.slice(r.stdout.indexOf("Reproductions"));
    expect(repro).toContain("export SW_AUTH_<ROLE>='<full header value, e.g. Bearer …>'");
    const bola = repro.slice(repro.indexOf("bugs/bola"));
    const lines = bola.split(/\r?\n/).filter((l) => l.trim().startsWith("curl "));
    expect(lines[0]).toMatch(/^ {4}curl -sS -X POST '.*\/orders' -H "authorization: \$SW_AUTH_USER"/);
    expect(lines[1]).toMatch(
      /^ {4}curl -sS -X GET '.*\/orders\/ord_\d+' -H "authorization: \$SW_AUTH_OTHER"$/,
    );
    expect(repro).not.toMatch(/\{\{|%7B%7B|alice-token|bob-token|Bearer \$/i);
  }, 120_000);
});
