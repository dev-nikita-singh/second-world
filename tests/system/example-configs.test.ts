/**
 * System test: the configs shipped with the example apps must validate (`sw config validate`,
 * docs/08-configuration.md), since README/quickstart users start from them.
 * KNOWN BUG (reported to main by sw-qa): examples/shop-express/sw.config.ts uses scenario-level
 * `auth: "user"` (specified in docs/08 §example) which the performance schema rejects
 * (scenarios.2: Unrecognized key "auth", exit 2). Fixed (scenario-level auth supported); kept as a regression test.
 * Owner: sw-qa.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { EXAMPLES_DIR } from "./helpers.js";

const validate = (app: string) =>
  runCli(["config", "validate", "-c", path.join(EXAMPLES_DIR, app, "sw.config.ts")], {
    env: { SW_USER_CONFIG_DIR: path.join(os.tmpdir(), "sw-no-user-config") },
    timeoutMs: 60_000,
  });

describe("shipped example configs validate", () => {
  it("shop-fastify/sw.config.ts", async () => {
    const r = await validate("shop-fastify");
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  }, 60_000);

  it("shop-express/sw.config.ts", async () => {
    const r = await validate("shop-express");
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  }, 60_000);
});
