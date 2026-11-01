/**
 * Adversarial Test Agent rendering (docs/03-engines/adversarial-test-agent.md; CONTRACTS.md
 * "sw-agent" reporting notes): run header (planner, bandit, seed, budget used vs limits, stop
 * reason), coverage, hypotheses tried with their outcome (unconfirmed ones stay visible),
 * rejected proposals with the validator's reasons, findings with curl reproductions
 * (`$SW_AUTH_<ROLE>`, scrubbed) and suggested tests (preview).
 */
import type { AgentData, AgentFindingSummary, HypothesisRecord } from "../agent/engine.js";
import type { Block, Cell, CellLike } from "./blocks.js";
import { REPRO_AUTH_HINT, replayText, scrubSecrets } from "./bugs.js";
import { fmtDuration } from "./model.js";

export function isAgentData(d: unknown): d is AgentData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    o.schema === 1 &&
    o.planner === "heuristic" &&
    Array.isArray(o.hypotheses) &&
    Array.isArray(o.findings) &&
    Array.isArray(o.rejected) &&
    typeof o.budget === "object" &&
    o.budget !== null &&
    Array.isArray(o.suggestedTests)
  );
}

/** Findings of a hypothesis (via the finding fingerprints it produced). */
export function findingsOf(d: AgentData, h: HypothesisRecord): AgentFindingSummary[] {
  if (h.failures.length === 0) return [];
  const fps = new Set(h.failures);
  return d.findings.filter((f) => fps.has(f.fingerprint));
}

/** Outcome cell: confirmed / flaky k/n / not reproduced / observation / passed / … */
export function outcomeCell(d: AgentData, h: HypothesisRecord): Cell {
  const f = findingsOf(d, h)[0];
  switch (h.outcome) {
    case "confirmed":
      return { text: f ? `confirmed ${f.failures}/${f.replays}` : "confirmed", tone: "bad" };
    case "flaky":
      return { text: f ? `flaky ${f.failures}/${f.replays}` : "flaky", tone: "warn" };
    case "not-reproduced":
      return { text: "not reproduced", tone: "muted" };
    case "observation":
      return { text: "observation", tone: "warn" };
    case "failed":
      return { text: "failed (pending replay)", tone: "warn" };
    case "inconclusive":
      return { text: "inconclusive", tone: "muted" };
    default:
      return { text: "passed", tone: "good" };
  }
}

const PREVIEW_LINES = 12;

function withReason(c: Cell, reason: string | undefined): Cell {
  return reason ? { ...c, text: `${c.text} — ${reason}` } : c;
}

export function agentBlocks(d: AgentData): Block[] {
  const b: Block[] = [];
  const bu = d.budget;
  const items: [string, CellLike][] = [
    ["planner", `${d.planner} (bandit ${d.bandit}, seed ${d.seed})`],
    ["target", d.target],
    ["contract", `${d.contract.source} (${d.contract.operations} operations)`],
    ["iterations", `${bu.iterations.used}/${bu.iterations.max}`],
    ["requests", `${bu.requests.used}/${bu.requests.max} (${bu.requests.replays} replays)`],
    [
      "duration",
      `${fmtDuration(bu.durationMs.used)}${bu.durationMs.max !== undefined ? ` / ${fmtDuration(bu.durationMs.max)}` : ""}`,
    ],
    ["stop reason", bu.stopReason],
    ["mutations", d.mutationsAllowed ? "allowed" : { text: "blocked", tone: "muted" }],
  ];
  // Coverage: documented (operation, status) pairs observed. A baseline is optional and only
  // rendered when the engine provides one (coverage.baselinePercent).
  const base = (d.coverage as { baselinePercent?: unknown }).baselinePercent;
  const cov = `${d.coverage.percent.toFixed(1)}% (${d.coverage.documented.observed}/${d.coverage.documented.total} documented status pairs)`;
  if (typeof base === "number") {
    const delta = d.coverage.percent - base;
    items.push([
      "coverage",
      {
        text: `${cov}, ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts vs baseline ${base.toFixed(1)}%`,
        tone: delta > 0 ? "good" : undefined,
      } as CellLike,
    ]);
  } else {
    items.push(["coverage", cov]);
  }
  const bits = d.coverage.bits;
  items.push([
    "new coverage bits",
    `status ${bits.status}, branch ${bits.branch}, param ${bits.param}, transition ${bits.trans}`,
  ]);
  b.push({ kind: "kv", items });

  // ---- hypotheses tried
  if (d.hypotheses.length > 0) {
    b.push({
      kind: "table",
      title: `Hypotheses tried (${d.hypotheses.length})`,
      head: ["#", "arm (operation × technique)", "source", "hypothesis", "outcome", "requests"],
      align: ["r", "l", "l", "l", "l", "r"],
      rows: d.hypotheses.map((h) => [
        String(h.iteration),
        `${h.operation} × ${h.technique}`,
        h.source,
        h.hypothesis || h.title,
        withReason(outcomeCell(d, h), h.reason),
        String(h.requests),
      ]),
    });
  }

  // ---- rejected proposals
  if (d.rejectedTotal > 0) {
    const shown = d.rejected.slice(0, 20);
    b.push({
      kind: "table",
      title: `Rejected proposals (${d.rejectedTotal}; validator reasons)`,
      head: ["source", "arm", "proposal", "reasons"],
      rows: shown.map((r) => [
        r.source,
        r.arm ?? "-",
        r.title ?? "-",
        { text: r.reasons.join("; "), tone: "warn" },
      ]),
    });
    if (d.rejectedTotal > shown.length)
      b.push({
        kind: "text",
        tone: "muted",
        text: `${d.rejectedTotal - shown.length} more rejected proposal(s) not shown (deduplicated list in the JSON report).`,
      });
  }

  // ---- findings + reproductions
  if (d.findings.length > 0) {
    const fs = [...d.findings].sort(
      (a, z) =>
        (a.classification === z.classification ? 0 : a.classification === "reproduced-defect" ? -1 : 1) ||
        (a.operation < z.operation ? -1 : 1),
    );
    b.push({
      kind: "table",
      title: `Agent findings (${fs.length})`,
      head: ["classification", "severity", "rule", "operation", "technique", "replays", "title"],
      rows: fs.map((f) => [
        f.classification === "reproduced-defect"
          ? { text: f.classification, tone: "bad" }
          : { text: f.classification, tone: "muted" },
        f.severity,
        f.ruleId,
        f.operation,
        f.technique,
        // same wording as the Bug Hunter (bugs.ts replayText)
        f.flaky ? { text: replayText(f), tone: "warn" } : replayText(f),
        `${f.title}${f.minimized ? " (minimized)" : ""}`,
      ]),
    });
    const withCurl = fs.filter((f) => f.curl.length > 0);
    if (withCurl.length > 0) {
      b.push({ kind: "heading", level: 3, text: "Reproductions" });
      b.push({ kind: "text", tone: "muted", text: REPRO_AUTH_HINT });
      for (const f of withCurl.slice(0, 10)) {
        b.push({
          kind: "code",
          title: `${f.ruleId} on ${f.operation} — hypothesis: ${f.hypothesis}${f.message ? ` — ${f.message}` : ""}`,
          lines: f.curl.map(scrubSecrets),
          lang: "sh",
        });
      }
      if (withCurl.length > 10)
        b.push({
          kind: "text",
          tone: "muted",
          text: `${withCurl.length - 10} more reproduction(s) in the JSON report.`,
        });
    }
  }

  // ---- suggested tests
  if (d.suggestedTests.length > 0) {
    b.push({ kind: "heading", level: 3, text: "Suggested tests" });
    b.push({
      kind: "table",
      head: ["file", "rule", "operation", "title"],
      rows: d.suggestedTests.map((t) => [t.filename, t.ruleId, t.operation, t.title]),
    });
    for (const t of d.suggestedTests.slice(0, 5)) {
      const lines = scrubSecrets(t.vitest).split("\n");
      const preview = lines.slice(0, PREVIEW_LINES);
      if (lines.length > PREVIEW_LINES)
        preview.push(`// … ${lines.length - PREVIEW_LINES} more line(s): sw agent --export-tests <dir>`);
      b.push({ kind: "code", title: `${t.filename} (preview)`, lines: preview, lang: "ts" });
      b.push({
        kind: "code",
        title: "agent.regression config snippet",
        lines: scrubSecrets(t.config).split("\n"),
        lang: "ts",
      });
    }
  }
  return b;
}
