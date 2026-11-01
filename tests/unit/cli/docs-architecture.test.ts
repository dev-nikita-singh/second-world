/**
 * docs/02-architecture.md must describe the code that exists (wave 7: it listed `core/cancel.ts`,
 * `adapters/loadgen/`, `.dependency-cruiser.cjs` and events that are never emitted).
 * - every path in the §3 source-layout tree exists;
 * - every event named in §4.3 "Emitted today" is emitted somewhere in src/ (and vice versa).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../helpers/cli.js";

const doc = readFileSync(join(REPO_ROOT, "docs", "02-architecture.md"), "utf8");

function treePaths(): string[] {
  const start = doc.indexOf("## 3. Source layout");
  const block = doc.slice(
    doc.indexOf("```text", start) + 7,
    doc.indexOf("```", doc.indexOf("```text", start) + 7),
  );
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = /^((?:│ {3}| {4})*)[├└]── (.+)$/.exec(line);
    if (!m) continue;
    const depth = (m[1] as string).length / 4;
    const entry = (m[2] as string).replace(/#.*$/, "").trim();
    stack.length = depth;
    // a line can hold several root files ("package.json  tsconfig.json ...")
    for (const name of entry.split(/\s{2,}/)) {
      const clean = name.replace(/\/$/, "");
      if (!clean) continue;
      out.push([...stack, clean].join("/"));
    }
    if (entry.endsWith("/")) stack.push(entry.replace(/\/$/, ""));
  }
  return out;
}

function srcFiles(dir = join(REPO_ROOT, "src")): string[] {
  const out: string[] = [];
  const todo = [dir];
  while (todo.length > 0) {
    const d = todo.pop() as string;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) todo.push(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  }
  return out;
}

describe("docs/02 matches the code", () => {
  it("§3 source layout: every listed path exists", () => {
    const paths = treePaths();
    expect(paths.length).toBeGreaterThan(30);
    const missing = paths.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });

  it("§4.3 events: the documented list is exactly what src/ emits", () => {
    const m = /Emitted today: (.+?);/.exec(doc);
    expect(m).not.toBeNull();
    const documented = new Set(
      [...(m?.[1] ?? "").matchAll(/`([a-z]+\.[a-zA-Z.]+)`/g)].map((x) => x[1] as string),
    );
    const emitted = new Set<string>();
    for (const f of srcFiles()) {
      const text = readFileSync(f, "utf8");
      for (const x of text.matchAll(/\.emit\(\s*"([a-z]+\.[a-zA-Z.]+)"/g)) emitted.add(x[1] as string);
      // world.ts emits finding.created / finding.updated through a ternary
      for (const x of text.matchAll(/emit\(isNew \? "([a-z.]+)" : "([a-z.]+)"/g)) {
        emitted.add(x[1] as string);
        emitted.add(x[2] as string);
      }
    }
    expect([...documented].sort()).toEqual([...emitted].sort());
  });
});
