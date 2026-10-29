/**
 * JUnit XML for CI test-report UIs. docs/03-engines/evidence-and-history.md §A.5:
 * thresholds become test cases; findings become test cases that fail when they are
 * failing at the configured --fail-on level. One <testsuite> per engine result.
 */
import type { EngineResult } from "../../core/evidence/schemas.js";
import { cellFailureSummary, cellOf, isBugsData, replayText, techniqueColumns } from "./bugs.js";
import { checkSummaries, DETECTOR_RULES, detectorSummaries, isReliabilityData, phaseLabel } from "./reliability.js";
import type { ExperimentData } from "../experiments/types.js";
import { fmtRel, isEvolutionData, isExperimentData } from "./experiments.js";
import { isModelData, isModelDiff } from "./model-render.js";
import { isAgentData, outcomeCell } from "./agent.js";
import { type CombinedReport, fmtThresholdValue, isFailingFinding, locationOf, sortFindings, thresholdsOf } from "./model.js";

// XML 1.0 allows #x9 #xA #xD #x20-#xD7FF #xE000-#xFFFD #x10000-#x10FFFF.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping invalid XML chars is the point
const INVALID_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Escape text for XML attribute or element content, dropping characters XML cannot represent. */
export function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function seconds(r: EngineResult): string {
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? (ms / 1000).toFixed(3) : "0.000";
}

interface Case {
  name: string;
  classname: string;
  failure?: { message: string; type: string; body: string };
  error?: { message: string; type: string };
  skipped?: string;
  out?: string;
}

function casesFor(r: EngineResult, failOn: CombinedReport["failOn"]): Case[] {
  const cases: Case[] = [];
  for (const t of thresholdsOf(r)) {
    const actual = fmtThresholdValue(t.actual, t.unit);
    const c: Case = { name: t.expression, classname: `${r.engine}.thresholds`, out: `actual: ${actual}` };
    if (!t.passed) {
      c.failure = {
        type: "threshold-breach",
        message: `${t.expression} failed: actual ${actual}`,
        body: `metric=${t.metric} op=${t.op} threshold=${t.threshold} unit=${t.unit} actual=${t.actual ?? "n/a"}${t.reason ? `\n${t.reason}` : ""}`,
      };
    }
    cases.push(c);
  }
  const bugs = isBugsData(r.data) ? r.data : undefined;
  if (bugs) {
    // API Bug Hunter: one test case per operation × technique. It fails only when a finding
    // for that cell is failing at --fail-on (lower-severity failures are reported in system-out),
    // so JUnit and the exit code agree.
    const byFp = new Map(r.findings.map((f) => [f.fingerprint, f]));
    for (const row of bugs.matrix) {
      for (const t of techniqueColumns(bugs)) {
        const cell = cellOf(row, t);
        if (!cell) continue;
        const name = `${row.operation} [${t}]`;
        const classname = `bugs.${t}`;
        if (cell.cases === 0) {
          cases.push({ name, classname, skipped: "no cases generated" });
          continue;
        }
        const related = bugs.findings.filter((f) => f.operation === row.operation && f.technique === t);
        const failing = related.filter((s) => {
          const f = byFp.get(s.fingerprint);
          return f ? isFailingFinding(f, failOn) : false;
        });
        const c: Case = { name, classname, out: cellFailureSummary(cell) };
        if (failing.length > 0) {
          c.failure = {
            type: failing[0]?.classification ?? "reproduced-defect",
            message: `${cell.failed} of ${cell.cases} case(s) failed: ${failing.map((f) => f.ruleId).join(", ")}`,
            body: failing.map((f) => `[${f.severity}] ${f.ruleId}: ${f.title} — ${replayText(f)}`).join("\n"),
          };
        } else if (cell.passed === 0 && cell.failed === 0 && cell.inconclusive > 0) {
          c.skipped = `inconclusive (${cell.inconclusive} case(s))`;
        } else if (related.length > 0) {
          c.out = `${cellFailureSummary(cell)}\nbelow fail-on: ${related.map((f) => `${f.ruleId} (${f.severity}, ${f.classification})`).join(", ")}`;
        }
        cases.push(c);
      }
    }
  }
  const rel = isReliabilityData(r.data) ? r.data : undefined;
  if (rel) {
    // Reliability Lab: one test case per steady-state / hypothesis condition, one per detector.
    for (const c of checkSummaries(rel)) {
      const tc: Case = {
        name: `${phaseLabel(c.phase)}: ${c.expression}`,
        classname: `reliability.${c.phase === "steady" ? "steady-state" : "hypothesis"}`,
        out: c.actuals.map((a) => `run ${a.run + 1}: actual ${a.actual} ${a.passed ? "ok" : "FAILED"}`).join("\n"),
      };
      if (!c.passed) {
        tc.failure = {
          type: c.phase === "steady" ? "steady-state-not-met" : "hypothesis-violated",
          message: `${c.expression} ${c.phase === "steady" ? "not met before injection" : "violated during the fault"}`,
          body: tc.out ?? "",
        };
      }
      cases.push(tc);
    }
    for (const s of detectorSummaries(rel)) {
      const tc: Case = { name: s.name, classname: "reliability.detectors", out: s.detail };
      if (!s.assessed) {
        tc.skipped = "not assessed in this scenario";
      } else {
        const failing = r.findings.filter((f) => DETECTOR_RULES[s.name].includes(f.ruleId ?? "") && isFailingFinding(f, failOn));
        if (failing.length > 0) {
          tc.failure = {
            type: failing[0]?.classification ?? "observation",
            message: failing.map((f) => `[${f.severity}] ${f.ruleId}`).join(", "),
            body: [s.detail, ...failing.map((f) => `${f.title}${f.recommendation ? ` — fix: ${f.recommendation}` : ""}`)].join("\n"),
          };
        } else if (s.flagged) {
          tc.out = `${s.detail}\n(flagged, but below fail-on '${failOn}')`;
        }
      }
      cases.push(tc);
    }
  }
  const evo = isEvolutionData(r.data) ? r.data : undefined;
  const exp = isExperimentData(r.data) ? r.data : evo?.experiment;
  if (evo) {
    // Evolution: one test case per candidate gate.
    for (const c of evo.candidates) {
      for (const g of c.gates) {
        const tc: Case = { name: `${c.name}: ${g.gate}${g.name && g.name !== g.gate ? ` (${g.name})` : ""}`, classname: `evolution.${c.name}`, out: g.detail ?? "" };
        if (g.skipped) tc.skipped = g.detail ?? "skipped";
        else if (!g.ok) tc.failure = { type: `gate-${g.gate}`, message: `${g.gate} gate failed`, body: [g.detail ?? "", ...c.rejectionReasons].filter(Boolean).join("\n") };
        cases.push(tc);
      }
    }
  }
  if (exp) cases.push(...experimentCases(exp));
  const agent = isAgentData(r.data) ? r.data : undefined;
  if (agent) {
    // Adversarial agent: one test case per hypothesis tried. Fails only when a finding it
    // produced is failing at --fail-on (a confirmed defect at/above the threshold).
    const byFp = new Map(r.findings.map((f) => [f.fingerprint, f]));
    for (const h of agent.hypotheses) {
      const outcome = outcomeCell(agent, h).text;
      const tc: Case = {
        name: `#${h.iteration} ${h.operation} × ${h.technique}: ${h.title}`,
        classname: `agent.${h.technique}`,
        out: `${h.hypothesis}\noutcome: ${outcome}${h.reason ? ` (${h.reason})` : ""}`,
      };
      const failing = h.failures.map((fp) => byFp.get(fp)).filter((f): f is NonNullable<typeof f> => f !== undefined && isFailingFinding(f, failOn));
      if (failing.length > 0) {
        tc.failure = {
          type: failing[0]?.classification ?? "reproduced-defect",
          message: `${outcome}: ${failing.map((f) => `[${f.severity}] ${f.ruleId}`).join(", ")}`,
          body: [h.hypothesis, ...failing.map((f) => f.title)].join("\n"),
        };
      } else if (h.outcome === "inconclusive") {
        tc.skipped = h.reason ?? "inconclusive";
      }
      cases.push(tc);
    }
  }
  for (const f of bugs || rel || exp || evo || agent ? [] : sortFindings(r.findings)) {
    // Threshold-breach findings duplicate the threshold test cases above when data carries them.
    if (f.classification === "threshold-breach" && thresholdsOf(r).length > 0) continue;
    const c: Case = { name: `[${f.severity}] ${f.title}`, classname: `${r.engine}.${f.category}`, out: f.description };
    if (isFailingFinding(f, failOn)) {
      c.failure = {
        type: f.classification,
        message: f.title,
        body: [f.description, locationOf(f) && `at ${locationOf(f)}`, f.recommendation && `fix: ${f.recommendation}`, `id=${f.id} fingerprint=${f.fingerprint}`]
          .filter(Boolean)
          .join("\n"),
      };
    }
    cases.push(c);
  }
  if (r.status === "error") cases.push({ name: "engine run", classname: `${r.engine}.engine`, error: { type: "engine-error", message: `${r.engine} engine errored` } });
  else if (r.status === "cancelled") cases.push({ name: "engine run", classname: `${r.engine}.engine`, skipped: "cancelled by user (partial results)" });
  else if (cases.length === 0) cases.push({ name: "engine run", classname: `${r.engine}.engine`, ...(r.status === "skipped" ? { skipped: "engine skipped" } : {}) });
  return cases;
}

/**
 * What-If: one test case per variant × success criterion (not met → failure, inconclusive →
 * skipped with the repetitions needed). Variants without criteria get one hypothesis case;
 * A/A runs get one case per metric (any significant difference fails).
 */
function experimentCases(d: ExperimentData): Case[] {
  const out: Case[] = [];
  if (d.mode === "aa") {
    for (const c of d.comparisons) {
      const tc: Case = { name: `A/A: ${c.metric}`, classname: "whatif.aa", out: `change ${fmtRel(c.relativeChange)}, CI [${fmtRel(c.ci.lower)}, ${fmtRel(c.ci.upper)}], p(Holm) ${c.pAdjusted}` };
      if (c.verdict === "improved" || c.verdict === "regressed") {
        tc.failure = { type: "aa-difference", message: `A/A run shows a significant ${c.verdict} difference on ${c.metric}`, body: c.reasons.join("\n") };
      }
      out.push(tc);
    }
    return out;
  }
  for (const v of d.verdicts) {
    const rows = d.comparisons.filter((c) => c.variant === v.variant && c.success);
    if (rows.length === 0) {
      const tc: Case = { name: `${v.variant}: hypothesis`, classname: `whatif.${v.variant}`, out: `improved: ${v.improved.join(", ") || "-"}; regressed: ${v.regressed.join(", ") || "-"}` };
      if (v.hypothesis === "rejected") tc.failure = { type: "hypothesis-rejected", message: `regressed: ${v.regressed.join(", ")}`, body: tc.out ?? "" };
      else if (v.hypothesis === "inconclusive") tc.skipped = `inconclusive: ${v.inconclusive.join(", ")}`;
      out.push(tc);
      continue;
    }
    for (const c of rows) {
      const s = c.success!;
      const tc: Case = {
        name: `${v.variant}: ${s.criterion}`,
        classname: `whatif.${v.variant}`,
        out: `${c.metric}: ${c.medians.baseline} → ${c.medians.variant} (${fmtRel(c.relativeChange)}), CI [${fmtRel(c.ci.lower)}, ${fmtRel(c.ci.upper)}], p(Holm) ${c.pAdjusted}, verdict ${c.verdict}`,
      };
      if (s.status === "not-met") tc.failure = { type: "success-criterion-not-met", message: s.detail, body: tc.out ?? "" };
      else if (s.status === "inconclusive") {
        tc.skipped = `inconclusive: ${s.detail}${c.recommendedRepetitions !== undefined ? ` (≈${c.recommendedRepetitions} runs/arm needed)` : ""}`;
      }
      out.push(tc);
    }
  }
  return out;
}

function renderCase(c: Case): string {
  const open = `    <testcase name="${xmlEscape(c.name)}" classname="${xmlEscape(c.classname)}"`;
  const inner: string[] = [];
  if (c.failure) inner.push(`      <failure message="${xmlEscape(c.failure.message)}" type="${xmlEscape(c.failure.type)}">${xmlEscape(c.failure.body)}</failure>`);
  if (c.error) inner.push(`      <error message="${xmlEscape(c.error.message)}" type="${xmlEscape(c.error.type)}"/>`);
  if (c.skipped !== undefined) inner.push(`      <skipped message="${xmlEscape(c.skipped)}"/>`);
  if (c.out) inner.push(`      <system-out>${xmlEscape(c.out)}</system-out>`);
  return inner.length === 0 ? `${open}/>` : `${open}>\n${inner.join("\n")}\n    </testcase>`;
}

export function renderJunit(report: CombinedReport): string {
  const suites: string[] = [];
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  for (const r of report.results) {
    // System Model output is descriptive (no pass/fail): no JUnit suite either.
    if (isModelData(r.data) || isModelDiff(r.data)) continue;
    const cases = casesFor(r, report.failOn);
    const f = cases.filter((c) => c.failure).length;
    const e = cases.filter((c) => c.error).length;
    const s = cases.filter((c) => c.skipped !== undefined).length;
    tests += cases.length;
    failures += f;
    errors += e;
    skipped += s;
    suites.push(
      `  <testsuite name="${xmlEscape(`second-world.${r.engine}`)}" tests="${cases.length}" failures="${f}" errors="${e}" skipped="${s}" time="${seconds(r)}" timestamp="${xmlEscape(r.startedAt)}">\n${cases.map(renderCase).join("\n")}\n  </testsuite>`,
    );
  }
  const time = (report.durationMs / 1000).toFixed(3);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xmlEscape(`second-world ${report.runId}`)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">\n${suites.join("\n")}\n</testsuites>\n`;
}
