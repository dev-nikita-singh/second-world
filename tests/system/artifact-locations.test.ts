/**
 * System test: where SECOND WORLD writes. Reports, history, model snapshots and the audit log go
 * under the config directory (`<cwd>/.second-world`, `report.outDir`); the inspected project must
 * stay untouched (docs/11-safety-security-privacy.md: the inspector "never runs project code" — it
 * should not write into it either; the project may be read-only or someone else's checkout).
 *
 * Regression guard: the inspector's default cache used to be resolved against the project root
 * (`<project.root>/.second-world/cache/arch`); world.buildArchitectureInput/buildModelInput now
 * default it to `<config cwd>/.second-world/cache/arch` (fixed by main after sw-qa's report).
 * Owner: sw-qa.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import { EXAMPLES_DIR, snapshotTree } from "./helpers.js";

const PROJECT = path.join(EXAMPLES_DIR, "shop-express");
const STRAY = path.join(PROJECT, ".second-world");

let tmp: TmpDir;
let userCfg: TmpDir;
let strayExisted: boolean;

beforeAll(async () => {
  tmp = await makeTmpDir("sw-sys-loc-");
  userCfg = await makeTmpDir("sw-sys-usercfg-");
  mkdirSync(tmp.join(".git"));
  writeFileSync(tmp.join("sw.config.json"), JSON.stringify({ project: { root: PROJECT } }));
  strayExisted = existsSync(STRAY);
});

afterAll(async () => {
  // never leave the stray cache behind in examples/ (only remove what this test created)
  if (!strayExisted) rmSync(STRAY, { recursive: true, force: true, maxRetries: 5 });
  await tmp?.cleanup();
  await userCfg?.cleanup();
});

const sw = (args: string[]) =>
  runCli(args, { cwd: tmp.path, env: { SW_USER_CONFIG_DIR: userCfg.path }, timeoutMs: 90_000 });

describe("artifact locations", () => {
  it("sw inspect with default cache settings writes nothing into the inspected project", async () => {
    const before = snapshotTree(PROJECT);
    const r = await sw(["inspect", "--no-history", "-f", "json"]);
    expect([0, 1], r.stderr).toContain(r.exitCode);
    expect(existsSync(tmp.join(".second-world", "reports", "report.json"))).toBe(true);
    const added = Object.keys(snapshotTree(PROJECT)).filter((k) => !(k in before));
    expect(added, `written into the project: ${added.join(", ")}`).toEqual([]);
  }, 90_000);
});
