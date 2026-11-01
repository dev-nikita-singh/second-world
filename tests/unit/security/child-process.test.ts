/**
 * Child processes never get shell-interpreted user/target strings (threat model T7, docs/11).
 * - No `shell: true`, no `exec`/`execSync` (which always use a shell) anywhere in src/.
 * - Every module that starts processes is on a reviewed list; a new one fails this test until reviewed.
 * - Command strings from config (hooks, evolve app commands) are split into argv without a shell:
 *   metacharacters stay literal arguments.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitCommand as splitHook } from "../../../src/engines/bugs/hooks.js";
import { splitCommand as splitApp } from "../../../src/engines/experiments/command.js";
import { REPO_ROOT } from "../../helpers/cli.js";

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Reviewed process spawners (wave 8): argv arrays, no shell. */
const REVIEWED = new Set([
  "src/adapters/faults/cleanup.ts",
  "src/adapters/faults/docker.ts",
  "src/core/probe/probe.ts",
  "src/engines/bugs/hooks.ts",
  "src/engines/experiments/app.ts",
  "src/engines/experiments/command.ts",
  "src/engines/experiments/git.ts",
  "src/engines/experiments/sandbox.ts",
  "src/engines/history/git.ts",
]);

describe("child processes: no shell", () => {
  const files = sources(join(REPO_ROOT, "src")).map((f) => ({
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    text: readFileSync(f, "utf8"),
  }));

  it("no shell: true, no child_process exec/execSync anywhere in src", () => {
    for (const { rel, text } of files) {
      expect(text, rel).not.toMatch(/shell\s*:\s*true/);
      expect(text, rel).not.toMatch(/\bexecSync\s*\(/);
      expect(text, rel).not.toMatch(/import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*"node:child_process"/);
      expect(text, rel).not.toMatch(/execaCommand|\bexeca\s*`|\$\(\s*\{[^}]*\}\s*\)\s*`/); // execa string/template command forms
    }
  });

  it("only reviewed modules start processes", () => {
    const spawners = files
      .filter(({ text }) => /node:child_process|["']execa["']/.test(text))
      .map((f) => f.rel)
      .sort();
    expect(spawners).toEqual([...REVIEWED].sort());
  });

  it("command splitting keeps shell metacharacters literal (fast-check)", () => {
    const meta = fc.constantFrom(
      ";",
      "&&",
      "|",
      "`id`",
      "$(id)",
      ">",
      "<",
      "&",
      "%PATH%",
      "^",
      "*",
      "$HOME",
      "\n",
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(meta, fc.stringMatching(/^[a-z0-9_.-]{1,6}$/)), { minLength: 1, maxLength: 6 }),
        (parts) => {
          const cmd = `node ${parts.map((p) => `'${p}'`).join(" ")}`;
          for (const split of [splitHook, splitApp]) {
            const argv = split(cmd);
            expect(argv[0]).toBe("node");
            expect(argv.slice(1)).toEqual(parts);
          }
          return true;
        },
      ),
      { numRuns: 300, seed: 0x5ec_0c4d },
    );
  });
});
