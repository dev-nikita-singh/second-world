import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

// Regression (wave 8): `--dry-run` for bugs and agent only parsed the input and printed "config valid"
// (exit 0) where the real run fails before sending traffic: unreadable/invalid contract, missing or
// export-less invariant module, a hook URL the Safety Guard blocks (exit 3), unreadable --context
// reports. `model build --dry-run --receive N` listened for N seconds. A dry run must fail exactly
// where the real run would, and send nothing.

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
};

describe("--dry-run for bugs / agent / model validates what the real run validates", () => {
  let dir: TmpDir;
  let server: Server;
  let target = "";
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await makeTmpDir("sw-dryrun-eng-");
    await mkdir(dir.join(".git"));
    await writeFile(dir.join("sw.config.json"), JSON.stringify({ targets: { api: { url: target } } }));
    await writeFile(
      dir.join("hook.config.json"),
      JSON.stringify({
        targets: { api: { url: target } },
        hooks: { setup: { http: { method: "POST", url: "http://example.com/setup" } } },
      }),
    );
    await writeFile(dir.join("openapi.json"), JSON.stringify(OPENAPI));
    await writeFile(dir.join("not-openapi.json"), "{}");
    await writeFile(dir.join("bad.yaml"), "not: [valid\n");
    await writeFile(dir.join("no-fn.mjs"), "export const x = 1;\n");
    await writeFile(dir.join("inv.mjs"), "export default () => true;\n");
    await writeFile(dir.join("report.json"), JSON.stringify({ results: [] }));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    await dir.cleanup();
  });

  const env = () => ({ SW_USER_CONFIG_DIR: dir.join("no-user-config") });
  const run = (args: string[]) => runCli(args, { cwd: dir.path, env: env(), timeoutMs: 60_000 });
  const conc = ["--techniques", "concurrency", "--concurrency-test", "GET /x"];

  it.each([
    ["bugs valid contract", ["bugs", "--openapi", "openapi.json"]],
    ["bugs invariant module", ["bugs", "--openapi", "openapi.json", ...conc, "--invariant", "./inv.mjs"]],
    ["agent valid contract + context", ["agent", "--openapi", "openapi.json", "--context", "report.json"]],
  ])("control: %s → exit 0, nothing sent", async (_n, args) => {
    hits = 0;
    const r = await run(["--dry-run", ...args]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(hits).toBe(0);
  });

  it.each([
    ["bugs missing contract", ["bugs", "--openapi", "missing.json"], 2, "Cannot read contract"],
    ["bugs unparsable contract", ["bugs", "--openapi", "bad.yaml"], 2, "Invalid contract"],
    ["bugs not an OpenAPI document", ["bugs", "--openapi", "not-openapi.json"], 2, "Invalid contract"],
    [
      "bugs missing invariant module",
      ["bugs", "--openapi", "openapi.json", ...conc, "--invariant", "./nope.mjs"],
      2,
      "Cannot load invariant module",
    ],
    [
      "bugs invariant module without a function export",
      ["bugs", "--openapi", "openapi.json", ...conc, "--invariant", "./no-fn.mjs"],
      2,
      "no function export",
    ],
    [
      "bugs hook to a blocked host",
      ["-c", "hook.config.json", "bugs", "--openapi", "openapi.json"],
      3,
      "Hook setup targets a blocked host",
    ],
    ["agent invalid contract", ["agent", "--openapi", "not-openapi.json"], 2, "Invalid contract"],
    [
      "agent unreadable --context",
      ["agent", "--openapi", "openapi.json", "--context", "nope.json"],
      2,
      "Cannot read context report",
    ],
    [
      "agent hook to a blocked host",
      ["-c", "hook.config.json", "agent", "--openapi", "openapi.json"],
      3,
      "Hook setup targets a blocked host",
    ],
  ])("%s: dry run fails like the real run", async (_n, args, code, needle) => {
    hits = 0;
    const dry = await run(["--dry-run", ...args]);
    expect(dry.stdout).not.toContain("config valid");
    expect(dry.exitCode, dry.stdout + dry.stderr).toBe(code);
    expect(dry.stderr).toContain(needle);
    expect(hits).toBe(0);
    // same exit code and message as the real run
    const real = await run([...args, "--no-history"]);
    expect(real.exitCode, real.stdout + real.stderr).toBe(code);
    expect(real.stderr).toContain(needle);
  });

  it("model build --dry-run --receive does not listen or wait", async () => {
    const t0 = performance.now();
    const r = await run(["--dry-run", "model", "build", "--receive", "30", "--no-architecture"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(performance.now() - t0).toBeLessThan(25_000);
  });

  it("model build --dry-run --receive still validates the number like the real run", async () => {
    const r = await run(["--dry-run", "model", "build", "--receive", "abc"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--receive");
  });

  it("model build --dry-run lists the inputs the real run would skip (as limitations), exit 0", async () => {
    const r = await run([
      "--dry-run",
      "model",
      "build",
      "--no-architecture",
      "--traces",
      "nope-traces.json",
      "--openapi",
      "missing.json",
    ]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.dryRun).toBe(true);
    const w = (j.warnings as string[]).join("\n");
    expect(w).toContain("nope-traces.json");
    expect(w).toContain("missing.json");
  });
});
