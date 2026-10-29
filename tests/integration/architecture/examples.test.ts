/**
 * Architecture Inspector vs. the seeded example apps (ground truth: examples/<app>/expected-findings.json,
 * entries with engine "architecture" or alsoDetectableBy ∋ "architecture"). Asserts full recall and
 * reports precision. Read-only on examples/: the cache goes to a temp dir.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../../../src/core/evidence/schemas.js";
import { inspectArchitecture } from "../../../src/engines/architecture/index.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

interface Defect {
  id: string;
  engine: string;
  alsoDetectableBy?: string[];
  location: { file: string; line: number };
}

function matches(f: Finding, d: Defect): boolean {
  const l = f.locations[0];
  if (!l || l.file !== d.location.file) return false;
  return d.location.line >= l.line - 3 && d.location.line <= (l.endLine ?? l.line) + 3;
}

const dirs: TmpDir[] = [];
afterAll(async () => {
  for (const d of dirs) await d.cleanup();
});

describe.each([
  ["shop-express", 5],
  ["shop-fastify", 3],
] as const)("%s", (app, expectedCount) => {
  const root = path.resolve("examples", app);
  const truth = (
    JSON.parse(readFileSync(path.join(root, "expected-findings.json"), "utf8")) as { defects: Defect[] }
  ).defects.filter((d) => d.engine === "architecture" || d.alsoDetectableBy?.includes("architecture"));

  it("finds every seeded architecture defect (recall = 1) and reports precision", async () => {
    expect(truth).toHaveLength(expectedCount);
    const r = await inspectArchitecture({ project: root, noCache: true });
    const missing = truth.filter((d) => !r.findings.some((f) => matches(f, d)));
    expect(missing.map((m) => m.id)).toEqual([]);
    const tp = r.findings.filter((f) => truth.some((d) => matches(f, d)));
    const precision = tp.length / Math.max(1, r.findings.length);
    console.info(
      `[sw-arch] ${app}: recall ${truth.length}/${truth.length}, precision ${tp.length}/${r.findings.length} = ${precision.toFixed(2)}; extra: ${
        r.findings
          .filter((f) => !tp.includes(f))
          .map((f) => `${f.ruleId} ${f.locations[0]?.file}:${f.locations[0]?.line}`)
          .join(", ") || "none"
      }`,
    );
    expect(precision).toBeGreaterThanOrEqual(0.8);
  });

  it("second run uses the cache, is faster, and returns identical results", async () => {
    const tmp = await makeTmpDir("sw-arch-cache-");
    dirs.push(tmp);
    const cacheDir = tmp.join("cache");
    const r1 = await inspectArchitecture({ project: root, cacheDir });
    const r2 = await inspectArchitecture({ project: root, cacheDir });
    expect(r1.data?.metrics.filesFromCache).toBe(0);
    expect(r2.data?.metrics.filesFromCache).toBe(r2.data?.metrics.files);
    expect(r2.data?.metrics.durationMs).toBeLessThan(r1.data?.metrics.durationMs ?? 0);
    const strip = (r: typeof r1) => ({
      findings: r.findings.map(({ id: _i, firstSeen: _f, lastSeen: _l, ...f }) => f),
      data: {
        ...JSON.parse(JSON.stringify(r.data)),
        metrics: { ...r.data?.metrics, durationMs: 0, analyzeMs: 0, filesFromCache: 0 },
      },
      limitations: r.limitations,
    });
    expect(strip(r2)).toEqual(strip(r1));
  });
});
