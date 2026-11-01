import { describe, expect, it } from "vitest";
import type { Block } from "../../../src/engines/reporting/blocks.js";
import { renderBlocksHtml, svgSparkline } from "../../../src/engines/reporting/html.js";
import { renderBlocksMd } from "../../../src/engines/reporting/markdown.js";
import { renderBlocksTty, sparkline } from "../../../src/engines/reporting/tty.js";

// Regression (wave 7, sw-design7 report): `Math.min(...xs)` / `Math.max(...xs)` over per-tick
// series threw "RangeError: Maximum call stack size exceeded" above ~120k points (a long soak).
const N = 200_000;
const values = Array.from({ length: N }, (_, i) => (i % 1000) + (i === 12_345 ? 5000 : 0));
const block: Block = { kind: "spark", title: "rps", values, unit: "req/s" };

describe("spark rendering survives 200k-point series", () => {
  it("tty sparkline + block", () => {
    expect(sparkline(values)).toHaveLength(N);
    const out = renderBlocksTty([block], { color: false });
    expect(out).toContain("0..5345");
  });
  it("markdown block", () => {
    expect(renderBlocksMd([block]).join("\n")).toContain("(0..5345 req/s)");
  });
  it("html sparkline + block", () => {
    expect(svgSparkline(values, "rps")).toContain("<svg");
    expect(renderBlocksHtml([block])).toContain("0 .. 5345");
  });
});
