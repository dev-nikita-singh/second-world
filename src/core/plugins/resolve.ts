/**
 * Plugin module resolution (docs/10-plugins-and-extensibility.md §3): a package name is resolved from
 * the PROJECT's node_modules (walking up from the config folder, like Node), a relative path against
 * the config folder. Never from SECOND WORLD's own install, never auto-discovered.
 *
 * Package entry selection follows package.json `exports` with the conditions `node`, `import`,
 * `module-sync`, `default` (ESM first, in key order like Node), then `main`, then `index.js`;
 * `createRequire(<projectDir>/package.json).resolve()` is the last resort (CJS-only exports maps).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "../errors.js";

const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(\/[A-Za-z0-9._~/-]+)?$/;
const CONDITIONS = new Set(["node", "import", "module-sync", "default"]);

export function isRelativeSpec(spec: string): boolean {
  return spec === "." || spec === ".." || /^\.\.?[\\/]/.test(spec);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves an `exports` target for the conditions above (bounded loop, no recursion). */
function conditionalTarget(target: unknown): string | undefined {
  let cur: unknown = target;
  for (let depth = 0; depth < 16; depth++) {
    if (typeof cur === "string") return cur;
    if (Array.isArray(cur)) {
      cur = cur.find((x) => typeof x === "string" || (x !== null && typeof x === "object"));
      continue;
    }
    if (cur === null || typeof cur !== "object") return undefined;
    const key = Object.keys(cur).find((k) => CONDITIONS.has(k));
    if (key === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return undefined;
}

function exportsEntry(exportsField: unknown, subpath: string): string | undefined {
  if (exportsField === null || exportsField === undefined) return undefined;
  const isSubpathMap =
    typeof exportsField === "object" &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((k) => k.startsWith("."));
  if (!isSubpathMap) return subpath === "." ? conditionalTarget(exportsField) : undefined;
  return conditionalTarget((exportsField as Record<string, unknown>)[subpath]);
}

function readPkg(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Entry file of a package (or plugin) directory. */
function dirEntry(dir: string, subpath = "."): string | undefined {
  const pkg = readPkg(dir);
  if (pkg && pkg.exports !== undefined) {
    const t = exportsEntry(pkg.exports, subpath);
    return t !== undefined && isFile(join(dir, t)) ? join(dir, t) : undefined;
  }
  if (subpath !== ".") {
    const p = join(dir, subpath);
    for (const c of [p, `${p}.js`, `${p}.mjs`, join(p, "index.js")]) if (isFile(c)) return c;
    return undefined;
  }
  if (pkg && typeof pkg.main === "string") {
    const m = join(dir, pkg.main);
    for (const c of [m, `${m}.js`, join(m, "index.js")]) if (isFile(c)) return c;
  }
  for (const c of ["index.js", "index.mjs", "index.cjs"]) if (isFile(join(dir, c))) return join(dir, c);
  return undefined;
}

function splitPackage(spec: string): { pkg: string; subpath: string } {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const pkg = parts.slice(0, n).join("/");
  const rest = parts.slice(n).join("/");
  return { pkg, subpath: rest ? `./${rest}` : "." };
}

/** Absolute file path of a plugin module. Throws ConfigError SW_CONFIG_PLUGIN_NOT_FOUND / _PATH. */
export function resolvePluginModule(spec: string, projectDir: string): string {
  if (isAbsolute(spec)) {
    throw new ConfigError("SW_CONFIG_PLUGIN_PATH", `plugin "${spec}": absolute paths are not accepted`, {
      hint: "Use a package name (installed in the project's node_modules) or a path relative to the config file",
    });
  }
  if (isRelativeSpec(spec)) {
    const p = resolve(projectDir, spec);
    const file = isDir(p) ? dirEntry(p) : [p, `${p}.js`, `${p}.mjs`].find(isFile);
    if (!file) {
      throw new ConfigError("SW_CONFIG_PLUGIN_NOT_FOUND", `plugin "${spec}": no module at ${p}`, {
        hint: "Relative plugin paths resolve against the config file's folder",
      });
    }
    return file;
  }
  if (!PKG_NAME_RE.test(spec)) {
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_PATH",
      `plugin "${spec}" is not a package name or relative path`,
      {
        hint: 'Examples: "@acme/sw-plugin", "sw-plugin-foo", "./plugins/local.mjs"',
      },
    );
  }
  const { pkg, subpath } = splitPackage(spec);
  let dir = resolve(projectDir);
  for (let i = 0; i < 64; i++) {
    const cand = join(dir, "node_modules", pkg);
    if (existsSync(join(cand, "package.json")) || isDir(cand)) {
      const file = dirEntry(cand, subpath);
      if (file) return file;
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    return createRequire(join(resolve(projectDir), "package.json")).resolve(spec);
  } catch {
    throw new ConfigError(
      "SW_CONFIG_PLUGIN_NOT_FOUND",
      `plugin "${spec}" is not installed in the project (searched node_modules from ${resolve(projectDir)} upwards)`,
      { hint: `Install it in the project: npm i -D ${pkg}` },
    );
  }
}
