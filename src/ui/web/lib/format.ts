/** Pure formatting helpers for the UI (no DOM). Tested in tests/unit/ui/web/format.test.ts. */
import type { Severity } from "../../shared/api-types.js";

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export function severityRank(s: string): number {
  const i = SEVERITIES.indexOf(s as Severity);
  return i < 0 ? SEVERITIES.length : i;
}

/** 1234 → "1,234"; 12.345 → "12.3"; small values keep 2 significant digits. */
export function fmtNumber(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString("en-US");
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 1 ? 2 : digits);
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
}

export function fmtPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "–";
  const p = ratio * 100;
  return `${p === 0 ? "0" : p < 0.1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

/** Duration between two ISO times, e.g. "1 min 05 s". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} min ${String(r).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** "just now", "5 min ago", "yesterday", or a date. `now` for tests. */
export function fmtRelative(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = Math.max(0, now - t) / 1000;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 2 * 86400) return "yesterday";
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} days ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const ENGINE_TITLES: Record<string, string> = {
  performance: "Load test",
  perf: "Load test",
  stress: "Stress test",
  architecture: "Code inspection",
  inspect: "Code inspection",
  bugs: "API bug hunt",
  agent: "Attack ideas",
  reliability: "Failure test",
  model: "System map",
  whatif: "What-if",
  evolution: "Evolution",
  replay: "Replay",
};

export function engineTitle(id: string): string {
  return ENGINE_TITLES[id] ?? id;
}

/** Run status → badge tone and words. */
export function statusTone(status: string): { tone: "ok" | "bad" | "warn" | "neutral"; label: string } {
  switch (status) {
    case "passed":
      return { tone: "ok", label: "Passed" };
    case "failed":
      return { tone: "bad", label: "Problems found" };
    case "partial":
      return { tone: "warn", label: "Partial" };
    case "error":
      return { tone: "bad", label: "Error" };
    case "cancelled":
      return { tone: "neutral", label: "Stopped" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    default:
      return { tone: "neutral", label: status };
  }
}

/** Exit code → tone for the job result. */
export function exitTone(code: number | undefined): "ok" | "bad" | "warn" | "neutral" {
  if (code === 0) return "ok";
  if (code === 1) return "warn";
  if (code === 130) return "neutral";
  return "bad";
}

const CLASS_WORDS: Record<string, string> = {
  "reproduced-defect": "Reproduced",
  "suspected-risk": "Suspected",
  observation: "Observation",
  "measured-regression": "Measured",
  "statistically-significant": "Significant",
  hypothesis: "Hypothesis",
};

export function classificationLabel(c: string): string {
  return CLASS_WORDS[c] ?? c;
}

export function classificationHelp(c: string): string {
  switch (c) {
    case "reproduced-defect":
      return "The bug was made to happen for real, with proof.";
    case "suspected-risk":
      return "The code looks risky; nothing was run to prove it.";
    case "observation":
      return "Worth knowing; not necessarily a bug.";
    default:
      return "";
  }
}

/** Labels the CLI gives runs by default (the command name): not worth showing as a chip. */
const COMMAND_LABELS = new Set([
  "inspect",
  "bugs",
  "perf",
  "stress",
  "reliability",
  "agent",
  "whatif",
  "model",
  "evolve",
  "replay",
]);

export function isCustomLabel(label: string | undefined): label is string {
  return typeof label === "string" && label !== "" && !COMMAND_LABELS.has(label);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNumber(n)} ${n === 1 ? one : many}`;
}
