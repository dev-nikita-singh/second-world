/**
 * Packaging test (owner: sw-qa): the package a user installs works, not just the source tree.
 * docs/09-cli-and-api.md §1 (binaries `sw`/`second-world`), §2 (programmatic API), §3 (public API = exports).
 *
 * Offline and deterministic: tsdown builds into a temp dir, `npm pack` packs a staging copy (package.json +
 * README + dist), and the tarball is extracted into <tmp>/proj/node_modules/second-world. Its declared
 * `dependencies` are linked (junctions) from the repo's node_modules, so an import of an undeclared package
 * fails as it would after `npm i`. typescript is an optional peer: linked only for the inspect case.
 *
 * Regression: the bundled TypeScript crashed `sw inspect` in the ESM bin with
 * "__filename is not defined in ES module scope" (exit 70). Fixed in 7e10dc0 (typescript = optional peer).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../helpers/tmp.js";

/** npm's JS entry, run with this node (no shell, no npm.cmd shim). */
const NPM_CLI = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((p): p is string => typeof p === "string" && /npm-cli.js$/.test(p) && existsSync(p));
const TSDOWN = path.join(REPO_ROOT, "node_modules", "tsdown", "dist", "run.mjs");
const TSC = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const canBuild = existsSync(TSDOWN) && existsSync(TSC) && NPM_CLI !== undefined;

let tmp: TmpDir;
let proj: string;
let pkgDir: string;
let tarball: string;
let server: http.Server;
let url: string;

/** Minimal ustar reader (regular files only; enough for `npm pack` output). */
function extractTgz(file: string, dest: string): string[] {
  const buf = gunzipSync(readFileSync(file));
  const names: string[] = [];
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) =>
      h
        .subarray(a, a + n)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(str(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] ?? 48);
    const prefix = str(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = undefined;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type !== "0" && type !== "\0") continue;
    name = name.replace(/^package\//, "");
    const out = path.join(dest, name);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, body);
    names.push(name);
  }
  return names;
}

function link(name: string): void {
  const from = path.join(REPO_ROOT, "node_modules", name);
  const to = path.join(proj, "node_modules", name);
  if (existsSync(to)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  symlinkSync(from, to, "junction");
}

const sw = (args: string[], cwd = proj, timeout = 90_000) =>
  execa(process.execPath, [path.join(pkgDir, "dist", "cli.mjs"), ...args], {
    cwd,
    reject: false,
    timeout,
    env: { NO_COLOR: "1", CI: "1", SW_USER_CONFIG_DIR: path.join(tmp.path, "usercfg") },
    windowsHide: true,
    stdin: "ignore",
  });

let files: string[] = [];

beforeAll(async () => {
  if (!canBuild) return;
  tmp = await makeTmpDir("sw-qa5-pkg-");
  mkdirSync(path.join(tmp.path, "usercfg"));
  const stage = path.join(tmp.path, "stage");
  mkdirSync(stage);
  execFileSync(process.execPath, [TSDOWN, "--out-dir", path.join(stage, "dist"), "--no-sourcemap"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  cpSync(path.join(REPO_ROOT, "package.json"), path.join(stage, "package.json"));
  cpSync(path.join(REPO_ROOT, "README.md"), path.join(stage, "README.md"));
  const packOut = execFileSync(
    process.execPath,
    [NPM_CLI as string, "pack", "--json", "--ignore-scripts", "--pack-destination", tmp.path],
    {
      cwd: stage,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString();
  const info = JSON.parse(packOut.slice(packOut.indexOf("[")))[0] as { filename: string };
  tarball = path.join(tmp.path, info.filename);

  proj = path.join(tmp.path, "proj with space");
  pkgDir = path.join(proj, "node_modules", "second-world");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
  );
  files = extractTgz(tarball, pkgDir);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const dep of Object.keys(pkg.dependencies)) link(dep);

  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await tmp?.cleanup();
});

describe.skipIf(!canBuild)("packed second-world package", () => {
  it("tarball: bins and exports point at shipped files; TypeScript is not bundled; small", () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    for (const bin of Object.values(pkg.bin as Record<string, string>))
      expect(files).toContain(bin.replace(/^\.\//, ""));
    const exp = pkg.exports["."];
    for (const p of [exp.import.default, exp.import.types, exp.require.default, exp.require.types])
      expect(files).toContain(p.replace(/^\.\//, ""));
    expect(files.some((f) => f.startsWith("dist/perf-worker"))).toBe(true);
    expect(files.filter((f) => /dist\/typescript-/.test(f))).toEqual([]);
    expect(pkg.peerDependencies?.typescript).toBeDefined();
    expect(statSync(tarball).size).toBeLessThan(5 * 1024 * 1024);
    for (const f of (pkg.files as string[]).filter((x) => !x.startsWith("!")))
      expect(existsSync(path.join(pkgDir, f)), `files entry ${f}`).toBe(true);
    // Sourcemaps are not shipped (they were 220 of 235 files, ~6 MB unpacked).
    expect(files.filter((f) => f.endsWith(".map"))).toEqual([]);
  });

  it("sw --help / --version / doctor run from the installed bin", async () => {
    const v = await sw(["--version"]);
    expect(v.exitCode).toBe(0);
    expect(v.stdout.trim()).toBe(JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version);
    const h = await sw(["--help"]);
    expect(h.exitCode).toBe(0);
    for (const cmd of ["perf", "stress", "inspect", "bugs", "reliability", "model", "history", "analyze"])
      expect(h.stdout).toContain(cmd);
    const d = await sw(["doctor", "--quick"]);
    expect(d.exitCode).toBe(0);
  });

  it("library: ESM import and CJS require expose createWorld/defineConfig", async () => {
    const esm = await execa(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const m = await import("second-world"); console.log(typeof m.createWorld, typeof m.defineConfig)',
      ],
      { cwd: proj, reject: false },
    );
    expect(esm.stdout.trim(), esm.stderr).toBe("function function");
    const cjs = await execa(
      process.execPath,
      ["-e", 'const m = require("second-world"); console.log(typeof m.createWorld, typeof m.defineConfig)'],
      { cwd: proj, reject: false },
    );
    expect(cjs.stdout.trim(), cjs.stderr).toBe("function function");
  });

  it("sw perf --workers 2 uses worker threads from the package (perf-worker entry)", async () => {
    const r = await sw([
      "perf",
      url,
      "--model",
      "closed",
      "--vus",
      "4",
      "--duration",
      "1s",
      "--workers",
      "2",
      "--no-history",
    ]);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toMatch(/workers 2/);
    expect(r.stdout).not.toMatch(/workers-unavailable/);
  });

  it("sw inspect without typescript: capability missing (exit 4) with a hint", async () => {
    const proj2 = path.join(tmp.path, "inspect-no-ts");
    cpSync(path.join(REPO_ROOT, "examples", "shop-express", "src"), path.join(proj2, "src"), {
      recursive: true,
    });
    const r = await sw(["inspect", proj2, "--no-history"], proj);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(4);
    expect(r.stderr).toMatch(/typescript/i);
    expect(r.stderr).not.toMatch(/__filename|Internal error/);
  });

  it("sw inspect with typescript installed: ESM bin finds the seeded risks (exit 1), no crash", async () => {
    link("typescript");
    const proj3 = path.join(tmp.path, "inspect-ts");
    cpSync(path.join(REPO_ROOT, "examples", "shop-express", "src"), path.join(proj3, "src"), {
      recursive: true,
    });
    const r = await sw(["inspect", proj3, "--no-history", "--json"], proj);
    expect(r.stderr).not.toMatch(/__filename|Internal error/);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(1);
    const res = JSON.parse(r.stdout).results[0];
    expect(res.findings.length).toBeGreaterThanOrEqual(5);
  });

  it("types resolve for a consumer (tsc --noEmit, nodenext, ESM + CJS)", () => {
    link("typescript");
    link("@types/node");
    writeFileSync(
      path.join(proj, "a.ts"),
      [
        'import { createWorld, defineConfig, type ExitCode } from "second-world";',
        'const cfg = defineConfig({ targets: { api: { url: "http://127.0.0.1:1" } } });',
        "export async function f(): Promise<string> {",
        "  const w = await createWorld({ config: cfg });",
        '  const r = await w.performance.run({ model: "iterations", iterations: 1, vus: 1 });',
        "  await w.close();",
        "  return r.status;",
        "}",
        "export type E = typeof ExitCode;",
      ].join("\n"),
    );
    writeFileSync(
      path.join(proj, "b.cts"),
      'import sw = require("second-world");\nexport const c = sw.defineConfig({});\n',
    );
    writeFileSync(
      path.join(proj, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          types: ["node"],
        },
        files: ["a.ts", "b.cts"],
      }),
    );
    let out = "";
    try {
      execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: proj, stdio: "pipe" });
    } catch (e) {
      out = String((e as { stdout?: Buffer }).stdout ?? e);
    }
    expect(out).toBe("");
  });
});
