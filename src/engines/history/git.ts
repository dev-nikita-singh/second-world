/**
 * Git metadata capture (commit, branch, dirty). See docs/03-engines/evidence-and-history.md §B.2.
 * Uses execa without a shell and with reject:false: missing git or not a repo → undefined, never an error.
 */
import type { GitMeta } from "./types.js";

export async function captureGitMetadata(
  cwd: string,
  opts: { timeoutMs?: number; gitBin?: string } = {},
): Promise<GitMeta | undefined> {
  let execa: typeof import("execa").execa;
  try {
    ({ execa } = await import("execa"));
  } catch {
    return undefined;
  }
  const run = async (args: string[]): Promise<string | undefined> => {
    try {
      const r = await execa(opts.gitBin ?? "git", args, {
        cwd,
        reject: false,
        timeout: opts.timeoutMs ?? 3_000,
        stdin: "ignore",
        windowsHide: true,
      });
      if (r.failed || r.exitCode !== 0) return undefined;
      return String(r.stdout ?? "").trim();
    } catch {
      return undefined;
    }
  };
  const commit = await run(["rev-parse", "HEAD"]);
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return undefined;
  const branchRaw = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await run(["status", "--porcelain", "--untracked-files=no"]);
  return {
    commit,
    branch: branchRaw && branchRaw !== "HEAD" ? branchRaw : null,
    dirty: status === undefined ? false : status.length > 0,
  };
}
