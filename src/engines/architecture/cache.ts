/**
 * Incremental facts cache — docs/05-optimization.md §3.2.
 * `<cacheDir>/facts-<namespace>.json` where namespace = sha256(engine version + analyzer signature
 * (adapter, typescript, extractor versions) + tsconfig chain + extraction options). Each entry is
 * valid when the file's sha256 matches and every dependency recorded at extraction time (resolved
 * project imports, and missing relative imports) still has the same hash. Written atomically
 * (tmp + rename, retry on EPERM/EBUSY for Windows).
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../shared/index.js";
import { writeFileAtomic } from "../../shared/util/atomic-write.js";
import type { FileFacts } from "./types.js";

export const CACHE_FORMAT = 1;

interface CacheFile {
  format: number;
  namespace: string;
  files: Record<string, FileFacts>;
}

export function cacheNamespace(parts: readonly string[]): string {
  return sha256(parts.join("\u001f")).slice(0, 24);
}

export class FactsCache {
  private entries: Record<string, FileFacts> = {};
  constructor(
    private readonly dir: string,
    private readonly namespace: string,
  ) {}

  get file(): string {
    return path.join(this.dir, `facts-${this.namespace}.json`);
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as CacheFile;
      if (
        raw.format === CACHE_FORMAT &&
        raw.namespace === this.namespace &&
        raw.files &&
        typeof raw.files === "object"
      )
        this.entries = raw.files;
    } catch {
      this.entries = {};
    }
  }

  /** Valid cached facts for `file`, or undefined. */
  lookup(
    file: string,
    hashes: ReadonlyMap<string, string>,
    projectFiles: ReadonlySet<string>,
  ): FileFacts | undefined {
    const e = this.entries[file];
    if (!e || e.hash !== hashes.get(file)) return undefined;
    for (const [dep, h] of Object.entries(e.deps)) {
      if (dep.startsWith("?")) {
        // previously-unresolved relative import: invalidate if a file appeared that could satisfy it
        const spec = dep.slice(1);
        const base = path.posix
          .normalize(path.posix.join(path.posix.dirname(file), spec))
          .replace(/\.(m|c)?js$/, "");
        for (const ext of [
          ".ts",
          ".tsx",
          ".js",
          ".mts",
          ".cts",
          ".mjs",
          ".cjs",
          ".jsx",
          "/index.ts",
          "/index.js",
        ]) {
          if (projectFiles.has(`${base}${ext}`)) return undefined;
        }
        continue;
      }
      if ((hashes.get(dep) ?? "") !== h) return undefined;
    }
    return e;
  }

  replaceAll(facts: readonly FileFacts[]): void {
    const next: Record<string, FileFacts> = {};
    for (const f of facts) next[f.file] = f;
    this.entries = next;
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const body: CacheFile = { format: CACHE_FORMAT, namespace: this.namespace, files: this.entries };
    await writeFileAtomic(this.file, JSON.stringify(body));
  }
}
