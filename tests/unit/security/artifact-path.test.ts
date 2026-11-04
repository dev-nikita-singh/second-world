/**
 * Path traversal / untrusted artifacts (threat model T6): a reproduction artifact is data a user may
 * receive from someone else (bug report attachment). `sw replay` must not import a module the
 * artifact names outside the current project, because importing a module runs its code.
 * Also: suggested-test export writes only basenames inside the chosen directory.
 */
import { existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportSuggestedTests } from "../../../src/cli/commands/agent.js";
import { hydrateForReplay } from "../../../src/engines/bugs/artifact.js";
import type { BugCase } from "../../../src/engines/bugs/cases.js";
import type { Session } from "../../../src/engines/bugs/session.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
let project: string;
let outside: string;
beforeAll(async () => {
  tmp = await makeTmpDir("sw-sec-art-");
  project = tmp.join("project");
  outside = tmp.join("elsewhere");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  const evil = "globalThis.__swPwned = (globalThis.__swPwned ?? 0) + 1;\nexport default () => true;\n";
  await writeFile(join(outside, "evil.mjs"), evil);
  await writeFile(join(project, "inv.mjs"), "export default () => true;\n");
});
afterAll(() => tmp.cleanup());

function fakeSession(cwd: string): Session {
  return {
    cwd,
    contract: undefined,
    input: { auth: { roles: {} } },
    env: { assertions: [], invariants: [], concurrency: [], concurrencyFns: new Map() },
  } as unknown as Session;
}

function caseWith(module: string): BugCase {
  return {
    steps: [],
    check: { kind: "invariants" },
    context: { version: 1, roles: [], assertions: [], invariants: [{ module }] },
  } as unknown as BugCase;
}

describe("replay artifacts cannot load code from outside the project", () => {
  it("an invariant module outside the project → inconclusive, module never imported", async () => {
    const g = globalThis as { __swPwned?: number };
    delete g.__swPwned;
    for (const m of [
      join(outside, "evil.mjs"),
      "../elsewhere/evil.mjs",
      `${join(outside, "evil.mjs")}#default`,
    ]) {
      const r = await hydrateForReplay(caseWith(m), fakeSession(project));
      expect(r.ok, m).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/outside the project/);
    }
    expect(g.__swPwned).toBeUndefined();
  });

  it("an invariant module inside the project still loads (absolute or relative)", async () => {
    for (const m of [join(project, "inv.mjs"), "inv.mjs", "./sub/../inv.mjs"]) {
      const r = await hydrateForReplay(caseWith(m), fakeSession(project));
      expect(r.ok, m).toBe(true);
    }
  });

  // macOS: /var is a symlink to /private/var, so the project root (realpath'd) and a module path
  // (as written in the artifact) can name the same place differently. A link to the project
  // (junction on Windows: no admin rights needed) reproduces that on every OS.
  it("the project reached through a symlink: a missing module inside is 'cannot be loaded', not 'outside'", async () => {
    const links = await makeTmpDir("sw-sec-link-"); // not under tmp: another test lists tmp exactly
    const link = join(links.path, "project-link");
    symlinkSync(project, link, "junction");
    for (const [cwd, mod] of [
      [project, join(link, "gone", "inv.mjs")],
      [link, join(project, "gone", "inv.mjs")],
    ] as const) {
      const r = await hydrateForReplay(caseWith(mod), fakeSession(cwd));
      expect(r.ok, mod).toBe(false);
      if (!r.ok) expect(r.reason, mod).not.toMatch(/outside the project/);
    }
    const ok = await hydrateForReplay(caseWith(join(link, "inv.mjs")), fakeSession(project));
    expect(ok.ok).toBe(true);
    await links.cleanup();
  });

  it("a symlink inside the project pointing outside it is outside (module never imported)", async () => {
    const g = globalThis as { __swPwned?: number };
    delete g.__swPwned;
    const escapeLink = join(project, "escape");
    symlinkSync(outside, escapeLink, "junction");
    try {
      const r = await hydrateForReplay(caseWith("escape/evil.mjs"), fakeSession(project));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/outside the project/);
      expect(g.__swPwned).toBeUndefined();
    } finally {
      rmSync(escapeLink, { recursive: false, force: true });
    }
  });
});

describe("suggested-test export stays inside its directory (fast-check)", () => {
  it("hostile file names are reduced to a basename in the target dir", async () => {
    const dir = tmp.join("export");
    const names = fc.oneof(
      fc.constantFrom(
        "../../evil.test.ts",
        "..\\..\\evil.ts",
        "/etc/passwd",
        "C:\\Windows\\x.ts",
        "a/../../b",
        "..",
        ".",
        "con.ts",
        "x\u0000y.ts",
      ),
      fc.string({ minLength: 1, maxLength: 20 }),
    );
    fc.assert(
      fc.property(names, (filename) => {
        const [p] = exportSuggestedTests(dir, [{ filename, vitest: "// x\n" }]);
        expect(resolve(p as string).startsWith(resolve(dir))).toBe(true);
        return true;
      }),
      { numRuns: 300, seed: 0x5ec_0a7f },
    );
    expect(existsSync(tmp.join("evil.test.ts"))).toBe(false);
    expect(readdirSync(tmp.path).sort()).toEqual(["elsewhere", "export", "project"]);
  });
});
