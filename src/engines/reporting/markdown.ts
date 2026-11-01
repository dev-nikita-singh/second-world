/**
 * Markdown report for PR comments and the GitHub job summary ($GITHUB_STEP_SUMMARY).
 * docs/03-engines/evidence-and-history.md §A.4–A.5. GitHub-flavoured tables, no HTML
 * except <details> blocks for long appendices.
 */

import type { EngineResult } from "../../core/evidence/schemas.js";
import type { PerformanceData } from "../performance/types.js";
import { type Block, cellText, finiteRange, isStressData, perfErrorKindLabel } from "./blocks.js";
import { dataBlocks } from "./dispatch.js";
import { isEvolutionData, isExperimentData } from "./experiments.js";
import {
  type CombinedReport,
  fmtDuration,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtThresholdValue,
  isFailingFinding,
  isPerformanceData,
  locationOf,
  sortFindings,
  thresholdsOf,
} from "./model.js";
import { isReliabilityData } from "./reliability.js";
import { sparkline } from "./tty.js";

/** Escape text for a GFM table cell / inline context. */
export function mdEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[<>]/g, (ch) => (ch === "<" ? "&lt;" : "&gt;"))
    .replace(/([*_`[\]])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

/** Inline code span safe inside a GFM table cell (backslash escapes are not processed in code). */
export function mdCode(s: string): string {
  // GFM still splits table cells on "|" inside code spans; "\|" is the documented escape there.
  const text = s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const fence = text.includes("`") ? "``" : "`";
  return `${fence}${fence === "``" ? ` ${text} ` : text}${fence}`;
}

function table(head: string[], rows: string[][], align?: ("l" | "r")[]): string {
  const sep = head.map((_, i) => ((align?.[i] ?? "l") === "r" ? "---:" : "---"));
  return [
    `| ${head.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function perfSection(d: PerformanceData, out: string[]): void {
  const t = d.totals;
  const L = d.latency;
  out.push(
    `Target ${mdCode(d.target)} · model **${d.model}** · measured ${fmtDuration(d.window.measuredMs)} · stop: ${d.window.stopReason}`,
    "",
    table(
      ["", "requests", "rps", "error rate", "p50", "p95", "p99", "max"],
      [
        [
          "corrected",
          String(t.requests),
          fmtNum(t.rps),
          fmtPct(t.errorRate),
          fmtMs(L.corrected.p50),
          fmtMs(L.corrected.p95),
          fmtMs(L.corrected.p99),
          fmtMs(L.corrected.max),
        ],
        ["raw", "", "", "", fmtMs(L.raw.p50), fmtMs(L.raw.p95), fmtMs(L.raw.p99), fmtMs(L.raw.max)],
      ],
      ["l", "r", "r", "r", "r", "r", "r", "r"],
    ),
    "",
  );
  if (d.endpoints.length > 0) {
    const rows = [...d.endpoints]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((e) => [
        `${mdCode(e.key)}`,
        String(e.requests),
        fmtNum(e.rps),
        fmtPct(e.errorRate),
        fmtMs(e.latency.corrected.p50),
        fmtMs(e.latency.corrected.p95),
        fmtMs(e.latency.corrected.p99),
      ]);
    out.push(
      table(["endpoint", "requests", "rps", "errors", "p50", "p95", "p99"], rows, [
        "l",
        "r",
        "r",
        "r",
        "r",
        "r",
        "r",
      ]),
      "",
    );
  }
  if (d.errors.length > 0) {
    const rows = d.errors.map((e) => [mdEscape(perfErrorKindLabel(d, e.kind)), String(e.count)]);
    out.push(table(["error", "count"], rows, ["l", "r"]), "");
  }
  if (d.generator.saturated) {
    out.push(
      `> **Warning:** load generator saturated: ${mdEscape((d.generator.reasons ?? []).join("; "))}`,
      "",
    );
  }
}

/** Render format-neutral blocks (stress, history comparison) as GFM. */
export function renderBlocksMd(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        out.push(`${"#".repeat(b.level + 1)} ${mdEscape(b.text)}`, "");
        break;
      case "kv":
        out.push(
          table(
            ["", ""],
            b.items.map(([k, v]) => [`**${mdEscape(k)}**`, mdEscape(cellText(v))]),
          ),
          "",
        );
        break;
      case "table":
        if (b.title) out.push(`**${mdEscape(b.title)}**`, "");
        out.push(
          table(
            b.head.map(mdEscape),
            b.rows.map((r) => r.map((c) => mdEscape(cellText(c)))),
            b.align,
          ),
          "",
        );
        break;
      case "text":
        out.push(
          b.tone === "warn" || b.tone === "bad"
            ? `> **Warning:** ${mdEscape(b.text)}`
            : b.tone === "muted"
              ? `_${mdEscape(b.text)}_`
              : mdEscape(b.text),
          "",
        );
        break;
      case "quote":
        // verbatim statement: escaped only so Markdown cannot reinterpret it
        out.push(`**${mdEscape(b.title)}**`, "", `> ${mdEscape(b.text)}`, "");
        break;
      case "spark": {
        const r = finiteRange(b.values);
        if (r === null) break;
        const mark =
          b.mark && b.mark.to > b.mark.from
            ? ` — ${mdEscape(b.mark.label)}: windows ${b.mark.from + 1}–${b.mark.to} of ${b.values.length}`
            : "";
        out.push(
          `${mdEscape(b.title)}: ${sparkline(b.values)} (${fmtNum(r.lo, 1)}..${fmtNum(r.hi, 1)} ${mdEscape(b.unit)})${mark}`,
          "",
        );
        break;
      }
      case "code": {
        // fence longer than any backtick run inside the content
        const longest = Math.max(
          2,
          ...b.lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((m) => m.length))),
        );
        const fence = "`".repeat(longest + 1);
        out.push(mdEscape(b.title), "", `${fence}${b.lang ?? ""}`, ...b.lines, fence, "");
        break;
      }
    }
  }
  return out;
}

function engineSection(r: EngineResult, failOn: CombinedReport["failOn"], out: string[]): void {
  out.push(`### ${r.engine} — ${r.status}`, "");
  if (isPerformanceData(r.data)) perfSection(r.data, out);
  else {
    const blocks = dataBlocks(r);
    if (blocks) out.push(...renderBlocksMd(blocks));
  }
  const ths = thresholdsOf(r);
  if (ths.length > 0) {
    out.push(
      table(
        ["", "threshold", "actual"],
        ths.map((t) => [
          t.passed ? "✅" : "❌",
          `${mdCode(t.expression)}`,
          fmtThresholdValue(t.actual, t.unit),
        ]),
        ["l", "l", "r"],
      ),
      "",
    );
  }
  if (r.findings.length > 0) {
    const rows = sortFindings(r.findings).map((f) => [
      isFailingFinding(f, failOn) ? "❌" : "",
      f.severity,
      f.classification,
      mdEscape(f.title),
      locationOf(f) ? `${mdCode(locationOf(f))}` : "",
    ]);
    out.push(
      `**Findings (${r.findings.length})**`,
      "",
      table(["", "severity", "class", "finding", "where"], rows),
      "",
    );
  }
  if (r.limitations.length > 0) {
    out.push("**Limitations**", "");
    for (const l of r.limitations) out.push(`- ${mdEscape(l.message)} (${mdCode(l.code)}, ${l.impact})`);
    out.push("");
  }
}

/** Methods appendix entries from engine payloads that carry them (perf, stress). */
export function methodsOf(report: CombinedReport): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const r of report.results) {
    if (isPerformanceData(r.data)) out.push({ ...r.data.methods });
    else if (isStressData(r.data)) out.push({ ...r.data.methods });
    else if (isReliabilityData(r.data)) out.push({ ...r.data.methods });
    else if (isEvolutionData(r.data)) out.push({ ...r.data.methods });
    else if (isExperimentData(r.data)) out.push({ ...r.data.methods });
  }
  return out;
}

export function renderMarkdown(report: CombinedReport): string {
  const v = report.verdict;
  const out: string[] = [];
  out.push(`## SECOND WORLD — ${v.passed ? "✅ PASS" : "❌ FAIL"}`, "");
  out.push(`${v.reasons.map(mdEscape).join("; ")}`, "");
  out.push(
    table(
      ["run", "status", "duration", "exit code", "fail-on", "version"],
      [
        [
          `${mdCode(report.runId)}`,
          report.status,
          fmtDuration(report.durationMs),
          String(v.exitCode),
          report.failOn,
          mdEscape(report.toolVersion),
        ],
      ],
    ),
    "",
  );
  for (const r of report.results) engineSection(r, report.failOn, out);

  const methods = methodsOf(report);
  if (methods.length > 0 || report.command) {
    out.push("<details><summary>Methods &amp; reproduction</summary>", "");
    if (report.command) out.push(`Reproduce: ${mdCode(report.command)}`, "");
    for (const m of methods) {
      for (const [k, val] of Object.entries(m)) out.push(`- **${mdEscape(k)}**: ${mdEscape(String(val))}`);
    }
    out.push("", "</details>", "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
