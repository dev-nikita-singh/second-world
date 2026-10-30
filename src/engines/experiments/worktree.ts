/**
 * Isolated candidate checkouts via `git worktree add` in a temp directory. docs/03-engines/experiments.md §B.3.
 * The user's working tree is never touched: worktrees are detached (`--detach`), so no branch is checked
 * out or moved. Every worktree is removed (`git worktree remove --force`, then fs fallback + prune) on
 * success, error and abort. Links created inside a worktree (node_modules junctions) are unlinked
 * first, so removal never follows them into shared directories.
 */
import { lstat, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityError, ConfigError } from "../../core/errors.js";
import { git, gitFailure, gitOk } from "./git.js";

export interface Worktree {
  name: string;
  dir: string;
  commit: string;
}

function safeName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "wt"
  );
}

export class WorktreeManager {
  private parent: string | undefined;
  private readonly trees: Worktree[] = [];
  private readonly links = new Set<string>();

  constructor(
    readonly repo: string,
    private readonly tmpRoot: string = os.tmpdir(),
    /** lf: check out with LF line endings (core.autocrlf=false) — for Linux containers. */
    private readonly opts: { lf?: boolean } = {},
  ) {}

  get active(): readonly Worktree[] {
    return this.trees;
  }

  private async parentDir(): Promise<string> {
    if (this.parent) return this.parent;
    try {
      this.parent = await mkdtemp(path.join(this.tmpRoot, "sw-evo-"));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      const msg = `cannot create a temp directory for worktrees in ${this.tmpRoot}: ${code || (e as Error).message}`;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new ConfigError("SW_CONFIG_EVOLUTION_TMPDIR", msg, {
          hint: "Set evolution.tmpDir (or TMPDIR/TEMP) to an existing directory",
        });
      throw new CapabilityError("SW_CAP_EVOLUTION_WORKTREE", msg, {
        hint: "Check permissions and free space of the temp directory, or set evolution.tmpDir",
      });
    }
    return this.parent;
  }

  /** Creates a detached worktree of `commit`. */
  async add(name: string, commit: string): Promise<Worktree> {
    const base = await this.parentDir();
    let dir = path.join(base, safeName(name));
    for (let i = 2; this.trees.some((t) => t.dir === dir); i++)
      dir = path.join(base, `${safeName(name)}-${i}`);
    const eol = this.opts.lf ? ["-c", "core.autocrlf=false", "-c", "core.eol=lf"] : [];
    const r = await git(this.repo, [...eol, "worktree", "add", "--detach", "--force", dir, commit]);
    if (r.exitCode !== 0) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
      // The commit was resolved beforehand, so an unmatched failure is git/the filesystem refusing (exit 4).
      throw gitFailure(`git worktree add (${name})`, r, "capability");
    }
    const wt = { name, dir, commit };
    this.trees.push(wt);
    return wt;
  }

  /** Registers a link (junction/symlink) inside a worktree so it is unlinked before removal. */
  registerLink(p: string): void {
    this.links.add(p);
  }

  private async unlinkLinksUnder(dir: string): Promise<void> {
    for (const l of [...this.links]) {
      if (!l.startsWith(dir)) continue;
      try {
        const st = await lstat(l);
        if (st.isSymbolicLink()) await unlink(l);
        else if (process.platform === "win32")
          await rm(l, { recursive: false, force: true }).catch(() => unlink(l));
      } catch {
        // gone already
      }
      this.links.delete(l);
    }
    // Defensive: unlink any top-level symlink/junction left in the worktree root.
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) await unlink(path.join(dir, e.name)).catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }

  async remove(wt: Worktree): Promise<void> {
    await this.unlinkLinksUnder(wt.dir);
    const r = await git(this.repo, ["worktree", "remove", "--force", "--force", wt.dir]);
    if (r.exitCode !== 0) {
      await rm(wt.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
    const i = this.trees.indexOf(wt);
    if (i >= 0) this.trees.splice(i, 1);
  }

  /** Removes every worktree and the temp parent; prunes stale metadata. Never throws. Returns true when all is clean. */
  async cleanupAll(): Promise<boolean> {
    for (const wt of [...this.trees].reverse()) {
      try {
        await this.remove(wt);
      } catch {
        // continue
      }
    }
    await git(this.repo, ["worktree", "prune"]).catch(() => undefined);
    if (this.parent) {
      await rm(this.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
    const list = await gitOk(this.repo, ["worktree", "list", "--porcelain"]).catch(() => "");
    const norm = (p: string) =>
      process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
    const leftover = this.parent
      ? list
          .split(/\r?\n/)
          .some((l) => l.startsWith("worktree ") && norm(l.slice(9)).startsWith(norm(this.parent as string)))
      : false;
    const clean = this.trees.length === 0 && !leftover;
    this.parent = undefined;
    return clean;
  }
}
