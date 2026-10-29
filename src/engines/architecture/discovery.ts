/**
 * Discovery — docs/03-engines/architecture-inspector.md §1.1, docs/05-optimization.md §3.7.
 * tsconfig (incl. `references` + `extends` chain for hashing), npm/pnpm/yarn workspaces (best effort),
 * `.gitignore` (nested) + `.swignore`, built-in ignores applied during the walk, size + generated-file
 * skipping, POSIX-normalised relative paths. Never executes project code (only reads files).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { glob } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import type { FactLimitation } from "./types.js";

export const SOURCE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;
const DEFAULT_INCLUDE = [`**/*.{${SOURCE_EXTENSIONS.join(",")}}`];
export const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.second-world/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/generated/**",
  "**/__generated__/**",
  "**/*.generated.*",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.min.js",
];
const UNSUPPORTED_GLOB = "**/*.{py,go,java,rb,rs,cs,php,kt,scala,swift}";

export interface WorkspacePackage {
  name: string;
  /** POSIX dir relative to root. */
  dir: string;
  /** Entry candidates (POSIX, relative to root). */
  entry?: string;
}

export interface DiscoveryOptions {
  root: string;
  tsconfig?: string;
  include?: string[];
  exclude: string[];
  maxFiles: number;
  maxFileSizeBytes: number;
  gitignore: boolean;
}

export interface DiscoveryResult {
  root: string;
  /** POSIX paths relative to root, sorted. */
  files: string[];
  /** Absolute tsconfig path, when found. */
  tsconfig?: string;
  /** Referenced tsconfig paths (absolute). */
  tsconfigReferences: string[];
  /** sha256-able text: concatenation of tsconfig chain contents. */
  tsconfigText: string;
  workspaces: WorkspacePackage[];
  limitations: FactLimitation[];
  skipped: { file: string; reason: string }[];
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Strip // and /* *\/ comments + trailing commas from JSONC (tsconfig). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i] as string;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

function readJsonc(file: string): Record<string, unknown> | undefined {
  try {
    const v = parseJsonc(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Collect tsconfig text along `extends` (relative only) and `references` (bounded, iterative). */
function tsconfigChain(start: string): { text: string; references: string[] } {
  const seen = new Set<string>();
  const queue = [start];
  const refs: string[] = [];
  let text = "";
  while (queue.length > 0 && seen.size < 64) {
    const f = queue.shift() as string;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    try {
      text += `\n--${toPosix(f)}--\n${readFileSync(f, "utf8")}`;
    } catch {
      continue;
    }
    const json = readJsonc(f);
    if (!json) continue;
    const ext = json.extends;
    for (const e of Array.isArray(ext) ? ext : ext ? [ext] : []) {
      if (typeof e === "string" && (e.startsWith(".") || path.isAbsolute(e))) {
        const p = path.resolve(path.dirname(f), e);
        queue.push(p.endsWith(".json") ? p : `${p}.json`);
      }
    }
    if (Array.isArray(json.references)) {
      for (const r of json.references) {
        const rp = (r as { path?: unknown })?.path;
        if (typeof rp !== "string") continue;
        let p = path.resolve(path.dirname(f), rp);
        if (!p.endsWith(".json")) p = path.join(p, "tsconfig.json");
        refs.push(p);
        queue.push(p);
      }
    }
  }
  return { text, references: refs };
}

async function discoverWorkspaces(root: string): Promise<WorkspacePackage[]> {
  const patterns: string[] = [];
  const pkg = readJsonc(path.join(root, "package.json"));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) patterns.push(...ws.filter((x): x is string => typeof x === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    patterns.push(
      ...((ws as { packages: unknown[] }).packages.filter((x) => typeof x === "string") as string[]),
    );
  }
  const pnpm = path.join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    try {
      const y = parseYaml(readFileSync(pnpm, "utf8")) as { packages?: unknown } | null;
      if (Array.isArray(y?.packages))
        patterns.push(...y.packages.filter((x): x is string => typeof x === "string"));
    } catch {
      // best effort
    }
  }
  const positive = patterns.filter((p) => !p.startsWith("!"));
  if (positive.length === 0) return [];
  const pkgFiles = await glob(
    positive.map((p) => `${p.replace(/\/+$/, "")}/package.json`),
    {
      cwd: root,
      ignore: ["**/node_modules/**", ...patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1))],
      followSymbolicLinks: false,
      expandDirectories: false,
    },
  );
  const out: WorkspacePackage[] = [];
  for (const rel of pkgFiles.sort()) {
    const json = readJsonc(path.join(root, rel));
    if (!json || typeof json.name !== "string") continue;
    const dir = path.posix.dirname(toPosix(rel));
    const entry = workspaceEntry(root, dir, json);
    out.push(entry ? { name: json.name, dir, entry } : { name: json.name, dir });
  }
  return out;
}

function workspaceEntry(root: string, dir: string, json: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];
  for (const k of ["source", "types", "typings", "module", "main"]) {
    const v = json[k];
    if (typeof v === "string") {
      candidates.push(v);
      // dist → src heuristic: dist/index.js → src/index.ts
      candidates.push(v.replace(/^\.?\/?(dist|build|lib)\//, "src/").replace(/\.(d\.ts|js|mjs|cjs)$/, ".ts"));
    }
  }
  candidates.push("src/index.ts", "src/index.tsx", "index.ts", "src/index.js", "index.js");
  for (const c of candidates) {
    const rel = path.posix.normalize(`${dir}/${c.replace(/^\.\//, "")}`);
    if (existsSync(path.join(root, rel)) && !/\.d\.[mc]?ts$/.test(rel)) return rel;
  }
  return undefined;
}

async function looksGenerated(abs: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(abs, "r");
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    return /@generated\b|DO NOT EDIT|auto-generated by|This file was automatically generated/i.test(head);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

export async function discover(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const root = path.resolve(opts.root);
  const limitations: FactLimitation[] = [];
  const skipped: { file: string; reason: string }[] = [];

  let tsconfig: string | undefined;
  if (opts.tsconfig) {
    const p = path.resolve(root, opts.tsconfig);
    if (existsSync(p)) tsconfig = p;
    else
      limitations.push({
        code: "ARCH_TSCONFIG_MISSING",
        message: `tsconfig not found: ${opts.tsconfig}; using defaults`,
      });
  } else if (existsSync(path.join(root, "tsconfig.json"))) tsconfig = path.join(root, "tsconfig.json");
  const chain = tsconfig ? tsconfigChain(tsconfig) : { text: "", references: [] };

  const workspaces = await discoverWorkspaces(root);

  const raw = await glob(opts.include && opts.include.length > 0 ? opts.include : DEFAULT_INCLUDE, {
    cwd: root,
    ignore: [...DEFAULT_IGNORES, ...opts.exclude],
    dot: false,
    followSymbolicLinks: false,
    expandDirectories: false,
    onlyFiles: true,
  });

  // .gitignore (nested) + .swignore (root), applied relative to each ignore file's directory.
  const ignorers: { dir: string; ig: Ignore }[] = [];
  const ignoreFiles = await glob(opts.gitignore ? ["**/.gitignore", ".swignore"] : [".swignore"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/.git/**"],
    dot: true,
    followSymbolicLinks: false,
    expandDirectories: false,
  });
  for (const f of ignoreFiles.sort()) {
    try {
      ignorers.push({
        dir: path.posix.dirname(toPosix(f)),
        ig: ignore().add(readFileSync(path.join(root, f), "utf8")),
      });
    } catch {
      // unreadable ignore file: skip
    }
  }
  const isIgnored = (rel: string): boolean => {
    for (const { dir, ig } of ignorers) {
      if (dir === ".") {
        if (ig.ignores(rel)) return true;
      } else if (rel.startsWith(`${dir}/`) && ig.ignores(rel.slice(dir.length + 1))) return true;
    }
    return false;
  };

  const files: string[] = [];
  for (const r of raw.map(toPosix).sort()) {
    if (isIgnored(r)) continue;
    const abs = path.join(root, r);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > opts.maxFileSizeBytes) {
      skipped.push({ file: r, reason: `larger than ${opts.maxFileSizeBytes} bytes` });
      continue;
    }
    if (await looksGenerated(abs)) {
      skipped.push({ file: r, reason: "generated file" });
      continue;
    }
    files.push(r);
  }
  if (files.length > opts.maxFiles) {
    limitations.push({
      code: "ARCH_MAX_FILES",
      message: `${files.length} source files found; only the first ${opts.maxFiles} (sorted) were analysed (maxFiles)`,
    });
    files.length = opts.maxFiles;
  }
  if (skipped.length > 0) {
    limitations.push({
      code: "ARCH_FILES_SKIPPED",
      message: `${skipped.length} file(s) skipped (too large or generated), e.g. ${skipped
        .slice(0, 3)
        .map((s) => `${s.file} (${s.reason})`)
        .join(", ")}`,
    });
  }
  const unsupported = await glob([UNSUPPORTED_GLOB], {
    cwd: root,
    ignore: [...DEFAULT_IGNORES, ...opts.exclude],
    followSymbolicLinks: false,
    expandDirectories: false,
  });
  if (unsupported.length > 0) {
    const exts = [...new Set(unsupported.map((f) => path.extname(f)))].sort().join(", ");
    limitations.push({
      code: "ARCH_UNSUPPORTED_LANGUAGE",
      message: `${unsupported.length} file(s) in unsupported languages (${exts}) were not analysed`,
    });
  }
  if (chain.references.length > 0) {
    limitations.push({
      code: "ARCH_TSCONFIG_REFERENCES",
      message: `tsconfig has ${chain.references.length} project reference(s); one combined program with the root compilerOptions is used`,
    });
  }
  const result: DiscoveryResult = {
    root,
    files,
    tsconfigReferences: chain.references,
    tsconfigText: chain.text,
    workspaces,
    limitations,
    skipped,
  };
  if (tsconfig) result.tsconfig = tsconfig;
  return result;
}
