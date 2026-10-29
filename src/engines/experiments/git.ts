/**
 * Minimal git helpers via `execa("git", argv)` (no shell, no simple-git). docs/03-engines/experiments.md §B.3.
 * Read-only towards the user's working tree: only `rev-parse`, `status`, `diff`, `ls-files`, `hash-object`
 * (without -w) and `worktree add/remove/prune` (which write to .git/worktrees, never to the working tree).
 */
import { createHash } from "node:crypto";
import { execa } from "execa";
import { CapabilityError, EngineError } from "../../core/errors.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function git(
  cwd: string,
  args: readonly string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<GitResult> {
  try {
    const r = await execa("git", [...args], {
      cwd,
      reject: false,
      windowsHide: true,
      stripFinalNewline: false,
      timeout: opts.timeoutMs ?? 120_000,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      extendEnv: true,
      maxBuffer: 256 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : { stdin: "ignore" as const }),
    });
    if (r.exitCode === undefined && r.failed && /ENOENT/.test(r.shortMessage ?? "")) {
      throw new CapabilityError("SW_CAP_GIT", "git is not installed or not on PATH", {
        hint: "Install git to use the Evolution engine",
      });
    }
    return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), exitCode: r.exitCode ?? -1 };
  } catch (e) {
    if (e instanceof CapabilityError) throw e;
    throw new CapabilityError("SW_CAP_GIT", `git could not be run: ${(e as Error).message}`);
  }
}

/** Runs git and throws EngineError on a non-zero exit. Returns trimmed stdout. */
export async function gitOk(
  cwd: string,
  args: readonly string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.exitCode !== 0) {
    throw new EngineError(
      "SW_ENGINE_EVOLUTION_GIT",
      `git ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500)}`,
    );
  }
  return r.stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.exitCode !== 0)
    throw new EngineError("SW_ENGINE_EVOLUTION_NOT_A_REPO", `${cwd} is not inside a git repository`);
  return r.stdout.trim();
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new EngineError("SW_ENGINE_EVOLUTION_REF", `cannot resolve "${ref}" to a commit`);
  return r.stdout.trim();
}

/**
 * Checksum of the user's working tree state: HEAD, current branch, `status --porcelain` (incl. untracked),
 * the full `diff HEAD`, and the content hashes of untracked files. Any change to the working tree,
 * index or checked-out branch changes it.
 */
export async function workingTreeChecksum(repo: string): Promise<string> {
  const h = createHash("sha256");
  const head = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  h.update(`head:${head.stdout.trim()}\n`);
  const branch = await git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
  h.update(`branch:${branch.stdout.trim()}\n`);
  const status = await gitOk(repo, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  h.update(`status:${status}\n`);
  const diff = await git(repo, ["diff", "HEAD", "--binary", "--no-ext-diff"]);
  h.update(`diff:${diff.stdout}\n`);
  const staged = await git(repo, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  h.update(`staged:${staged.stdout}\n`);
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
  if (untracked.length > 0) {
    const hashes = await git(repo, ["hash-object", "--stdin-paths"], { input: `${untracked.join("\n")}\n` });
    h.update(`untracked:${untracked.join("|")}:${hashes.stdout}\n`);
  }
  return h.digest("hex").slice(0, 32);
}

export interface ShortStat {
  files: number;
  insertions: number;
  deletions: number;
  lines: number;
  stat: string;
}

export function parseShortStat(s: string): ShortStat {
  const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  const files = n(/(\d+) files? changed/);
  const insertions = n(/(\d+) insertions?\(\+\)/);
  const deletions = n(/(\d+) deletions?\(-\)/);
  return { files, insertions, deletions, lines: insertions + deletions, stat: s.trim() };
}

/** `git diff --shortstat` between two commits (merge-base form `a...b`) or of the index in `cwd`. */
export async function diffShortStat(cwd: string, range?: string): Promise<ShortStat> {
  const args = range ? ["diff", "--shortstat", range] : ["diff", "--cached", "--shortstat"];
  return parseShortStat(await gitOk(cwd, args));
}
