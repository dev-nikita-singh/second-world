/**
 * Real sanity check: build the shop-express System Model with sw-model's fixtures (static analysis
 * into a temp cacheDir, OpenAPI, deployment config, OTLP traces; setup copied from
 * tests/integration/model/shop-express.test.ts) and render every report format.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { type ArchitectureData, inspectArchitecture } from "../../../src/engines/architecture/index.js";
import { buildModel, diffModels, type ModelData } from "../../../src/engines/model/index.js";
import { REPORT_FORMATS, renderModelDiff, renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import { isModelData } from "../../../src/engines/reporting/model-render.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PROJECT = path.join(ROOT, "examples/shop-express");
const FIX = path.join(ROOT, "tests/fixtures/model");
const CONFIG = [path.join(FIX, "shop-config/docker-compose.yml"), path.join(FIX, "shop-config/.env.example")];
const TRACES = [path.join(FIX, "shop-traces.json"), path.join(FIX, "payments-traces.jsonl")];

let tmp: TmpDir;
let result: EngineResult<ModelData>;
let staticOnly: EngineResult<ModelData>;

beforeAll(async () => {
  tmp = await makeTmpDir("sw-model-report-");
  const a = await inspectArchitecture({ project: PROJECT, cacheDir: tmp.join("arch") });
  const arch = a.data as ArchitectureData;
  result = (await buildModel({
    project: PROJECT,
    architectureData: arch,
    openapi: "openapi.yaml",
    config: { files: CONFIG, discover: true },
    traces: TRACES,
  })) as EngineResult<ModelData>;
  staticOnly = (await buildModel({ project: PROJECT, architectureData: arch })) as EngineResult<ModelData>;
}, 120_000);

afterAll(async () => {
  await tmp?.cleanup();
});

describe("System Model (shop-express) rendered in every format", () => {
  it("built real ModelData with runtime evidence", () => {
    expect(isModelData(result.data)).toBe(true);
    expect(result.data!.coverage.runtimeObserved).toBe(true);
    expect(result.data!.nodes.some((n) => n.id === "service:payments-fake")).toBe(true);
  });

  it("renders all formats; banner first, payments node, critical path, mermaid in html", async () => {
    for (const fmt of REPORT_FORMATS.filter((f) => f !== "junit")) {
      expect(renderReport([result], fmt, { color: false }).length, fmt).toBeGreaterThan(200);
    }
    // model data is descriptive: no JUnit suite (and no SARIF results) by design
    expect(renderReport([result], "junit")).toContain('tests="0"');
    const s = renderReport([result], "tty", { color: false });
    expect(s).toContain(`Coverage\n  ${result.data!.coverage.banner}`);
    expect(s).toContain("payments-fake");
    if (result.data!.traces?.dominant.length) expect(s).toContain("Dominant dependency per route");
    const html = renderReport([result], "html");
    expect(html).toMatch(/<pre><code>(graph|flowchart) /);
    expect(html).not.toMatch(/<script|\s(src|href)\s*=/i);
    const { files } = await writeReports([result], { formats: [...REPORT_FORMATS], outDir: tmp.join("out") });
    expect(files).toHaveLength(5);
  });

  it("static-only vs full build diff renders added nodes/sources", () => {
    const diff = diffModels(staticOnly.data!, result.data!);
    const s = renderModelDiff(diff, "tty", { color: false });
    expect(diff.summary.unchanged).toBe(false);
    expect(s).toMatch(/Added nodes|Changed evidence sources|Added edges/);
  });
});
