/**
 * Single self-contained HTML report. docs/03-engines/evidence-and-history.md §A.4–A.5.
 *
 * - One file: inline CSS, inline SVG sparklines, NO scripts and NO external requests
 *   (no <link>, no src/href to the network, no url(), no @import).
 * - Every piece of report content goes through `htmlEscape`.
 * - Light and dark themes via `prefers-color-scheme`.
 */
import { dataBlocks } from "./dispatch.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import {
  type Block,
  type CellLike,
  cellText,
  cellTone,
  perfBlocks,
} from "./blocks.js";
import { methodsOf } from "./markdown.js";
import {
  type CombinedReport,
  fmtDuration,
  fmtNum,
  fmtThresholdValue,
  isFailingFinding,
  isPerformanceData,
  locationOf,
  sortFindings,
  thresholdsOf,
} from "./model.js";

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const e = htmlEscape;

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--panel:#f6f8fa;--good:#1a7f37;--bad:#cf222e;--warn:#9a6700;--accent:#0969da}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--panel:#161b22;--good:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}h2{font-size:18px;margin:24px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}h3{font-size:15px;margin:16px 0 6px}
.meta{color:var(--muted)}
.verdict{display:inline-block;padding:2px 10px;border-radius:12px;font-weight:600;color:#fff}
.verdict.pass{background:var(--good)}.verdict.fail{background:var(--bad)}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;margin:6px 0 12px;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top}
th{background:var(--panel)}td.r,th.r{text-align:right}
table.kv th{font-weight:normal;color:var(--muted);background:transparent}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}
.note{padding:6px 10px;border-left:3px solid var(--border);background:var(--panel);margin:8px 0}
.note.warn{border-left-color:var(--warn)}.note.bad{border-left-color:var(--bad)}
blockquote.statement{margin:6px 0 12px;padding:8px 12px;border-left:4px solid var(--accent);background:var(--panel);font-weight:600}
figure.spark{margin:6px 0 12px}figure.spark figcaption{color:var(--muted);font-size:12px}
svg.spark polyline{fill:none;stroke:var(--accent);stroke-width:1.5}
svg.spark rect.mark{fill:var(--warn);opacity:.18}
section.estimate{border:1px dashed var(--border);padding:4px 12px;margin:8px 0}
details{margin:12px 0}
pre{background:var(--panel);border:1px solid var(--border);padding:8px;overflow-x:auto;font-size:12px}
`;

/** Inline SVG sparkline (no scripts, no external resources). */
export function svgSparkline(
  values: readonly number[],
  title: string,
  w = 240,
  h = 40,
  mark?: { from: number; to: number; label: string },
): string {
  const pts = values.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return "";
  const ys = pts.map(([, v]) => v);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const n = values.length - 1;
  const xOf = (i: number): number => (n === 0 ? 0 : (i / n) * (w - 4) + 2);
  let band = "";
  if (mark && mark.to > mark.from) {
    // shade from the first marked point to the point after the last marked one (window boundaries)
    const x0 = xOf(mark.from);
    const x1 = xOf(Math.min(mark.to, n));
    band = `<rect class="mark" x="${x0.toFixed(1)}" y="0" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${h}"><title>${e(mark.label)}</title></rect>`;
  }
  const coords = pts
    .map(([i, v]) => {
      const x = xOf(i);
      const y = hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${e(title)}"><title>${e(title)}</title>${band}<polyline points="${coords}"/></svg>`;
}

function td(c: CellLike, align?: "l" | "r"): string {
  const cls = [cellTone(c), align === "r" ? "r" : undefined].filter(Boolean).join(" ");
  return `<td${cls ? ` class="${cls}"` : ""}>${e(cellText(c))}</td>`;
}

function htmlTable(head: string[], rows: CellLike[][], align?: ("l" | "r")[], cls?: string): string {
  const th = head.map((h, i) => `<th${align?.[i] === "r" ? ' class="r"' : ""}>${e(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c, i) => td(c, align?.[i])).join("")}</tr>`).join("\n");
  return `<div class="scroll"><table${cls ? ` class="${cls}"` : ""}><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

export function renderBlocksHtml(blocks: readonly Block[]): string {
  const out: string[] = [];
  let inEstimate = false;
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        if (inEstimate) out.push("</section>");
        inEstimate = /estimate/i.test(b.text);
        if (inEstimate) out.push('<section class="estimate">');
        out.push(`<h${b.level + 1}>${e(b.text)}</h${b.level + 1}>`);
        break;
      case "kv":
        out.push(
          `<div class="scroll"><table class="kv"><tbody>${b.items.map(([k, v]) => `<tr><th scope="row">${e(k)}</th>${td(v)}</tr>`).join("")}</tbody></table></div>`,
        );
        break;
      case "table":
        if (b.title) out.push(`<h4>${e(b.title)}</h4>`);
        out.push(htmlTable(b.head, b.rows, b.align));
        break;
      case "text":
        out.push(`<p class="note${b.tone ? ` ${b.tone}` : ""}">${e(b.text)}</p>`);
        break;
      case "quote":
        out.push(`<h4>${e(b.title)}</h4>`, `<blockquote class="statement">${e(b.text)}</blockquote>`);
        break;
      case "code":
        out.push(`<p class="muted">${e(b.title)}</p><pre><code>${b.lines.map(e).join("\n")}</code></pre>`);
        break;
      case "spark": {
        const svg = svgSparkline(b.values, b.title, 240, 40, b.mark);
        if (!svg) break;
        const xs = b.values.filter((v) => Number.isFinite(v));
        const markNote = b.mark && b.mark.to > b.mark.from ? ` · shaded: ${e(b.mark.label)}` : "";
        out.push(
          `<figure class="spark">${svg}<figcaption>${e(b.title)}: ${e(fmtNum(Math.min(...xs), 1))} .. ${e(fmtNum(Math.max(...xs), 1))} ${e(b.unit)}${markNote}</figcaption></figure>`,
        );
        break;
      }
    }
  }
  if (inEstimate) out.push("</section>");
  return out.join("\n");
}

function engineSection(r: EngineResult, failOn: CombinedReport["failOn"]): string {
  const out: string[] = [];
  const dur = fmtDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt));
  out.push(`<section class="engine"><h2>${e(r.engine)} <span class="meta">${e(r.status)} · ${e(dur)}</span></h2>`);
  if (isPerformanceData(r.data)) out.push(renderBlocksHtml(perfBlocks(r.data)));
  else {
    const blocks = dataBlocks(r);
    if (blocks) out.push(renderBlocksHtml(blocks));
  }

  const ths = thresholdsOf(r);
  if (ths.length > 0) {
    out.push("<h3>Thresholds</h3>");
    out.push(
      htmlTable(
        ["result", "threshold", "actual"],
        ths.map((t) => [t.passed ? { text: "pass", tone: "good" } : { text: "FAIL", tone: "bad" }, t.expression, fmtThresholdValue(t.actual, t.unit)]),
        ["l", "l", "r"],
      ),
    );
  }
  if (r.findings.length > 0) {
    out.push(`<h3>Findings (${r.findings.length})</h3>`);
    out.push(
      htmlTable(
        ["", "severity", "class", "finding", "where"],
        sortFindings(r.findings).map((f) => [
          isFailingFinding(f, failOn) ? { text: "FAIL", tone: "bad" } : "",
          { text: f.severity, tone: f.severity === "critical" || f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "muted" },
          f.classification,
          f.recommendation ? `${f.title} — fix: ${f.recommendation}` : f.title,
          locationOf(f),
        ]),
      ),
    );
  }
  if (r.limitations.length > 0) {
    out.push("<h3>Limitations</h3><ul>");
    for (const l of r.limitations) {
      const tone = l.impact === "invalidates" ? "bad" : l.impact === "reduces-confidence" ? "warn" : "muted";
      out.push(`<li>${e(l.message)} <code>${e(l.code)}</code> <span class="${tone}">${e(l.impact)}</span></li>`);
    }
    out.push("</ul>");
  }
  out.push("</section>");
  return out.join("\n");
}

export function renderHtml(report: CombinedReport): string {
  const v = report.verdict;
  const title = `SECOND WORLD report ${report.runId}`;
  const body: string[] = [];
  body.push(`<h1>SECOND WORLD <span class="verdict ${v.passed ? "pass" : "fail"}">${v.passed ? "PASS" : "FAIL"}</span></h1>`);
  body.push(
    `<p class="meta">run <code>${e(report.runId)}</code> · ${e(report.status)} · ${e(fmtDuration(report.durationMs))} · exit ${v.exitCode} · fail-on ${e(report.failOn)} · version ${e(report.toolVersion)}${report.startedAt ? ` · started ${e(report.startedAt)}` : ""}</p>`,
  );
  body.push(`<p>${v.reasons.map(e).join("; ")}</p>`);
  for (const r of report.results) body.push(engineSection(r, report.failOn));
  const methods = methodsOf(report);
  if (methods.length > 0 || report.command) {
    body.push("<details><summary>Methods &amp; reproduction</summary>");
    if (report.command) body.push(`<p>Reproduce: <code>${e(report.command)}</code></p>`);
    for (const m of methods) {
      body.push(`<ul>${Object.entries(m).map(([k, val]) => `<li><strong>${e(k)}</strong>: ${e(String(val))}</li>`).join("")}</ul>`);
    }
    body.push("</details>");
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${e(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body.join("\n")}
</main>
</body>
</html>
`;
}
