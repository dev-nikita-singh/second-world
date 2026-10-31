/**
 * Real sanity check: the heuristic Adversarial Test Agent with a small budget against shop-express
 * (setup copied from tests/integration/agent/shop-express.test.ts), rendered in every format.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type AgentData, runAgent } from "../../../src/engines/agent/index.js";
import { isAgentData } from "../../../src/engines/reporting/agent.js";
import { REPORT_FORMATS, renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const TOKENS = ["alice-token", "bob-token", "admin-token"];

let app: RunningExample;
let result: EngineResult<AgentData>;
let tmp: TmpDir;

beforeAll(async () => {
  app = await startExample("shop-express");
  tmp = await makeTmpDir("sw-agent-report-");
  result = await runAgent(
    {
      target: app.url,
      openapi: "examples/shop-express/openapi.yaml",
      seed: 42,
      allowMutations: true,
      auth: {
        roles: {
          user: { type: "bearer", token: "alice-token" },
          other: { type: "bearer", token: "bob-token" },
          admin: { type: "bearer", token: "admin-token" },
        },
      },
      hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
      budget: { maxRequests: 300, maxIterations: 40, patience: 20 },
    },
    { seed: 42 },
  );
}, 60_000);

afterAll(async () => {
  await app?.close();
  await tmp?.cleanup();
});

describe("Adversarial agent result rendered in every format (shop-express)", () => {
  it("produced real AgentData", () => {
    expect(isAgentData(result.data)).toBe(true);
    expect(result.data!.hypotheses.length).toBeGreaterThan(0);
  });

  it("renders every format without leaking tokens", async () => {
    for (const fmt of REPORT_FORMATS) {
      const out = renderReport([result], fmt, { color: false });
      expect(out.length, fmt).toBeGreaterThan(200);
      for (const t of TOKENS) expect(out, `${fmt} leaks ${t}`).not.toContain(t);
    }
    const s = renderReport([result], "tty", { color: false });
    expect(s).toMatch(/planner\s+heuristic/);
    expect(s).toContain("Hypotheses tried");
    const xml = renderReport([result], "junit");
    expect([...xml.matchAll(/<testcase /g)]).toHaveLength(result.data!.hypotheses.length);
    const sarif = JSON.parse(renderReport([result], "sarif"));
    for (const r of sarif.runs[0].results as any[])
      expect(r.locations[0].logicalLocations[0].name).toMatch(/^[A-Z]+ \//);
    const { files } = await writeReports([result], { formats: [...REPORT_FORMATS], outDir: tmp.path });
    expect(files).toHaveLength(5);
  });
});
