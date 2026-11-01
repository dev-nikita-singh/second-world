import { describe, expect, it } from "vitest";
import { renderReport } from "../../../src/engines/reporting/index.js";
import { makePerfData, makeResult } from "../../fixtures/reports.js";

// Regression (wave 7, sw-real7 journey): `sw perf` against GET / on an API printed the errors line
// as "status: 250" — the HTTP status code that failed was nowhere in the summary.
const sample = (status: number, tMs: number) => ({
  tMs,
  endpoint: "GET /",
  kind: "status",
  status,
  message: `unexpected status ${status}`,
});
const result = () =>
  makeResult({
    status: "failed",
    data: makePerfData({
      status: { "404": 240, "500": 10 },
      errors: [
        { kind: "status", count: 250 },
        { kind: "timeout", count: 3 },
      ],
      errorSamples: [sample(404, 5), sample(404, 9)],
      firstErrors: [sample(404, 1), sample(500, 7)],
    }),
  });

describe("perf errors name the failing status codes", () => {
  it.each(["tty", "md", "html"] as const)("%s", (fmt) => {
    const s = renderReport([result()], fmt, { color: false });
    expect(s).toContain("status (HTTP 404, 500)");
    expect(s).toContain("timeout");
  });
});
