/**
 * `sw run <workflow>` + Ctrl+C, in process (works on Windows, where a child cannot receive SIGINT):
 * the first SIGINT cancels the world gracefully, the running step returns "cancelled", later steps
 * are skipped, the exit code is 130 and nothing is saved to history. docs/09-cli-and-api.md §1.
 */
import { existsSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../../../src/cli/main.js";
import { type CalibratedServer, startCalibratedServer } from "../../fixtures/servers/calibrated.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let srv: CalibratedServer;
let tmp: TmpDir;
const prevUserCfg = process.env.SW_USER_CONFIG_DIR;

beforeAll(async () => {
  srv = await startCalibratedServer();
  tmp = await makeTmpDir("sw-run-cancel-");
  process.env.SW_USER_CONFIG_DIR = tmp.join("user");
  const step = (after: string[] = []) => ({
    engine: "performance",
    after,
    input: {
      model: "open",
      rate: 20,
      duration: "30s",
      warmup: "0s",
      scenarios: [{ name: "get", steps: [{ method: "GET", path: "/fixed/1" }] }],
    },
  });
  writeFileSync(
    tmp.join("sw.config.json"),
    JSON.stringify({
      project: { root: "." },
      targets: { api: { url: srv.url } },
      safety: { allowHosts: ["127.0.0.1"] },
      workflows: { long: { steps: { first: step(), second: step(["first"]) } } },
    }),
  );
});

afterAll(async () => {
  if (prevUserCfg === undefined) delete process.env.SW_USER_CONFIG_DIR;
  else process.env.SW_USER_CONFIG_DIR = prevUserCfg;
  await srv?.close();
  await tmp?.cleanup();
});

describe("sw run + Ctrl+C (in process)", () => {
  it("stops gracefully with exit 130 and no history run", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prevExit = process.exitCode;
    try {
      const t0 = performance.now();
      const running = main([
        "node",
        "sw",
        "--config",
        tmp.join("sw.config.json"),
        "run",
        "long",
        "--no-color",
      ]);
      const start = srv.stats().requests;
      while (srv.stats().requests === start && performance.now() - t0 < 15_000)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      process.emit("SIGINT", "SIGINT");
      const code = await running;
      expect(code).toBe(130);
      expect(performance.now() - t0).toBeLessThan(20_000);
      const errText = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(errText).toContain("stopping gracefully");
      expect(errText).toContain("first (performance): cancelled");
      expect(errText).toContain("second (performance): skipped");
      expect(errText).not.toContain("history: saved");
      expect(existsSync(tmp.join(".second-world", "history", "runs.jsonl"))).toBe(false);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = prevExit;
    }
  }, 40_000);
});
