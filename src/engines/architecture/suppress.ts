/**
 * Inline suppressions — docs/03-engines/architecture-inspector.md §4:
 *   `// sw-ignore ARCH001 reason`        (own line → applies to the next code line; trailing → same line)
 *   `// sw-ignore ARCH001,ARCH005 reason`
 *   `// sw-ignore-file ARCH010 reason`   (whole file)
 * Text-based so it works for any analyzer adapter.
 */
import type { Suppression } from "./types.js";

const RE =
  /(?:\/\/|\/\*|#)\s*sw-ignore(-file)?\s+([A-Za-z0-9_/-]+(?:\s*,\s*[A-Za-z0-9_/-]+)*)\s*(.*?)(?:\*\/)?\s*$/;

export function parseSuppressions(text: string): Suppression[] {
  if (!text.includes("sw-ignore")) return [];
  const lines = text.split(/\r?\n/);
  const out: Suppression[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const idx = line.indexOf("sw-ignore");
    if (idx < 0) continue;
    const m = RE.exec(line);
    if (!m) continue;
    const rules = (m[2] as string).split(",").map((s) => s.trim().toUpperCase());
    const reason = (m[3] ?? "").trim();
    if (m[1]) {
      out.push({ line: 0, rules, reason });
      continue;
    }
    const before = line.slice(0, line.search(/\/\/|\/\*|#/)).trim();
    if (before.length > 0) {
      out.push({ line: i + 1, rules, reason });
      continue;
    }
    // own-line comment: next non-blank, non-comment line
    let j = i + 1;
    while (j < lines.length && /^\s*(\/\/.*)?$/.test(lines[j] as string)) j++;
    out.push({ line: j + 1, rules, reason });
  }
  return out;
}

export function findSuppression(
  sups: readonly Suppression[],
  ruleId: string,
  line: number,
  endLine?: number,
): Suppression | undefined {
  const id = ruleId.toUpperCase();
  for (const s of sups) {
    if (!s.rules.includes(id) && !s.rules.includes("ALL")) continue;
    if (s.line === 0) return s;
    if (s.line === line || (endLine !== undefined && s.line >= line && s.line <= endLine)) return s;
  }
  return undefined;
}
