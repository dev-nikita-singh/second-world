/**
 * What-If ground truth: shop-fastify seeded slow search (41 queries) vs the FIXED=1 variant (1 query).
 * Each run starts the app in its own process (node --import tsx, PORT injected), r = 5, interleaved.
 * A/A on the calibrated child server → no-significant-change.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExperiment } from "../../../src/engines/experiments/index.js";
import {
  type ChildCalibratedServer,
  startCalibratedServerInChild,
} from "../../fixtures/servers/calibrated-child.js";
import { REPO_ROOT } from "../../helpers/cli.js";

const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const SHOP = path.join(REPO_ROOT, "examples", "shop-fastify", "src", "server.ts");

describe("What-If on shop-fastify", () => {
  it("FIXED=1 search is improved vs the seeded slow search (CI excludes 0)", async () => {
    const res = await runExperiment({
      name: "shop-fastify-search-fix",
      hypothesis: "Indexed search lowers p95 of /products/search by ≥ 15%",
      baseline: {
        start: [process.execPath, "--import", TSX_LOADER, SHOP],
        cwd: REPO_ROOT,
        env: { FIXED: "0" },
        readyWhen: { path: "/healthz", timeout: "20s", interval: 100 },
      },
      variants: [
        {
          name: "fixed",
          env: { FIXED: "1" },
          readyWhen: { path: "/healthz", bodyContains: '"fixed"', timeout: "20s", interval: 100 },
        },
      ],
      workload: {
        vus: 4,
        duration: "1500ms",
        warmup: "500ms",
        scenarios: [{ name: "search", steps: [{ path: "/products/search", query: { q: "red" } }] }],
      },
      metrics: ["p50", "p95", "rps", "error_rate"],
      success: { p95: { improvement: ">= 15%" }, error_rate: { notWorse: true } },
      // 4 metrics → Holm steps at p < 0.0125 / 0.0167 / 0.025. With 5 or 7 runs per arm, ONE stalled variant
      // run on a starved 3-vCPU macOS runner was enough to make p95 "inconclusive" (seen at 7 runs: -95.7%,
      // CI [-96.1, -94.8], pHolm 0.052). With 10 runs per arm a single outlier still gives pHolm ≈ 0.01.
      design: { repetitions: 10, order: "interleaved", seed: 7 },
    });
    const d = res.data!;
    console.log(
      d.comparisons
        .map(
          (c) =>
            `${c.metric}: ${c.verdict} ${(c.relativeChange * 100).toFixed(1)}% CI [${(c.ci.lower * 100).toFixed(1)}, ${(c.ci.upper * 100).toFixed(1)}] pHolm=${c.pAdjusted.toPrecision(2)} base=${c.medians.baseline.toFixed(2)} var=${c.medians.variant.toFixed(2)}`,
        )
        .join("\n"),
    );
    expect(d.runs.filter((r) => r.status === "ok")).toHaveLength(20);
    expect(d.runs.map((r) => r.arm).slice(0, 4)).toEqual(["baseline", "fixed", "fixed", "baseline"]);
    const p95 = d.comparisons.find((c) => c.metric === "p95")!;
    expect(p95.verdict).toBe("improved");
    expect(p95.ci.upper).toBeLessThan(0);
    expect(p95.success?.status).toBe("met");
    expect(d.comparisons.find((c) => c.metric === "rps")!.verdict).toBe("improved");
    expect(d.verdicts[0]!.hypothesis).toBe("supported");
    expect(res.status).toBe("passed");
    expect(d.arms.every((a) => a.fingerprint !== null)).toBe(true);
  }, 180_000);
});

describe("What-If A/A on the calibrated child server", () => {
  let srv: ChildCalibratedServer;
  beforeAll(async () => {
    srv = await startCalibratedServerInChild();
  });
  afterAll(async () => {
    await srv?.close();
  });

  it("baseline vs itself → the A/A contract holds; small MDE when equivalence is shown", async () => {
    const res = await runExperiment({
      name: "aa-fixed-20",
      mode: "aa",
      baseline: { target: srv.url },
      workload: {
        vus: 4,
        duration: "1s",
        warmup: "300ms",
        scenarios: [{ name: "f", steps: [{ path: "/fixed/20" }] }],
      },
      metrics: ["p50", "p95"],
      design: { repetitions: 6, order: "randomized-blocks", seed: 11 },
    });
    const d = res.data!;
    console.log(d.noiseFloor);
    // An A/A run tests the ENVIRONMENT. Identical arms compared at alpha 0.05 (Holm) can legitimately differ
    // when load changes over seconds (seen once as "regressed" on ubuntu Node 22 under the full parallel
    // suite). What must always hold is the contract: a difference fails the run with the invalidating
    // WHATIF-AA-DIFFERENCE limitation; no difference passes it. Tight-noise claims only when equivalence was shown.
    const differs = d.comparisons.some((c) => c.verdict === "improved" || c.verdict === "regressed");
    const aaLimitation = res.limitations.find((l) => l.code === "WHATIF-AA-DIFFERENCE");
    if (differs) {
      expect(res.status).toBe("failed");
      expect(aaLimitation?.impact).toBe("invalidates");
      return;
    }
    expect(aaLimitation).toBeUndefined();
    for (const c of d.comparisons) expect(["no-significant-change", "inconclusive"]).toContain(c.verdict);
    if (d.comparisons.every((c) => c.verdict === "no-significant-change")) {
      // What the verdict guarantees: every bootstrap CI lies within the ±5% equivalence margin.
      for (const c of d.comparisons) {
        expect(c.ci.lower).toBeGreaterThanOrEqual(-0.05);
        expect(c.ci.upper).toBeLessThanOrEqual(0.05);
      }
      // The MDE is a separate parametric estimate and can sit slightly above the margin while the CI fits
      // (5.8% for p95 on a shared macOS CI runner); a noise floor this small is still the point.
      expect(d.noiseFloor!.every((n) => n.mde < 0.1)).toBe(true);
    }
    expect(res.status).toBe("passed");
  }, 60_000);
});
