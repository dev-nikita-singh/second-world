/**
 * Minimal git helpers via `execa("git", argv)` (no shell, no simple-git). docs/03-engines/experiments.md §B.3.
 * Read-only towards the user's working tree: only `rev-parse`, `status`, `diff`, `ls-files`, `hash-object`
 * (without -w) and `worktree add/remove/prune` (which write to .git/worktrees, never to the working tree).
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { CapabilityError, ConfigError } from "../../core/errors.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when git was killed by the timeout. */
  timedOut?: boolean;
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
    return {
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      exitCode: r.exitCode ?? -1,
      ...(r.timedOut ? { timedOut: true } : {}),
    };
  } catch (e) {
    if (e instanceof CapabilityError) throw e;
    throw new CapabilityError("SW_CAP_GIT", `git could not be run: ${(e as Error).message}`);
  }
}

interface GitRule {
  re: RegExp;
  kind: "config" | "capability";
  hint: string;
}

/** stderr patterns → error class + hint. First match wins; checked against `LC_ALL=C` git output. */
const GIT_RULES: readonly GitRule[] = [
  {
    re: /dubious ownership/i,
    kind: "config",
    hint: "git refuses this repository (owned by another user): git config --global --add safe.directory <repo>",
  },
  {
    re: /file ?name too long|path too long/i,
    kind: "capability",
    hint: "Path too long for the filesystem. On Windows: git config --global core.longpaths true, or set evolution.tmpDir to a short path (e.g. C:/sw-tmp)",
  },
  {
    re: /no space left|disk quota|not enough space/i,
    kind: "capability",
    hint: "Free disk space, or set evolution.tmpDir on a volume with room for the candidate checkouts",
  },
  {
    re: /\.lock\b|is locked|locked working tree/i,
    kind: "capability",
    hint: "Another git process holds a lock. If none is running, remove the stale .git/*.lock file and run: git worktree prune",
  },
  {
    re: /already registered|already exists|missing but/i,
    kind: "capability",
    hint: "Stale worktree metadata: run git worktree prune in the repository and retry",
  },
  {
    re: /permission denied|operation not permitted|access is denied|read-only file system|unable to create|could not create|cannot mkdir|unable to write/i,
    kind: "capability",
    hint: "The filesystem refused the write: check permissions of the repository's .git directory and the temp directory (evolution.tmpDir)",
  },
  {
    re: /not a git repository|unknown revision|bad revision|invalid reference|not a valid object name|bad object|ambiguous argument|corrupt|index file|bad config|bad numeric config/i,
    kind: "config",
    hint: "Check the repository and the refs given to sw evolve (git status / git rev-parse --verify <ref> should succeed)",
  },
];

/**
 * Maps a failed git invocation to the right error class (docs/09-cli-and-api.md exit codes): problems in
 * the user's repository / refs / git config → ConfigError (exit 2); git or the filesystem being unable to
 * do the work (permissions, path length, locks, disk space, timeouts) → CapabilityError (exit 4).
 * Never EngineError: a non-zero git exit is not a bug in SECOND WORLD. `fallback` applies when no
 * pattern matches.
 */
export function gitFailure(
  what: string,
  r: GitResult,
  fallback: "config" | "capability" = "config",
): ConfigError | CapabilityError {
  const err = r.stderr.trim().replace(/\s+/g, " ").slice(0, 400);
  if (r.timedOut) {
    return new CapabilityError("SW_CAP_GIT_TIMEOUT", `${what} timed out`, {
      hint: "A very large repository or a slow disk; retry, or check for a hung git process",
      details: { stderr: err },
    });
  }
  const rule = GIT_RULES.find((x) => x.re.test(err));
  const kind = rule?.kind ?? fallback;
  const msg = `${what} failed (exit ${r.exitCode})${err ? `: ${err}` : ""}`;
  const hint = rule?.hint ?? "Run the same git command in the repository to see the full error";
  return kind === "config"
    ? new ConfigError("SW_CONFIG_EVOLUTION_GIT", msg, { hint, details: { exitCode: r.exitCode } })
    : new CapabilityError("SW_CAP_EVOLUTION_GIT", msg, { hint, details: { exitCode: r.exitCode } });
}

/** Runs git and throws (see gitFailure: ConfigError / CapabilityError) on a non-zero exit. Returns trimmed stdout. */
export async function gitOk(
  cwd: string,
  args: readonly string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.exitCode !== 0 || r.timedOut) throw gitFailure(`git ${args.join(" ")}`.slice(0, 200), r);
  return r.stdout.trim();
}

/** The repository root containing `cwd`. A wrong `--repo` / evolution.repo is a usage error (exit 2). */
export async function repoRoot(cwd: string): Promise<string> {
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // missing
  }
  // Checked first: git spawned in a missing cwd fails with ENOENT, which would read as "git is not installed".
  if (!isDir)
    throw new ConfigError(
      "SW_CONFIG_EVOLUTION_REPO",
      `Repository path ${cwd} does not exist or is not a directory`,
      {
        hint: "Pass --repo <dir> (or evolution.repo in sw.config) pointing at a git checkout",
      },
    );
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.exitCode !== 0 || r.timedOut) {
    if (r.timedOut || !/not a git repository/i.test(r.stderr)) throw gitFailure(`git rev-parse in ${cwd}`, r);
    throw new ConfigError("SW_CONFIG_EVOLUTION_REPO", `${cwd} is not inside a git repository`, {
      hint: "Pass --repo <dir> (or evolution.repo in sw.config) pointing at a git checkout",
    });
  }
  return r.stdout.trim();
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new ConfigError("SW_CONFIG_EVOLUTION_REF", `cannot resolve "${ref}" to a commit`, {
      hint: "Use a branch, tag or commit that exists in the repository (git rev-parse --verify <ref>)",
    });
  return r.stdout.trim();
}

/** SECOND WORLD's own state directory name; excluded from the working-tree checksum at any depth. */
export const SW_STATE_DIR = ".second-world";

/**
 * Git pathspecs (`-- . :(exclude)…`) that leave SECOND WORLD's own files out of the working-tree checksum:
 * every `.second-world/` directory plus each of `ignore` (absolute, or relative to `repo`) that lies inside
 * the repository. Paths outside the repo, and the repo root itself, are skipped.
 */
export function stateExcludePathspecs(repo: string, ignore: readonly string[] = []): string[] {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const outside = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  const root = real(path.resolve(repo));
  const specs = new Set<string>([`:(exclude,glob)**/${SW_STATE_DIR}/**`]);
  for (const p of ignore) {
    const abs = path.resolve(root, p);
    let rel = path.relative(root, real(abs));
    if (outside(rel)) rel = path.relative(root, abs);
    if (!rel || outside(rel)) continue;
    specs.add(`:(exclude,literal)${rel.split(path.sep).join("/")}`);
  }
  return ["--", ".", ...specs];
}

/**
 * Checksum of the user's working tree state: HEAD, current branch, `status --porcelain` (incl. untracked),
 * the full `diff HEAD`, and the content hashes of untracked files. Any change to the working tree,
 * index or checked-out branch changes it — except SECOND WORLD's own state (see stateExcludePathspecs):
 * the audit log, reports, history and caches it writes itself while running must not count as a change.
 */
export async function workingTreeChecksum(repo: string, ignore: readonly string[] = []): Promise<string> {
  const h = createHash("sha256");
  const specs = stateExcludePathspecs(repo, ignore);
  const head = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  h.update(`head:${head.stdout.trim()}\n`);
  const branch = await git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
  h.update(`branch:${branch.stdout.trim()}\n`);
  const status = await gitOk(repo, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
    ...specs,
  ]);
  h.update(`status:${status}\n`);
  const diff = await git(repo, ["diff", "HEAD", "--binary", "--no-ext-diff", ...specs]);
  h.update(`diff:${diff.stdout}\n`);
  const staged = await git(repo, ["diff", "--cached", "--binary", "--no-ext-diff", ...specs]);
  h.update(`staged:${staged.stdout}\n`);
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", ...specs])).stdout
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
