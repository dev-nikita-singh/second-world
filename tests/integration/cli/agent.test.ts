/**
 * `sw agent` end to end (owner: sw-core): short heuristic run against shop-express (in-process)
 * with a small request budget and --export-tests into a temp dir. Asserts the budget, the exported
 * Vitest files (valid TypeScript, no secrets), history, and that nothing is written into examples/.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, runCli } from "../../helpers/cli.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config"), SW_TEST_ALICE: "alice-token" };
const EXAMPLE = join(REPO_ROOT, "examples", "shop-express");

describe("sw agent (subprocess, shop-express)", () => {
  let app: RunningExample;
  let dir: string;
  beforeAll(async () => {
    app = await startExample("shop-express");
    dir = mkdtempSync(join(tmpdir(), "sw-agent-cli-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, "sw.config.json"),
      JSON.stringify({
        targets: { api: { url: app.url } },
        auth: {
          user: { type: "bearer", token: { env: "SW_TEST_ALICE" } },
          other: { type: "bearer", token: "bob-token" },
          admin: { type: "bearer", token: "admin-token", privileged: true },
        },
        hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
        bugs: { contract: join(EXAMPLE, "openapi.yaml") },
      }),
    );
  }, 30_000);
  afterAll(async () => {
    await app?.close();
  });

  it("heuristic run within budget; exported tests are valid TypeScript without secrets", async () => {
    const hadDotDir = existsSync(join(EXAMPLE, ".second-world"));
    const out = mkdtempSync(join(tmpdir(), "sw-agent-tests-"));
    const r = await runCli(
      [
        "--yes",
        "--seed",
        "42",
        "--label",
        "agent-smoke",
        "-f",
        "json",
        "agent",
        "--allow-mutations",
        "--budget",
        "requests=150,iterations=80",
        "--export-tests",
        out,
        "--json",
      ],
      { cwd: dir, env, timeoutMs: 180_000 },
    );
    expect([0, 1], r.stderr.slice(-2000)).toContain(r.exitCode);
    const res = JSON.parse(r.stdout).results[0];
    expect(res.engine).toBe("agent");
    const budget = res.data.budget;
    expect(budget.requests.max).toBe(150);
    expect(budget.requests.used).toBeLessThanOrEqual(150);
    expect(budget.iterations.used).toBeLessThanOrEqual(80);
    expect(res.data.planner).toBe("heuristic");
    expect(r.exitCode).toBe(
      res.findings.some((f: { classification: string }) => f.classification === "reproduced-defect") ? 1 : 0,
    );

    const suggested = res.data.suggestedTests as Array<{ filename: string }>;
    const files = readdirSync(out);
    expect(files.length).toBe(suggested.length);
    expect(files.length, "expected at least one confirmed defect on shop-express").toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(out, f), "utf8");
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      const diags = (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
      expect(diags, f).toEqual([]);
      expect(text).not.toContain("alice-token");
      expect(text).not.toContain("bob-token");
    }
    const hist = JSON.parse((await runCli(["history", "list", "--json"], { cwd: dir, env })).stdout);
    expect(hist[0]).toMatchObject({ label: "agent-smoke" });
    expect(existsSync(join(EXAMPLE, ".second-world"))).toBe(hadDotDir);
  }, 200_000);
});
