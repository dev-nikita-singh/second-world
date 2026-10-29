/**
 * Evolution's working-tree checksum leaves SECOND WORLD's own state out (docs/03-engines/experiments.md §B.3).
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ownStatePaths } from "../../../src/cli/commands/experiments.js";
import { stateExcludePathspecs } from "../../../src/engines/experiments/git.js";

const repo = path.resolve("/tmp/sw-repo-x");

describe("stateExcludePathspecs", () => {
  it("always excludes every .second-world/ dir", () => {
    expect(stateExcludePathspecs(repo)).toEqual(["--", ".", ":(exclude,glob)**/.second-world/**"]);
  });
  it("adds in-repo paths (absolute or relative, posix separators), skips the root and outside paths", () => {
    const specs = stateExcludePathspecs(repo, [
      path.join(repo, "out", "reports"),
      "sw-history",
      repo,
      path.resolve(repo, "..", "elsewhere"),
      path.join(repo, "..foo"),
    ]);
    expect(specs.slice(3)).toEqual([
      ":(exclude,literal)out/reports",
      ":(exclude,literal)sw-history",
      ":(exclude,literal)..foo",
    ]);
  });
});

describe("ownStatePaths", () => {
  it("resolves .second-world, report.outDir, history.dir, caches and evolution.ignorePaths against the config dir", () => {
    const cwd = path.resolve("/proj");
    const paths = ownStatePaths({
      cwd,
      config: {
        report: { outDir: "reports" },
        history: { dir: ".second-world/history" },
        architecture: { cacheDir: "cache/arch" },
        evolution: { ignorePaths: ["tmp-sw"] },
      },
    });
    expect(paths).toEqual([
      path.join(cwd, ".second-world"),
      path.join(cwd, "reports"),
      path.join(cwd, ".second-world", "history"),
      path.join(cwd, "cache", "arch"),
      path.join(cwd, "tmp-sw"),
    ]);
  });
});
