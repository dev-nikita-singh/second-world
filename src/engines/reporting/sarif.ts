/**
 * SARIF 2.1.0 output for GitHub code scanning / IDEs.
 * docs/03-engines/evidence-and-history.md §A.5 (SARIF: architecture & security findings).
 *
 * One run per report (tool "SECOND WORLD"). Every finding becomes a result:
 *  - ruleId = finding.ruleId ?? "<engine>/<category>", rules listed in tool.driver.rules;
 *  - level from severity: critical/high → error, medium → warning, low/info → note;
 *  - code locations → physicalLocation (artifactLocation relative to %SRCROOT%, region);
 *    non-code findings (endpoints, model nodes) → logicalLocations;
 *  - partialFingerprints carry the stable SECOND WORLD fingerprint for deduplication.
 *
 * Findings classified "hypothesis" are INCLUDED, never as alerts: level is always "note", the
 * message is prefixed "[hypothesis]", and properties carry `hypothesis: true, verified: false`.
 * Including them keeps the SARIF a complete view of the report while code-scanning UIs, which
 * gate on error/warning, never block a PR on an unverified claim. Filter on
 * `properties.hypothesis` to drop them.
 */
import type { Finding, Severity, SourceLocation } from "../../core/evidence/schemas.js";
import type { BugFindingSummary } from "../bugs/types.js";
import { isAgentData } from "./agent.js";

/** Replay summary shared by Bug Hunter and agent findings. */
type ReplaySummary = Pick<BugFindingSummary, "operation" | "technique" | "failures" | "replays" | "flaky" | "wilson">;
import { isBugsData } from "./bugs.js";
import { type CombinedReport, sortFindings } from "./model.js";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

export type SarifLevel = "error" | "warning" | "note" | "none";

export function sarifLevel(s: Severity): SarifLevel {
  if (s === "critical" || s === "high") return "error";
  if (s === "medium") return "warning";
  return "note";
}

/** GitHub's numeric security-severity scale (0..10), used for its severity column. */
const SECURITY_SEVERITY: Record<Severity, string> = { critical: "9.5", high: "8.0", medium: "5.5", low: "3.0", info: "0.0" };

export function ruleIdOf(f: Finding): string {
  return f.ruleId ?? `${f.engine}/${f.category}`;
}

/** Normalise a location path to a relative POSIX URI (SARIF wants URIs, not Windows paths). */
export function toUri(file: string): string {
  const posix = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return posix
    .split("/")
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
}

function physical(l: SourceLocation): Record<string, unknown> {
  const region: Record<string, number> = { startLine: l.line };
  if (l.column !== undefined) region.startColumn = l.column;
  if (l.endLine !== undefined) region.endLine = l.endLine;
  const loc: Record<string, unknown> = {
    physicalLocation: { artifactLocation: { uri: toUri(l.file), uriBaseId: "%SRCROOT%" }, region },
  };
  if (l.symbol) loc.logicalLocations = [{ name: l.symbol, kind: "function" }];
  return loc;
}

/** A finding classified "hypothesis" is unverified. */
export function isHypothesisFinding(f: Finding): boolean {
  return f.classification === "hypothesis";
}

/** Effective SARIF level: hypotheses are always "note", whatever their severity. */
export function levelOf(f: Finding): SarifLevel {
  return isHypothesisFinding(f) ? "note" : sarifLevel(f.severity);
}

function result(f: Finding, bugsSummary?: ReplaySummary): Record<string, unknown> {
  const msg = [f.title, f.description].filter((s) => s && s.trim().length > 0).join(" — ");
  const hyp = isHypothesisFinding(f);
  const r: Record<string, unknown> = {
    ruleId: ruleIdOf(f),
    level: levelOf(f),
    message: { text: `${hyp ? "[hypothesis] " : ""}${msg || f.title}` },
    partialFingerprints: { "secondWorld/v1": f.fingerprint },
    properties: {
      severity: f.severity,
      classification: f.classification,
      engine: f.engine,
      category: f.category,
      confidence: f.confidence,
      status: f.status,
      findingId: f.id,
      ...(f.recommendation ? { recommendation: f.recommendation } : {}),
      ...(hyp ? { hypothesis: true, verified: false } : {}),
    },
  };
  if (f.locations.length > 0) r.locations = f.locations.map(physical);
  else if (f.affected.length > 0) {
    // Bug Hunter findings: the API operation ("GET /orders/{id}") is the logical location.
    r.locations = [{ logicalLocations: f.affected.map(logicalLocation) }];
  }
  if (bugsSummary) {
    const props = r.properties as Record<string, unknown>;
    props.operation = bugsSummary.operation;
    props.technique = bugsSummary.technique;
    props.replay = { failures: bugsSummary.failures, replays: bugsSummary.replays, flaky: bugsSummary.flaky, wilson: bugsSummary.wilson };
  }
  return r;
}

export function buildSarif(report: CombinedReport): Record<string, unknown> {
  const findings = sortFindings(report.results.flatMap((r) => r.findings));
  const bugIndex = new Map<string, ReplaySummary>();
  for (const r of report.results) {
    if (isBugsData(r.data)) for (const s of r.data.findings) bugIndex.set(s.fingerprint, s);
    else if (isAgentData(r.data)) for (const s of r.data.findings) bugIndex.set(s.fingerprint, s);
  }
  const rules = new Map<string, Record<string, unknown>>();
  for (const f of findings) {
    const id = ruleIdOf(f);
    const existing = rules.get(id);
    // keep the most severe default level for the rule
    const level = levelOf(f);
    if (existing) {
      const cur = (existing.defaultConfiguration as { level: SarifLevel }).level;
      if (level === "error" || (level === "warning" && cur === "note")) existing.defaultConfiguration = { level };
      continue;
    }
    rules.set(id, {
      id,
      name: id.replace(/[^A-Za-z0-9]+/g, " ").trim().replace(/\s+(\w)/g, (_m, ch: string) => ch.toUpperCase()),
      shortDescription: { text: f.title },
      defaultConfiguration: { level },
      properties: {
        tags: [f.engine, f.category, ...(f.category === "security" ? ["security"] : [])],
        ...(f.category === "security" ? { "security-severity": SECURITY_SEVERITY[f.severity] } : {}),
      },
    });
  }
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "SECOND WORLD",
            semanticVersion: /^\d+\.\d+\.\d+/.test(report.toolVersion) ? report.toolVersion : undefined,
            version: report.toolVersion,
            rules: [...rules.values()],
          },
        },
        // No absolute uri: consumers (GitHub, IDEs) resolve %SRCROOT% to the checkout root.
        originalUriBaseIds: { "%SRCROOT%": { description: { text: "Project root; result paths are relative to it" } } },
        automationDetails: { id: `second-world/${report.runId}` },
        invocations: [
          {
            executionSuccessful: report.results.every((r) => r.status !== "error"),
            ...(report.startedAt ? { startTimeUtc: report.startedAt } : {}),
            ...(report.endedAt ? { endTimeUtc: report.endedAt } : {}),
            ...(report.command ? { commandLine: report.command } : {}),
          },
        ],
        results: findings.map((f) => result(f, bugIndex.get(f.fingerprint))),
        properties: { verdict: report.verdict, failOn: report.failOn },
      },
    ],
  };
}

export function renderSarif(report: CombinedReport): string {
  return `${JSON.stringify(buildSarif(report), null, 2)}\n`;
}

/**
 * Logical location for a non-code target: an API operation / route ("POST /orders") or a
 * dependency ("dependency:payments" → name "payments"). Both are SARIF kind "resource".
 */
export function logicalLocation(target: string): { name: string; fullyQualifiedName: string; kind: "resource" } {
  const m = /^(dependency|service|node):(.+)$/.exec(target);
  return { name: m ? (m[2] ?? target) : target, fullyQualifiedName: target, kind: "resource" };
}
