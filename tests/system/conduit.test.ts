/**
 * conduit-api system test (owner: sw-real7, wave 7 Plan §C): a realistic RealWorld-style API with
 * five seeded defects (examples/conduit-api/expected-findings.json). The app runs in-process on
 * 127.0.0.1:0; the user's project is a copy of the example in a temp path with a space, its
 * sw.config.ts pointed at the running app. Each detectable defect must be found by its engine
 * (recall 1.0) and every other finding must be a documented observation (precision 1.0).
 *
 * The packed-tarball user journey (build → npm pack → `npm i <tgz>` in a fresh project → every
 * command) is the second describe block. It needs the npm registry for dependencies and takes
 * minutes, so it only runs with SW_SYSTEM_PACK=1 (see examples/conduit-api/README.md).
 * docs/12-testing-and-quality.md §3, docs/09-cli-and-api.md §1 (exit codes).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningConduit } from "../../examples/conduit-api/src/server.js";
import { runCli } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";
import {
  CONDUIT_TOKENS,
  conduitTruth,
  copyConduit,
  describeScore,
  engineResult,
  score,
} from "./conduit/helpers.js";
import {
  EXAMPLES_DIR,
  expectTrustLadder,
  freePort,
  portRefuses,
  REPO_ROOT,
  snapshotTree,
} from "./helpers.js";

async function startConduit(): Promise<RunningConduit> {
  const m = await import("../../examples/conduit-api/src/server.js");
  return m.start(0, { queryDelayMs: 1 });
}

describe("conduit-api: ground truth", () => {
  it("every defect is detectable from sw.config.ts and has a marker in the code", () => {
    const truth = conduitTruth();
    expect(truth.defects.map((d) => d.id).sort()).toEqual([
      "delete-article-no-ownership",
      "favorites-count-race",
      "n-plus-one-article-list",
      "pagination-off-by-one",
      "slug-header-500",
    ]);
    for (const d of truth.defects) {
      expect(d.detectableFromConfig, d.id).toBe(true);
      expect(d.detectedBy?.length, d.id).toBeGreaterThan(0);
      const src = readFileSync(path.join(EXAMPLES_DIR, "conduit-api", d.location.file), "utf8").split("\n");
      expect(src[d.location.line - 2], d.id).toContain(`SEEDED-DEFECT:${d.id}`);
    }
  });
});

describe("conduit-api: sw from source with the example's sw.config.ts", () => {
  let tmp: TmpDir;
  let userCfg: TmpDir;
  let app: RunningConduit;
  let project: string;
  let proxyPort: number;
  let examplesBefore: Record<string, string>;
  const outputs: string[] = [];

  async function sw(args: string[], timeoutMs = 150_000) {
    const r = await runCli(args, {
      cwd: project,
      env: { SW_USER_CONFIG_DIR: userCfg.path, SW_FAULT_LEDGER: path.join(tmp.path, "ledger.json") },
      timeoutMs,
    });
    outputs.push(r.stdout, r.stderr);
    return r;
  }

  beforeAll(async () => {
    examplesBefore = snapshotTree(EXAMPLES_DIR);
    tmp = await makeTmpDir("sw-sys-conduit-");
    userCfg = await makeTmpDir("sw-sys-conduit-ucfg-");
    app = await startConduit();
    proxyPort = await freePort();
    project = path.join(tmp.path, "conduit project");
    copyConduit(project, app.url, proxyPort);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await tmp?.cleanup();
    await userCfg?.cleanup();
  });

  it("config validate", async () => {
    const r = await sw(["config", "validate"]);
    expect(r.exitCode, r.stderr).toBe(0);
  }, 60_000);

  it("sw inspect finds the N+1 article list (ARCH005) and nothing else", async () => {
    const r = await sw(["inspect", "--json"]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0); // medium findings only (fail-on high)
    const rep = engineResult(r.stdout, "inspect");
    expectTrustLadder([rep]);
    const s = score("sw inspect", rep);
    process.stderr.write(`${describeScore("sw inspect", s, rep)}\n`);
    expect(s.matched).toEqual(["n-plus-one-article-list"]);
    expect(s.falsePositives).toEqual([]);
    expect(s.precision).toBe(1);
  }, 120_000);

  it("sw bugs reproduces pagination, slug-500, BOLA delete and the favorites race; no false positives", async () => {
    await fetch(`${app.url}/__test/reset`, { method: "POST" });
    const r = await sw(["--yes", "bugs", "--json"], 240_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const rep = engineResult(r.stdout, "bugs");
    expectTrustLadder([rep]);
    const s = score("sw bugs", rep);
    process.stderr.write(`${describeScore("sw bugs", s, rep)}\n`);
    expect(s.missed).toEqual([]);
    expect(s.matched.sort()).toEqual([
      "delete-article-no-ownership",
      "favorites-count-race",
      "pagination-off-by-one",
      "slug-header-500",
    ]);
    expect(s.falsePositives).toEqual([]);
    for (const f of rep.findings) expect(f.classification, f.title).toBe("reproduced-defect");
  }, 300_000);

  it("sw agent finds the missing ownership check (from bugs.stateful.resources) and nothing else", async () => {
    await fetch(`${app.url}/__test/reset`, { method: "POST" });
    const r = await sw(["agent", "--json"], 180_000);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const rep = engineResult(r.stdout, "agent");
    const s = score("sw agent", rep);
    process.stderr.write(`${describeScore("sw agent", s, rep)}\n`);
    expect(s.matched).toEqual(["delete-article-no-ownership"]);
    expect(s.falsePositives).toEqual([]);
  }, 200_000);

  it("sw reliability (fault proxy in front of the API) holds its hypothesis; the proxy is gone afterwards", async () => {
    const r = await sw(
      ["--approve-disruptive", "reliability", "run", "dependency-latency", "--json"],
      120_000,
    );
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const rep = engineResult(r.stdout, "reliability");
    expectTrustLadder([rep]);
    const s = score("sw reliability run dependency-latency", rep);
    expect(s.falsePositives).toEqual([]);
    expect(await portRefuses(proxyPort)).toBe(true);
  }, 150_000);

  it("no demo token in any output; examples/ untouched", () => {
    for (const t of CONDUIT_TOKENS) expect(outputs.join("\n").includes(t), `${t} in CLI output`).toBe(false);
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

describe.skipIf(!PACK)("conduit-api: packed tarball user journey (SW_SYSTEM_PACK=1)", () => {
  let tmp: TmpDir;
  let app: RunningConduit;
  let proj: string;
  let proxyPort: number;
  const log: string[] = [];

  const npm = (args: string[], cwd: string) =>
    execFileSync(process.execPath, [NPM_CLI as string, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    }).toString();

  /** `npx sw …` without a shell: the installed bin's JS entry. */
  async function sw(args: string[], cwd = proj, timeout = 240_000) {
    const r = await execa(
      process.execPath,
      [path.join(proj, "node_modules", "second-world", "dist", "cli.mjs"), ...args],
      {
        cwd,
        reject: false,
        timeout,
        env: { NO_COLOR: "1", CI: "1", SW_USER_CONFIG_DIR: path.join(tmp.path, "usercfg") },
        windowsHide: true,
        stdin: "ignore",
      },
    );
    const exitCode = typeof r.exitCode === "number" ? r.exitCode : -1;
    log.push(`sw ${args.join(" ")} → exit ${exitCode}`);
    return { exitCode, stdout: String(r.stdout), stderr: String(r.stderr) };
  }

  beforeAll(async () => {
    tmp = await makeTmpDir("sw-sys-conduit-pack-");
    mkdirSync(path.join(tmp.path, "usercfg"));
    // Build into a staging dir (the repo's dist/ is left alone), then `npm pack` it.
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
    // A fresh project outside the repo, in a path with a space: npm init + npm i <tgz> (+ typescript for inspect).
    proj = path.join(tmp.path, "my conduit project");
    mkdirSync(proj);
    npm(["init", "-y"], proj);
    npm(["i", tgz, "typescript@6", "--no-audit", "--no-fund"], proj);
    app = await startConduit();
    proxyPort = await freePort();
    // The user's own code + contract next to the installed package.
    copyConduit(path.join(tmp.path, "conduit-src"), app.url, proxyPort);
    for (const f of ["src", "invariants", "openapi.yaml"])
      cpSync(path.join(tmp.path, "conduit-src", f), path.join(proj, f), { recursive: true });
  }, 900_000);

  afterAll(async () => {
    process.stderr.write(`[conduit pack journey]\n${log.join("\n")}\n`);
    await app?.close();
    await tmp?.cleanup();
  });

  it("doctor and init work in the fresh project", async () => {
    const d = await sw(["doctor"]);
    expect(d.exitCode, d.stdout + d.stderr).toBe(0);
    expect(d.stdout).toMatch(/node:sqlite/);
    const i = await sw(["init", "--target", app.url]);
    expect(i.exitCode, i.stdout + i.stderr).toBe(0);
    expect(readFileSync(path.join(proj, "sw.config.ts"), "utf8")).toContain("./openapi.yaml");
    const v = await sw(["config", "validate"]);
    expect(v.exitCode, v.stderr).toBe(0);
  }, 120_000);

  it("every engine runs with the example config; bugs + inspect recall/precision 1.0", async () => {
    writeFileSync(
      path.join(proj, "sw.config.ts"),
      readFileSync(path.join(tmp.path, "conduit-src", "sw.config.ts"), "utf8"),
    );
    const ins = await sw(["inspect", "--json"]);
    expect(ins.exitCode, ins.stderr.slice(-1500)).toBe(0);
    const si = score("sw inspect", engineResult(ins.stdout, "inspect"));
    expect([si.missed, si.falsePositives]).toEqual([[], []]);

    await fetch(`${app.url}/__test/reset`, { method: "POST" });
    const bugs = await sw(["--yes", "bugs", "--json"]);
    expect(bugs.exitCode, bugs.stderr.slice(-1500)).toBe(1);
    const sb = score("sw bugs", engineResult(bugs.stdout, "bugs"));
    expect([sb.missed, sb.falsePositives]).toEqual([[], []]);

    await fetch(`${app.url}/__test/reset`, { method: "POST" });
    const steps: [string[], number[]][] = [
      [["agent"], [1]],
      [["perf", "--duration", "3s"], [0]],
      [["stress"], [0]],
      [["--approve-disruptive", "reliability", "run", "dependency-latency"], [0]],
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
  }, 900_000);
});
