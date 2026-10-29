/**
 * Recall/precision of Bug Hunter findings against examples/<app>/expected-findings.json
 * (docs/12-testing-and-quality.md §3). A reproduced-defect finding is a true positive when its
 * ruleId equals the defect's ruleId and its operation is the defect endpoint (or alsoEndpoints).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../../src/core/evidence/schemas.js";

export interface ExpectedDefect {
  id: string;
  engine: string;
  ruleId: string;
  endpoint?: string;
  alsoEndpoints?: string[];
}

export function expectedBugs(app: string): ExpectedDefect[] {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "examples", app, "expected-findings.json"), "utf8"),
  ) as { defects: ExpectedDefect[] };
  return raw.defects.filter((d) => d.engine === "bugs");
}

function norm(ep: string): string {
  return ep.replace(/\?.*$/, "").trim();
}

export function score(
  app: string,
  findings: Finding[],
): { recall: number; precision: number; matched: string[]; missed: string[]; falsePositives: string[] } {
  const expected = expectedBugs(app);
  const defects = findings.filter((f) => f.classification === "reproduced-defect");
  const matched = new Set<string>();
  const fps: string[] = [];
  for (const f of defects) {
    const op = f.affected[0] ?? "";
    const hit = expected.find(
      (d) =>
        d.ruleId === f.ruleId &&
        [d.endpoint, ...(d.alsoEndpoints ?? [])].some((e) => e !== undefined && norm(e) === op),
    );
    if (hit) matched.add(hit.id);
    else fps.push(`${f.ruleId} ${op}: ${f.title}`);
  }
  const recall = expected.length === 0 ? 1 : matched.size / expected.length;
  const precision = defects.length === 0 ? 1 : (defects.length - fps.length) / defects.length;
  return {
    recall,
    precision,
    matched: [...matched],
    missed: expected.filter((d) => !matched.has(d.id)).map((d) => d.id),
    falsePositives: fps,
  };
}
