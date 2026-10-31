/**
 * Deterministic executive summary over engine results (`sw analyze`). Template-based: counts,
 * strongest classifications first, top findings, invalidating limitations. Never invents numbers:
 * everything comes from the results.
 */
import type { Classification, EngineResult, Finding, Severity } from "../../core/evidence/schemas.js";

export interface DeterministicSummary {
  headline: string;
  bullets: string[];
  /** headline + bullets as plain text. */
  text: string;
  counts: {
    runs: number;
    findings: number;
    bySeverity: Record<Severity, number>;
    byClassification: Partial<Record<Classification, number>>;
    statuses: Record<string, number>;
  };
  topFindings: { engine: string; title: string; severity: Severity; classification: Classification }[];
}

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const CLASS_RANK: Record<Classification, number> = {
  "verified-fix": 5,
  "reproduced-defect": 4,
  "threshold-breach": 3,
  observation: 2,
  "suspected-risk": 1,
  hypothesis: 0,
};

/** Report files are not schema-validated: an unknown severity/classification counts as the weakest. */
function sevOf(f: Finding): Severity {
  return SEV_ORDER.includes(f.severity) ? f.severity : "info";
}
function classOf(f: Finding): Classification {
  return f.classification in CLASS_RANK ? f.classification : "hypothesis";
}

function rank(f: Finding): number {
  return (5 - SEV_ORDER.indexOf(sevOf(f))) * 10 + CLASS_RANK[classOf(f)];
}

export function deterministicSummary(
  results: readonly EngineResult[],
  opts: { top?: number } = {},
): DeterministicSummary {
  const all = results
    .flatMap((r) => r.findings)
    .map((f) => ({ ...f, severity: sevOf(f), classification: classOf(f) }));
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  const byClassification: Partial<Record<Classification, number>> = {};
  for (const f of all) {
    bySeverity[f.severity]++;
    byClassification[f.classification] = (byClassification[f.classification] ?? 0) + 1;
  }
  const statuses: Record<string, number> = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const top = [...all]
    .sort((a, b) => rank(b) - rank(a) || a.title.localeCompare(b.title))
    .slice(0, opts.top ?? 5);
  const engines = [...new Set(results.map((r) => r.engine))].join(", ") || "none";

  const serious = bySeverity.critical + bySeverity.high;
  const headline =
    results.length === 0
      ? "No results to summarise."
      : all.length === 0
        ? `${results.length} run(s) (${engines}) produced no findings.`
        : `${results.length} run(s) (${engines}) produced ${all.length} finding(s)${serious > 0 ? `, ${serious} of severity high or critical` : ""}.`;

  const bullets: string[] = [];
  const sevText = SEV_ORDER.filter((s) => bySeverity[s] > 0)
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(", ");
  if (sevText) bullets.push(`Severity: ${sevText}.`);
  const classText = (Object.keys(CLASS_RANK) as Classification[])
    .sort((a, b) => CLASS_RANK[b] - CLASS_RANK[a])
    .filter((c) => (byClassification[c] ?? 0) > 0)
    .map((c) => `${byClassification[c]} ${c}`)
    .join(", ");
  if (classText) bullets.push(`Evidence strength: ${classText}.`);
  for (const f of top) bullets.push(`[${f.severity}] ${f.title} (${f.engine}, ${f.classification}).`);
  const statusText = Object.entries(statuses)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  if (statusText) bullets.push(`Run status: ${statusText}.`);
  for (const r of results) {
    for (const l of r.limitations) {
      if (l.impact === "invalidates") bullets.push(`Limitation (${r.engine}): ${l.message}`);
    }
  }
  return {
    headline,
    bullets,
    text: [headline, ...bullets.map((b) => `- ${b}`)].join("\n"),
    counts: { runs: results.length, findings: all.length, bySeverity, byClassification, statuses },
    topFindings: top.map((f) => ({
      engine: f.engine,
      title: f.title,
      severity: f.severity,
      classification: f.classification,
    })),
  };
}
