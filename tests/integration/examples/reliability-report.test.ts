/**
 * Real sanity check: a short Reliability Lab run (dependency-5xx on payments, shop-express behind
 * the built-in fault proxy; setup copied from tests/integration/reliability/shop-express.test.ts)
 * rendered in every report format. ~7 s of experiment time.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PaymentsFake, startPaymentsFake } from "../../../examples/payments-fake/src/server.js";
import { type BuiltinFaultProxy, startFaultProxy } from "../../../src/adapters/faults/builtin-proxy.js";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import { createSafetyGuard } from "../../../src/core/safety/guard.js";
import { runReliability } from "../../../src/engines/reliability/index.js";
import type { ReliabilityData } from "../../../src/engines/reliability/types.js";
import { REPORT_FORMATS, renderReport, writeReports } from "../../../src/engines/reporting/index.js";
import { isReliabilityData } from "../../../src/engines/reporting/reliability.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let payments: PaymentsFake;
let proxy: BuiltinFaultProxy;
let shop: { url: string; close(): Promise<void> };
let result: EngineResult<ReliabilityData>;
let tmp: TmpDir;

beforeAll(async () => {
  payments = await startPaymentsFake();
  proxy = await startFaultProxy({ upstream: payments.url, name: "payments" });
  const m = await import("../../../examples/shop-express/src/server.js");
  shop = await m.start(0, { paymentsUrl: proxy.url, queryDelayMs: 1 });
  tmp = await makeTmpDir("sw-rel-report-");
  result = await runReliability(
    {
      target: shop.url,
      scenario: "dependency-5xx",
      dependency: "payments",
      workload: {
        rate: 5,
        routes: [
          {
            name: "orders",
            method: "POST",
            path: "/orders",
            headers: { authorization: "Bearer alice-token" },
            body: '{"items":[{"productId":{{rand 1 19}},"qty":1}]}',
            dependsOn: ["payments"],
          },
        ],
      },
      steady: "2s",
      duration: "2s",
      recovery: "3s",
      steadyState: ["http.error_rate < 5%"],
      hypothesis: ["http.error_rate < 50%"],
      seed: 5,
    },
    { safety: createSafetyGuard({}, { interactive: false, approve: true }) },
    { injectors: { payments: proxy } },
  );
}, 40_000);

afterAll(async () => {
  await shop?.close();
  await proxy?.close();
  await payments?.close();
  await tmp?.cleanup();
});

describe("Reliability Lab result rendered in every format (shop-express, dependency-5xx)", () => {
  it("the run produced real ReliabilityData with windows and the retry-storm detection", () => {
    expect(isReliabilityData(result.data)).toBe(true);
    const run = result.data!.runs[0]!;
    expect(run.windows.length).toBeGreaterThanOrEqual(5);
    expect(result.findings.map((f) => f.ruleId)).toContain("reliability/retry-without-backoff");
  });

  it("renders every format, never leaking the workload's bearer token", () => {
    for (const fmt of REPORT_FORMATS) {
      const out = renderReport([result], fmt, { color: false });
      expect(out.length, fmt).toBeGreaterThan(200);
      expect(out, fmt).not.toContain("alice-token");
    }
  });

  it("tty shows fault, timeline with marked fault window, verdicts, detectors", () => {
    const s = renderReport([result], "tty", { color: false });
    expect(s).toMatch(/scenario\s+dependency-5xx/);
    expect(s).toMatch(/injector\s+builtin/);
    expect(s).toContain("Experiment timeline");
    expect(s).toMatch(/error rate per second \S+/);
    expect(s).toMatch(/\^+ +fault window/);
    expect(s).toContain("Steady state & hypothesis");
    expect(s).toContain("http.error_rate < 5%");
    expect(s).toMatch(/retry amplification\s+│ FLAGGED/);
  });

  it("junit: conditions + 6 detectors; sarif: dependency logical location", () => {
    const xml = renderReport([result], "junit");
    expect([...xml.matchAll(/<testcase /g)]).toHaveLength(2 + 6);
    expect(xml).toMatch(/<failure message="\[high\] reliability\/retry-without-backoff"/);
    const sarif = JSON.parse(renderReport([result], "sarif"));
    const storm = (sarif.runs[0].results as any[]).find(
      (r) => r.ruleId === "reliability/retry-without-backoff",
    );
    expect(storm.locations[0].logicalLocations[0]).toEqual({
      name: "payments",
      fullyQualifiedName: "dependency:payments",
      kind: "resource",
    });
  });

  it("writeReports writes all file formats", async () => {
    const { files } = await writeReports([result], { formats: [...REPORT_FORMATS], outDir: tmp.path });
    expect(files).toHaveLength(5);
    expect(readFileSync(tmp.join("report.html"), "utf8")).toContain('<rect class="mark"');
  });
});
