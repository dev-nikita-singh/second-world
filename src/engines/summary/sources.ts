/**
 * Input reports for `sw analyze`: EngineResult objects or paths to JSON report files
 * (a single EngineResult, an array of them, or a combined `second-world-report` from writeReports).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";

function looksLikeResult(x: unknown): x is EngineResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.engine === "string" && typeof o.runId === "string" && typeof o.status === "string";
}

/** Extracts EngineResults from parsed JSON. Throws ConfigError when nothing usable is found. */
export function resultsFromJson(json: unknown, origin = "input"): EngineResult[] {
  const out: EngineResult[] = [];
  const push = (r: unknown) => {
    if (looksLikeResult(r)) {
      out.push({
        ...r,
        findings: Array.isArray(r.findings) ? r.findings : [],
        limitations: Array.isArray(r.limitations) ? r.limitations : [],
        artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
      });
    }
  };
  if (Array.isArray(json)) json.forEach(push);
  else if (json && typeof json === "object" && Array.isArray((json as { results?: unknown }).results)) {
    (json as { results: unknown[] }).results.forEach(push);
  } else push(json);
  if (out.length === 0) {
    throw new ConfigError("SW_CONFIG_REPORT", `${origin} does not contain a SECOND WORLD engine result`, {
      hint: "pass a report.json written by `sw perf|stress|inspect|bugs --format json`",
    });
  }
  return out;
}

export async function loadReports(
  reports: readonly (EngineResult | string)[],
  cwd = process.cwd(),
): Promise<EngineResult[]> {
  const out: EngineResult[] = [];
  for (const r of reports) {
    if (typeof r === "string") {
      const p = resolve(cwd, r);
      let text: string;
      try {
        text = await readFile(p, "utf8");
      } catch {
        throw new ConfigError("SW_CONFIG_REPORT", `cannot read report ${r}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ConfigError("SW_CONFIG_REPORT", `report ${r} is not valid JSON`);
      }
      out.push(...resultsFromJson(json, r));
    } else out.push(...resultsFromJson(r));
  }
  return out;
}
