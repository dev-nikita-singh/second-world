/**
 * Dependency install with caching by lockfile hash. docs/03-engines/experiments.md §B.3.
 *
 * Strategy (chosen for Windows portability; no admin rights, no extra deps):
 * - "link" (default): key = sha256(lockfile, EOL-normalised) [+ sandbox kind]. If an earlier arm of
 *   this run installed the same key, or (process sandbox only) the user's repo has `node_modules` and
 *   its lockfile hashes to the same key, the worktree gets a link to that directory: a **junction** on
 *   Windows (`fs.symlink(target, path, "junction")`, no privileges needed), a dir symlink elsewhere.
 *   In the docker sandbox the directory is bind-mounted read-only at /work/node_modules instead
 *   (host links do not resolve in containers; host-installed native modules would not match Linux,
 *   so the user's own node_modules is never reused there). Otherwise the install command runs.
 * - "copy": like link, but `fs.cp` recursive copy (isolated, slower).
 * - "install": always run the install command. "none": skip.
 * Links are registered with the WorktreeManager and unlinked before removal (never followed).
 * Risk of "link": a candidate whose scripts mutate node_modules mutates the shared copy — use "copy"
 * or "install" for untrusted candidates (docker mounts it read-only anyway).
 */
import { cp, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../shared/util/hash.js";
import type { CommandSpec } from "./command.js";

export const LOCKFILES = [
  { file: "package-lock.json", command: ["npm", "ci", "--no-audit", "--no-fund"] },
  { file: "npm-shrinkwrap.json", command: ["npm", "ci", "--no-audit", "--no-fund"] },
  { file: "pnpm-lock.yaml", command: ["pnpm", "install", "--frozen-lockfile"] },
  { file: "yarn.lock", command: ["yarn", "install", "--immutable"] },
  { file: "bun.lock", command: ["bun", "install", "--frozen-lockfile"] },
  { file: "bun.lockb", command: ["bun", "install", "--frozen-lockfile"] },
] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface LockInfo {
  file: string;
  hash: string;
  command: string[];
}

/** Finds the lockfile in `dir` and hashes it (CRLF → LF). Null when there is none. */
export async function lockInfo(dir: string): Promise<LockInfo | null> {
  for (const l of LOCKFILES) {
    const p = path.join(dir, l.file);
    if (await exists(p)) {
      const buf = await readFile(p);
      const text = l.file.endsWith(".lockb") ? buf : buf.toString("utf8").replace(/\r\n/g, "\n");
      return { file: l.file, hash: sha256(text).slice(0, 16), command: [...l.command] };
    }
  }
  return null;
}

export type InstallAction =
  | { kind: "skip"; reason: string }
  | { kind: "link" | "copy" | "mount"; source: string; key: string }
  | { kind: "install"; command: CommandSpec; key: string | undefined };

export interface InstallPlanInput {
  worktree: string;
  strategy: "link" | "copy" | "install" | "none";
  command?: CommandSpec | undefined;
  sandbox: "docker" | "process";
  /** User repo root (its node_modules may be reused in the process sandbox). */
  repo: string;
  /** key → node_modules directory installed earlier in this run. */
  cache: Map<string, string>;
}

/** Decides how to provide node_modules for a worktree. */
export async function planInstall(i: InstallPlanInput): Promise<InstallAction> {
  if (i.strategy === "none") return { kind: "skip", reason: "install.strategy none" };
  const hasPkg = await exists(path.join(i.worktree, "package.json"));
  if (!hasPkg && i.command === undefined) return { kind: "skip", reason: "no package.json" };
  const lock = await lockInfo(i.worktree);
  if (!lock && i.command === undefined)
    return { kind: "skip", reason: "no lockfile (nothing to install reproducibly)" };
  const key = lock ? `${i.sandbox}:${lock.hash}` : undefined;
  const command = i.command ?? (lock?.command as string[]);
  if (i.strategy === "install" || key === undefined) return { kind: "install", command, key };
  const cached = i.cache.get(key);
  const reuse = i.sandbox === "docker" ? "mount" : i.strategy === "copy" ? "copy" : "link";
  if (cached) return { kind: reuse, source: cached, key };
  if (i.sandbox === "process") {
    const userLock = await lockInfo(i.repo);
    const userModules = path.join(i.repo, "node_modules");
    if (userLock && `${i.sandbox}:${userLock.hash}` === key && (await exists(userModules))) {
      return { kind: reuse, source: userModules, key };
    }
  }
  return { kind: "install", command, key };
}

/** Creates node_modules in the worktree as a link/copy of `source`. Returns the created path. */
export async function materialize(kind: "link" | "copy", source: string, worktree: string): Promise<string> {
  const dest = path.join(worktree, "node_modules");
  if (kind === "copy") {
    await cp(source, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: false, force: true });
  } else {
    await symlink(source, dest, process.platform === "win32" ? "junction" : "dir");
  }
  return dest;
}
