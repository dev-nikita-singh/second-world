/**
 * Shared helpers for cross-engine system tests (owner: sw-qa).
 * docs/12-testing-and-quality.md §1 (E2E / integration), docs/01-vision-and-principles.md §5 (trust ladder),
 * docs/11-safety-security-privacy.md (no secrets in artifacts).
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect } from "vitest";
import { REPO_ROOT } from "../helpers/cli.js";

export { REPO_ROOT };
export const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");

/** A free 127.0.0.1 port (closed again before returning). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** True when nothing listens on 127.0.0.1:port. */
export function portRefuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.on("connect", () => {
      c.destroy();
      resolve(false);
    });
    c.on("error", () => resolve(true));
  });
}

/** All regular files below `dir` (iterative, no recursion on user-sized input). */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

/** path → "size:mtimeMs" for every file below `dir` (to prove nothing was written there). */
export function snapshotTree(dir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const f of walkFiles(dir)) {
    const st = statSync(f);
    snap[path.relative(dir, f)] = `${st.size}:${st.mtimeMs}`;
  }
  // directories too: a new empty `.second-world/` dir must be noticed as well
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      snap[`${path.relative(dir, p)}/`] = "dir";
      stack.push(p);
    }
  }
  return snap;
}

/** Every (file, secret) pair where a secret value appears in a file below `dir`. */
export function findSecrets(
  dir: string,
  secrets: string[],
  opts: { exclude?: (file: string) => boolean } = {},
): string[] {
  const hits: string[] = [];
  for (const f of walkFiles(dir)) {
    if (opts.exclude?.(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const s of secrets)
      if (text.includes(s)) hits.push(`${path.relative(dir, f)} contains ${JSON.stringify(s)}`);
  }
  return hits;
}

export function mkdirp(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function parseJson(stdout: string, what = "stdout"): any {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${what} is not JSON:\n${stdout.slice(0, 2000)}`);
  }
}

/**
 * Trust ladder (docs/01 §5): which classifications each engine may emit.
 * - architecture = static rules → suspected-risk (heuristic rules may stay at hypothesis)
 * - performance / stress = measurements + threshold evaluator
 * - bugs / reliability = measurements, breaches and replayed reproductions
 * - ai = hypothesis only (AI never promotes)
 * - verified-fix only from evolution
 * - model never emits findings
 */
export const ALLOWED_CLASSIFICATIONS: Record<string, readonly string[]> = {
  architecture: ["suspected-risk", "hypothesis"],
  performance: ["observation", "threshold-breach"],
  stress: ["observation", "threshold-breach"],
  bugs: ["observation", "threshold-breach", "reproduced-defect"],
  reliability: ["observation", "threshold-breach", "reproduced-defect"],
  ai: ["hypothesis"],
  model: [],
  whatif: ["observation", "threshold-breach"],
  evolution: ["observation", "threshold-breach", "verified-fix"],
};

interface ResultLike {
  engine: string;
  findings: Array<{ engine?: string; ruleId?: string; classification: string; title?: string }>;
}

/** Asserts every finding is classified within its engine's rung(s) and carries the producing engine. */
export function expectTrustLadder(results: ResultLike[]): void {
  const bad: string[] = [];
  for (const r of results) {
    const allowed = ALLOWED_CLASSIFICATIONS[r.engine];
    for (const f of r.findings) {
      if (f.engine !== undefined && f.engine !== r.engine)
        bad.push(`${r.engine}: finding ${f.ruleId} claims engine ${f.engine}`);
      if (!allowed?.includes(f.classification))
        bad.push(`${r.engine}: ${f.ruleId} classified ${f.classification}`);
    }
  }
  expect(bad, bad.join("\n")).toEqual([]);
}
