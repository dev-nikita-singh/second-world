import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { contractHints } from "../../../src/cli/commands/init.js";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";

// Regression (wave 7, sw-real7 packed journey): `sw init` ignored the OpenAPI `servers` URL (target
// defaulted to :3000) and wrote no perf scenario, so the first `sw perf` hit GET / and failed 100%.
const CONDUIT = join(REPO_ROOT, "examples", "conduit-api", "openapi.yaml");
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sw-init-oa-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const env = () => ({ SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") });

const doc = (over: Record<string, unknown>) => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  ...over,
});

describe("contractHints (pure)", () => {
  it("conduit: local server URL, a public GET without required params, the health path", () => {
    const text = readFileSync(CONDUIT, "utf8");
    const h = contractHints(text);
    expect(h.serverUrl).toBe("http://127.0.0.1:3100");
    expect(h.perfGet?.path).toBe("/api/articles");
    expect(h.healthPath).toBe("/healthz");
  });

  it("relative server URL with variables → default origin + resolved path", () => {
    const h = contractHints(
      JSON.stringify(
        doc({
          servers: [{ url: "/{base}/v1", variables: { base: { default: "api" } } }],
          paths: { "/items": { get: { responses: {} } } },
        }),
      ),
    );
    expect(h.serverUrl).toBe("http://127.0.0.1:3000/api/v1");
    expect(h.perfGet?.path).toBe("/items");
  });

  it("remote server: not used as the target, keeps its path, says why", () => {
    const h = contractHints(
      JSON.stringify(doc({ servers: [{ url: "https://api.example.com/v2" }], paths: {} })),
    );
    expect(h.serverUrl).toBe("http://127.0.0.1:3000/v2");
    expect(h.serverNote).toMatch(/api\.example\.com.*not local/);
    expect(h.perfGet).toBeUndefined();
  });

  it("skips GETs needing auth or required params; none left → no scenario", () => {
    const h = contractHints(
      JSON.stringify(
        doc({
          security: [{ bearer: [] }],
          paths: {
            "/me": { get: { responses: {} } },
            "/items/{id}": { get: { responses: {} } },
            "/search": { get: { parameters: [{ name: "q", in: "query", required: true }], responses: {} } },
          },
        }),
      ),
    );
    expect(h.perfGet).toBeUndefined();
  });

  it("unparsable contract → no hints, no throw", () => {
    expect(contractHints(":\n  - [")).toEqual({});
  });
});

describe("sw init with an OpenAPI contract (subprocess)", () => {
  it("uses servers[0] and writes a perf scenario that validates", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "conduit-copy" }));
    copyFileSync(CONDUIT, join(dir, "openapi.yaml"));
    const r = await runCli(["--yes", "init"], { cwd: dir, env: env() });
    expect(r.exitCode, r.stderr).toBe(0);
    const cfg = readFileSync(join(dir, "sw.config.ts"), "utf8");
    expect(cfg).toContain('url: "http://127.0.0.1:3100"');
    expect(cfg).toContain('path: "/api/articles"');
    expect(r.stdout).toMatch(/target http:\/\/127\.0\.0\.1:3100 \(from openapi\.yaml servers\[0\]/);
    expect(r.stdout).toMatch(/perf scenario: GET \/api\/articles/);
    const dry = await runCli(["--dry-run", "perf", "--json"], { cwd: dir, env: env() });
    expect(dry.exitCode, dry.stderr).toBe(0);
    const plan = JSON.parse(dry.stdout);
    expect(plan.target).toBe("http://127.0.0.1:3100");
    expect(plan.input.scenarios[0].steps[0].path).toBe("/api/articles");
  }, 60_000);

  it("no usable GET: keeps the old behaviour and says so", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "docs"));
    writeFileSync(
      join(dir, "docs", "openapi.json"),
      JSON.stringify(doc({ paths: { "/items/{id}": { get: { responses: {} } } } })),
    );
    const r = await runCli(["--yes", "init"], { cwd: dir, env: env() });
    expect(r.exitCode, r.stderr).toBe(0);
    const cfg = readFileSync(join(dir, "sw.config.ts"), "utf8");
    expect(cfg).not.toContain("scenarios");
    expect(r.stdout).toMatch(/no GET without auth or required parameters/);
  }, 60_000);
});
