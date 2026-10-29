/**
 * Evidence & Reporting entry points. docs/03-engines/evidence-and-history.md §A.4–A.6.
 *
 *   renderReport(results | report, "tty" | "json" | "md" | "junit", opts?) → string
 *   writeReports(results, { formats, outDir, failOn?, baseName?, meta? })   → files written atomically
 *   computeExitCode(results, failOn?)                                      → 0 | 1 | 70 | 130
 */
import path from "node:path";
import type { EngineResult } from "../../core/evidence/schemas.js";
import { renderJson, writeFileAtomic } from "./json.js";
import { renderJunit } from "./junit.js";
import { renderMarkdown } from "./markdown.js";
import { type CombinedReport, type FailOn, type ReportFormat, type ReportMeta, toReport } from "./model.js";
import { renderBlocksTty, renderTty } from "./tty.js";
import type { RunComparison } from "../history/types.js";
import type { ModelDiff } from "../model/diff.js";
import { modelDiffBlocks } from "./model-render.js";
import { comparisonBlocks } from "./blocks.js";
import { renderBlocksHtml, renderHtml } from "./html.js";
import { renderBlocksMd } from "./markdown.js";
import { renderSarif } from "./sarif.js";

export {
  type Block,
  comparisonBlocks,
  isRunComparison,
  isStressData,
  perfBlocks,
  stressBlocks,
} from "./blocks.js";
export { htmlEscape, renderBlocksHtml, renderHtml, svgSparkline } from "./html.js";
export { buildSarif, renderSarif, SARIF_SCHEMA, sarifLevel } from "./sarif.js";
export { asciiFold, renderBlocksTty, sparkline } from "./tty.js";
export { renderBlocksMd } from "./markdown.js";
export { bugsBlocks, isBugsData, replayText, scrubSecrets } from "./bugs.js";
export { checkSummaries, detectorSummaries, isReliabilityData, reliabilityBlocks } from "./reliability.js";
export { evolutionBlocks, experimentBlocks, isEvolutionData, isExperimentData } from "./experiments.js";
export { dataBlocks } from "./dispatch.js";
export { isModelData, isModelDiff, modelBlocks, modelDiffBlocks } from "./model-render.js";
export { agentBlocks, isAgentData } from "./agent.js";
export { isHypothesisFinding, levelOf, logicalLocation } from "./sarif.js";

export { computeExitCode, exitCodeForError, FAIL_ON_VALUES, isFailOn } from "./exit-code.js";
export { renderJson, writeFileAtomic, writeJsonReport } from "./json.js";
export { renderJunit, xmlEscape } from "./junit.js";
export { mdEscape, renderMarkdown } from "./markdown.js";
export {
  type CombinedReport,
  combineResults,
  computeVerdict,
  DEFAULT_FAIL_ON,
  type FailOn,
  isCombinedReport,
  isFailingFinding,
  isPerformanceData,
  REPORT_FORMATS,
  type ReportFormat,
  type ReportMeta,
  sortFindings,
  toReport,
  type Verdict,
} from "./model.js";
export { renderTty, resolveAscii, resolveColor, type TtyOptions } from "./tty.js";

export interface RenderOptions {
  failOn?: FailOn;
  meta?: ReportMeta;
  /** tty only: force colour on/off (default: auto from NO_COLOR/FORCE_COLOR/isTTY). */
  color?: boolean;
  /** tty only: ASCII-only output. */
  ascii?: boolean;
}

/** Render a report in one format. Pure: no I/O. */
export function renderReport(
  input: EngineResult | readonly EngineResult[] | CombinedReport,
  format: ReportFormat,
  opts: RenderOptions = {},
): string {
  const report = toReport(input, opts.meta, opts.failOn);
  switch (format) {
    case "json":
      return renderJson(report);
    case "md":
      return renderMarkdown(report);
    case "junit":
      return renderJunit(report);
    case "sarif":
      return renderSarif(report);
    case "html":
      return renderHtml(report);
    case "tty":
      return renderTty(report, {
        ...(opts.color !== undefined ? { color: opts.color } : {}),
        ...(opts.ascii !== undefined ? { ascii: opts.ascii } : {}),
      });
    default: {
      const never: never = format;
      throw new Error(`unknown report format: ${String(never)}`);
    }
  }
}

const EXT: Record<Exclude<ReportFormat, "tty">, string> = {
  json: ".json",
  md: ".md",
  junit: ".junit.xml",
  sarif: ".sarif",
  html: ".html",
};

/**
 * Render a System Model diff (`sw model diff`) on its own; json = the ModelDiff as-is.
 */
export function renderModelDiff(diff: ModelDiff, format: "tty" | "json" | "md" | "html", opts: { color?: boolean; ascii?: boolean } = {}): string {
  const blocks = modelDiffBlocks(diff);
  switch (format) {
    case "json":
      return `${JSON.stringify(diff, null, 2)}\n`;
    case "md":
      return `${["## SECOND WORLD — system model diff", "", ...renderBlocksMd(blocks)].join("\n").trimEnd()}\n`;
    case "html":
      return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="color-scheme" content="light dark">\n<title>SECOND WORLD model diff</title>\n</head>\n<body>\n<h1>System model diff</h1>\n${renderBlocksHtml(blocks)}\n</body>\n</html>\n`;
    case "tty":
      return renderBlocksTty(blocks, opts);
    default: {
      const never: never = format;
      throw new Error(`unknown model diff format: ${String(never)}`);
    }
  }
}

/**
 * Render a history comparison (`sw history diff`) on its own.
 * json = the RunComparison as-is; md/tty/html use the same blocks as in combined reports.
 */
export function renderComparison(
  cmp: RunComparison,
  format: "tty" | "json" | "md" | "html",
  opts: { color?: boolean; ascii?: boolean } = {},
): string {
  const blocks = comparisonBlocks(cmp);
  switch (format) {
    case "json":
      return `${JSON.stringify(cmp, null, 2)}\n`;
    case "md":
      return `${["## SECOND WORLD — history comparison", "", ...renderBlocksMd(blocks)].join("\n").trimEnd()}\n`;
    case "html":
      return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="color-scheme" content="light dark">\n<title>SECOND WORLD history comparison</title>\n</head>\n<body>\n<h1>History comparison</h1>\n${renderBlocksHtml(blocks)}\n</body>\n</html>\n`;
    case "tty":
      return renderBlocksTty(blocks, opts);
    default: {
      const never: never = format;
      throw new Error(`unknown comparison format: ${String(never)}`);
    }
  }
}

export interface WriteReportsOptions {
  formats: readonly ReportFormat[];
  outDir: string;
  failOn?: FailOn;
  /** File base name (default "report") → report.json, report.md, report.junit.xml. */
  baseName?: string;
  meta?: ReportMeta;
}

export interface WrittenReports {
  report: CombinedReport;
  files: { format: Exclude<ReportFormat, "tty">; path: string }[];
}

/** Write file formats atomically into outDir. "tty" is skipped (print renderReport(..., "tty") yourself). */
export async function writeReports(
  input: EngineResult | readonly EngineResult[] | CombinedReport,
  opts: WriteReportsOptions,
): Promise<WrittenReports> {
  const report = toReport(input, opts.meta, opts.failOn);
  const base = opts.baseName ?? "report";
  const files: WrittenReports["files"] = [];
  const unique = [...new Set(opts.formats)];
  for (const format of unique) {
    if (format === "tty") continue;
    const file = path.join(opts.outDir, `${base}${EXT[format]}`);
    await writeFileAtomic(file, renderReport(report, format));
    files.push({ format, path: file });
  }
  return { report, files };
}
