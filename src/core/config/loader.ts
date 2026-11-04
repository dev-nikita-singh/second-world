/**
 * Config loader. See docs/08-configuration.md §1 (sources & precedence) and §5 (formats).
 *
 * Precedence (highest wins): overrides (CLI flags) > --set > env (SW_*) > profile > project file
 * (> its extends chain) > user config > defaults.
 *
 * TS/JS configs are loaded through c12/jiti. This is the ONLY place user code executes, and
 * `noConfigCode` restricts loading to JSON/YAML. Every leaf records its origin for
 * `sw config print --resolved` and error messages.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { z } from "zod";
import { ConfigError } from "../errors.js";
import { createRedactor } from "../log/redact.js";
import { CONFIG_SECTIONS, type Config, ConfigSchema, type SecretRef } from "./schema.js";

export const CONFIG_FILE_NAMES = [
  "sw.config.ts",
  "sw.config.mts",
  "sw.config.js",
  "sw.config.mjs",
  "sw.config.cjs",
  "sw.config.json",
  "sw.config.yaml",
  "sw.config.yml",
  ".swrc",
];
const CODE_EXT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config path, or `false` to skip file discovery (inline/defaults only). */
  configFile?: string | false;
  /** Inline config object used instead of a file (programmatic API). */
  inline?: Record<string, unknown>;
  profile?: string;
  /** Highest-precedence nested overrides (mapped CLI flags). */
  overrides?: Record<string, unknown>;
  /** `--set key=value` strings. */
  set?: string[];
  env?: NodeJS.ProcessEnv;
  /** Only JSON/YAML configs (no code execution). */
  noConfigCode?: boolean;
  /** Load the per-user config (`<config-dir>/second-world/config.{json,yaml}`); default true. */
  userConfig?: boolean;
}

export interface ResolvedConfig {
  config: Config;
  /** Absolute path of the project config file, if any. */
  configFile?: string;
  profile?: string;
  /** Leaf path → source label ("default", "sw.config.ts", "profile ci", "env SW_X", "--set", "flag"). */
  origins: Record<string, string>;
  /** Raw merged (pre-validation) object. */
  raw: Record<string, unknown>;
  warnings: string[];
  /** Project directory: the config file's folder (paths inside the config are relative to it); else the invocation cwd. */
  cwd: string;
  /** Directory the command was run from: paths typed on the command line are relative to it. */
  invocationCwd?: string;
}

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Deep merge `src` into `dst` (mutating). Arrays and scalars replace. Records leaf origins. */
export function mergeLayer(
  dst: Obj,
  src: Obj,
  label: string,
  origins: Record<string, string>,
  prefix = "",
): Obj {
  const stack: Array<{ d: Obj; s: Obj; p: string }> = [{ d: dst, s: src, p: prefix }];
  while (stack.length > 0) {
    const { d, s, p } = stack.pop() as { d: Obj; s: Obj; p: string };
    for (const [k, v] of Object.entries(s)) {
      if (v === undefined) continue;
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const path = p ? `${p}.${k}` : k;
      if (isPlainObject(v) && !isSecretRef(v)) {
        if (!isPlainObject(d[k])) {
          d[k] = {};
          clearOrigins(origins, path);
        }
        stack.push({ d: d[k] as Obj, s: v, p: path });
      } else {
        d[k] = Array.isArray(v) ? [...v] : v;
        clearOrigins(origins, path);
        origins[path] = label;
      }
    }
  }
  return dst;
}

function clearOrigins(origins: Record<string, string>, path: string): void {
  for (const k of Object.keys(origins)) if (k === path || k.startsWith(`${path}.`)) delete origins[k];
}

function isSecretRef(v: unknown): v is SecretRef {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length === 1 && (keys[0] === "env" || keys[0] === "file") && typeof v[keys[0] as string] === "string"
  );
}

/** Coerces env/--set string values: booleans, numbers, JSON arrays/objects, else string. */
export function coerceValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  return raw;
}

function camel(seg: string): string {
  return seg.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

const ENV_SECTION_ALIASES: Record<string, string> = {
  PERF: "performance",
  ARCH: "architecture",
  ENV: "environment",
};
const ENV_IGNORED = new Set(["SW_CONFIG", "SW_PROFILE", "SW_NO_CONFIG_CODE", "SW_LOG_LEVEL"]);

/** Builds the env overlay: `SW_REPORT__FAIL_ON` → report.failOn, `SW_PERF_RATE` → performance.rate, `SW_TARGET` → performance.target. */
export function envOverlay(env: NodeJS.ProcessEnv): { layer: Obj; sources: Record<string, string> } {
  const layer: Obj = {};
  const sources: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("SW_") || value === undefined || ENV_IGNORED.has(name)) continue;
    const rest = name.slice(3);
    let path: string[];
    if (rest === "TARGET") path = ["performance", "target"];
    else if (rest.includes("__")) {
      const segs = rest.split("__").filter(Boolean);
      const head = segs[0] as string;
      path = [ENV_SECTION_ALIASES[head] ?? camel(head), ...segs.slice(1).map(camel)];
    } else {
      const idx = rest.indexOf("_");
      if (idx < 0) path = [ENV_SECTION_ALIASES[rest] ?? camel(rest)];
      else {
        const head = rest.slice(0, idx);
        path = [ENV_SECTION_ALIASES[head] ?? camel(head), camel(rest.slice(idx + 1))];
      }
    }
    if (!CONFIG_SECTIONS.includes(path[0] as string) || path[0]?.startsWith("$")) continue; // e.g. SW_TEST_USER_TOKEN secrets
    setPath(layer, path, coerceValue(value));
    sources[path.join(".")] = `env ${name}`;
  }
  return { layer, sources };
}

export function setPath(obj: Obj, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string;
    if (k === "__proto__" || k === "constructor" || k === "prototype") return;
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  }
  const last = path[path.length - 1] as string;
  if (last === "__proto__" || last === "constructor" || last === "prototype") return;
  cur[last] = value;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Obj)[k];
  }
  return cur;
}

/** Parses `--set a.b.c=value` into a nested layer. */
export function parseSetArgs(sets: string[]): Obj {
  const layer: Obj = {};
  for (const s of sets) {
    const eq = s.indexOf("=");
    if (eq <= 0) {
      throw new ConfigError("SW_CONFIG_SET", `Invalid --set "${s}": expected key=value`, {
        hint: "Example: --set performance.rate=200",
      });
    }
    const key = s.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(key)) {
      throw new ConfigError("SW_CONFIG_SET", `Invalid --set key "${key}"`, {
        hint: "Use dotted keys, e.g. safety.maxRps",
      });
    }
    setPath(layer, key.split("."), coerceValue(s.slice(eq + 1)));
  }
  return layer;
}

function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walks up from cwd to the git root (or home / filesystem root) looking for a config file. */
export function discoverConfigFile(cwd: string): string | undefined {
  const stopAt = findGitRoot(cwd);
  const home = safeHome();
  let dir = cwd;
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const p = join(dir, name);
      if (existsSync(p) && safeIsFile(p)) return p;
    }
    if (stopAt && dir === stopAt) return undefined;
    const parent = dirname(dir);
    if (parent === dir || (!stopAt && home && dir === home)) return undefined;
    dir = parent;
  }
}

function safeHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

async function parseDataFile(file: string): Promise<Obj> {
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (e) {
    throw new ConfigError("SW_CONFIG_READ", `Cannot read config file ${file}: ${(e as Error).message}`);
  }
  try {
    if (extname(file) === ".json") return (JSON.parse(text) ?? {}) as Obj;
    const YAML = await import("yaml");
    const v = YAML.parse(text) as unknown;
    if (v == null) return {};
    if (!isPlainObject(v)) throw new Error("top level must be a mapping/object");
    return v;
  } catch (e) {
    throw new ConfigError("SW_CONFIG_PARSE", `Cannot parse ${basename(file)}: ${(e as Error).message}`, {
      hint: "Check the file's JSON/YAML syntax",
      details: { file },
    });
  }
}

/** Loads a JSON/YAML file and its local `extends` chain (bounded depth). Returns layers lowest-first. */
async function loadDataChain(file: string, depth = 0): Promise<Array<{ data: Obj; file: string }>> {
  if (depth > 10) throw new ConfigError("SW_CONFIG_EXTENDS", `extends chain too deep at ${file}`);
  const data = await parseDataFile(file);
  const ext = data.extends;
  delete data.extends;
  const layers: Array<{ data: Obj; file: string }> = [];
  const list = ext === undefined ? [] : Array.isArray(ext) ? ext : [ext];
  for (const e of list) {
    if (typeof e !== "string")
      throw new ConfigError("SW_CONFIG_EXTENDS", `extends must be a string or string[] in ${file}`);
    if (!e.startsWith(".") && !isAbsolute(e)) {
      throw new ConfigError("SW_CONFIG_EXTENDS", `extends "${e}": package presets require a TS/JS config`, {
        hint: "Use a relative path in JSON/YAML configs, or switch to sw.config.ts",
      });
    }
    const p = resolve(dirname(file), e);
    if (!existsSync(p)) throw new ConfigError("SW_CONFIG_EXTENDS", `extends target not found: ${p}`);
    layers.push(...(await loadDataChain(p, depth + 1)));
  }
  layers.push({ data, file });
  return layers;
}

async function loadCodeFile(file: string): Promise<Obj> {
  try {
    const c12 = await import("c12");
    const r = await c12.loadConfig({
      name: "sw",
      cwd: dirname(file),
      configFile: file,
      rcFile: false,
      globalRc: false,
      dotenv: false,
      packageJson: false,
      envName: false,
      configFileRequired: true,
    });
    const cfg = (r.config ?? {}) as Obj;
    delete cfg.extends;
    return cfg;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError("SW_CONFIG_LOAD", `Failed to load ${basename(file)}: ${(e as Error).message}`, {
      cause: e,
      hint: "Fix the error in your config file (it is executed as code), or use --no-config-code with a JSON/YAML config",
      details: { file },
    });
  }
}

async function loadUserConfig(env: NodeJS.ProcessEnv): Promise<{ data: Obj; file: string } | null> {
  try {
    const envPaths = (await import("env-paths")).default;
    const dir = env.SW_USER_CONFIG_DIR ?? envPaths("second-world", { suffix: "" }).config;
    for (const n of ["config.json", "config.yaml", "config.yml"]) {
      const p = join(dir, n);
      if (existsSync(p)) {
        const data = await parseDataFile(p);
        // only non-project settings
        const picked: Obj = {};
        for (const k of ["ui"]) if (data[k] !== undefined) picked[k] = data[k];
        return { data: picked, file: p };
      }
    }
  } catch {
    // user config is optional
  }
  return null;
}

/**
 * Loads a standalone object file (experiment definitions, presets): TS/JS via c12/jiti (default
 * export), JSON/YAML parsed directly. `noConfigCode` refuses code files (SW_CONFIG_CODE_DISABLED).
 */
export async function loadObjectFile(
  file: string,
  opts: { noConfigCode?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (!existsSync(file)) throw new ConfigError("SW_CONFIG_NOT_FOUND", `File not found: ${file}`);
  if (CODE_EXT.has(extname(file))) {
    if (opts.noConfigCode) {
      throw new ConfigError(
        "SW_CONFIG_CODE_DISABLED",
        `Refusing to execute ${basename(file)}: --no-config-code is set`,
        {
          hint: "Use a JSON/YAML file instead",
        },
      );
    }
    return loadCodeFile(file);
  }
  return parseDataFile(file);
}

/** Finds raw strings in the file layer that look like secrets (docs/08 §3 Secrets). */
function secretWarnings(data: Obj, label: string): string[] {
  const r = createRedactor({ entropy: false });
  const out: string[] = [];
  const stack: Array<{ v: unknown; p: string }> = [{ v: data, p: "" }];
  while (stack.length > 0) {
    const { v, p } = stack.pop() as { v: unknown; p: string };
    if (typeof v === "string") {
      const keyLooksSecret = /(password|secret|token|apikey|api_key|clientsecret)$/i.test(
        p.split(".").pop() ?? "",
      );
      if (r.redactString(v) !== v || (keyLooksSecret && v.length >= 8)) {
        out.push(
          `Literal string at ${p} in ${label} looks like a secret (log output would redact it); use { env: "NAME" } or { file: "path" } instead`,
        );
      }
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], p: `${p}[${i}]` });
    } else if (isPlainObject(v))
      for (const [k, x] of Object.entries(v)) stack.push({ v: x, p: p ? `${p}.${k}` : k });
  }
  return out;
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : String(p)))
    .join(".")
    .replace(/\.\[/g, "[");
}

/** Unwraps optional/default/nullable/pipe wrappers of a Zod v4 schema (introspection only). */
function unwrapSchema(s: unknown): unknown {
  for (let i = 0; i < 16; i++) {
    const def = (s as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod?.def;
    if (!def) return s;
    const t = def.type;
    if (t === "optional" || t === "default" || t === "nullable" || t === "prefault" || t === "readonly")
      s = def.innerType;
    else if (t === "pipe") s = def.in;
    else return s;
  }
  return s;
}

/** Keys `root` accepts for the object at `path` ([] when it is not a fixed-shape object). */
function objectKeysAt(root: unknown, path: ReadonlyArray<PropertyKey>): string[] {
  let s = unwrapSchema(root);
  for (const seg of path) {
    const def = (s as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (def?.type === "object") s = (def.shape as Record<string, unknown>)[String(seg)];
    else if (def?.type === "record") s = def.valueType;
    else if (def?.type === "array") s = def.element;
    else return [];
    s = unwrapSchema(s);
  }
  const def = (s as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
  return def?.type === "object" ? Object.keys(def.shape as Record<string, unknown>) : [];
}

/** Keys the config schema accepts for the object at `path` ([] when it is not a fixed-shape object). */
export function knownConfigKeys(path: ReadonlyArray<PropertyKey>): string[] {
  return objectKeysAt(ConfigSchema, path);
}

/** Levenshtein distance (iterative, two rows); inputs are short config keys. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** Closest known key for a typo: same key ignoring case/-/_, else edit distance ≤ 2 (and < half its length). */
export function suggestKey(key: string, known: readonly string[]): string | undefined {
  const norm = (k: string): string => k.toLowerCase().replace(/[-_]/g, "");
  const same = known.find((k) => norm(k) === norm(key));
  if (same !== undefined) return same;
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const k of known) {
    const d = editDistance(key.toLowerCase(), k.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD <= 2 && bestD < key.length / 2 ? best : undefined;
}

export interface ConfigIssue {
  /** Full dotted path, e.g. `performance.scenarios[0].steps`; "" for the root. */
  path: string;
  message: string;
}

/**
 * Readable issues of a ZodError: one per unknown key (full path + "did you mean"), else the issue
 * path and message. `prefix` is prepended to every path (an engine section such as
 * `["performance"]`); `schema` is the schema that produced `err` (suggestions come from its keys).
 * Shared by the config loader and the engines' parse*Input functions (docs/08 §6).
 */
export function zodIssueLines(
  err: z.ZodError,
  opts: { prefix?: ReadonlyArray<PropertyKey>; schema?: unknown } = {},
): ConfigIssue[] {
  const prefix = opts.prefix ?? [];
  const schema = opts.schema ?? ConfigSchema;
  const issues: ConfigIssue[] = [];
  for (const i of err.issues) {
    if (i.code === "unrecognized_keys") {
      const known = objectKeysAt(schema, i.path);
      for (const key of (i as { keys?: string[] }).keys ?? []) {
        const hint = suggestKey(key, known);
        issues.push({
          path: issuePath([...prefix, ...i.path, key]),
          message: `Unknown key${hint ? ` (did you mean "${hint}"?)` : ""}`,
        });
      }
      continue;
    }
    issues.push({ path: issuePath([...prefix, ...i.path]), message: i.message });
  }
  return issues;
}

/** Converts a ZodError into a ConfigError with key paths and their sources. */
export function zodToConfigError(err: z.ZodError, origins: Record<string, string>): ConfigError {
  const originOf = (p: string): string | undefined => {
    const own = origins[p];
    if (own) return own;
    // look for a parent or child origin
    const parent = Object.keys(origins).find((k) => p.startsWith(`${k}.`));
    return parent ? origins[parent] : Object.entries(origins).find(([k]) => k.startsWith(`${p}.`))?.[1];
  };
  const issues = zodIssueLines(err);
  const lines = issues.map((i) => {
    const origin = originOf(i.path);
    return `  ${i.path || "(root)"}: ${i.message}${origin ? `   ← from ${origin}` : ""}`;
  });
  return new ConfigError("SW_CONFIG_INVALID", `Config error\n${lines.join("\n")}`, {
    hint: "Fix the listed keys. `sw config print --resolved` shows where each value comes from",
    details: { issues },
  });
}

/**
 * Runs `fn`; a ConfigError it throws gets `section.` prefixed to its message (unless already
 * there), so errors raised on an engine's input name the config path (e.g. `stress.thresholds.http`).
 */
export function inConfigSection<T>(section: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ConfigError && !e.message.startsWith(`${section}.`)) {
      throw new ConfigError(e.code as `SW_CONFIG_${string}`, `${section}.${e.message}`, {
        ...(e.hint !== undefined ? { hint: e.hint } : {}),
        ...(e.details !== undefined ? { details: e.details } : {}),
      });
    }
    throw e;
  }
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const origins: Record<string, string> = {};
  const warnings: string[] = [];
  const merged: Obj = {};

  // 6. user config
  if (opts.userConfig !== false) {
    const u = await loadUserConfig(env);
    if (u) mergeLayer(merged, u.data, `user ${u.file}`, origins);
  }

  // 4/5. project file (+ extends) or inline config
  let configFile: string | undefined;
  if (opts.inline) {
    const inline = { ...opts.inline };
    delete inline.extends;
    mergeLayer(merged, inline, "inline", origins);
  } else if (opts.configFile !== false) {
    if (typeof opts.configFile === "string") {
      configFile = resolve(cwd, opts.configFile);
      if (!existsSync(configFile)) {
        throw new ConfigError("SW_CONFIG_NOT_FOUND", `Config file not found: ${configFile}`, {
          hint: "Check the --config path, or omit it to auto-discover sw.config.*",
        });
      }
    } else {
      configFile = discoverConfigFile(cwd);
    }
    if (configFile) {
      const ext = extname(configFile);
      const label = basename(configFile);
      if (CODE_EXT.has(ext)) {
        if (opts.noConfigCode) {
          throw new ConfigError(
            "SW_CONFIG_CODE_DISABLED",
            `Refusing to execute ${label}: --no-config-code is set`,
            {
              hint: "Provide sw.config.json or sw.config.yaml, or drop --no-config-code for trusted repositories",
            },
          );
        }
        const data = await loadCodeFile(configFile);
        warnings.push(...secretWarnings(data, label));
        mergeLayer(merged, data, label, origins);
      } else {
        for (const layer of await loadDataChain(configFile)) {
          const l = basename(layer.file);
          warnings.push(...secretWarnings(layer.data, l));
          mergeLayer(merged, layer.data, l, origins);
        }
      }
    }
  }

  // 3. profile
  if (opts.profile) {
    const profiles = (merged.profiles ?? {}) as Obj;
    const p = profiles[opts.profile];
    if (!isPlainObject(p)) {
      const avail = Object.keys(profiles);
      throw new ConfigError("SW_CONFIG_PROFILE", `Unknown profile "${opts.profile}"`, {
        hint: avail.length
          ? `Available profiles: ${avail.join(", ")}`
          : "No profiles are defined in the config",
      });
    }
    mergeLayer(merged, p, `profile ${opts.profile}`, origins);
  }

  // 2. env
  const { layer: envLayer, sources } = envOverlay(env);
  mergeLayer(merged, envLayer, "env", origins);
  for (const [k, v] of Object.entries(sources)) if (origins[k] === "env") origins[k] = v;

  // 1. --set then flags
  if (opts.set?.length) mergeLayer(merged, parseSetArgs(opts.set), "--set", origins);
  if (opts.overrides) mergeLayer(merged, stripUndefinedDeep(opts.overrides), "flag", origins);

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw zodToConfigError(parsed.error, origins);

  return {
    config: parsed.data,
    ...(configFile ? { configFile } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
    origins,
    raw: merged,
    warnings,
    cwd: configFile ? dirname(configFile) : cwd,
    invocationCwd: cwd,
  };
}

function stripUndefinedDeep(o: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) ? stripUndefinedDeep(v) : v;
  }
  return out;
}

/** Resolves a secret reference at runtime. Never logs the value. */
export function resolveSecret(ref: SecretRef, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  if ("env" in ref) {
    const v = (opts.env ?? process.env)[ref.env];
    if (v === undefined || v === "") {
      throw new ConfigError("SW_CONFIG_SECRET", `Secret env var ${ref.env} is not set`, {
        hint: `export ${ref.env}=...`,
      });
    }
    return v;
  }
  try {
    return readFileSync(resolve(opts.cwd ?? process.cwd(), ref.file), "utf8").trim();
  } catch {
    throw new ConfigError("SW_CONFIG_SECRET", `Secret file ${ref.file} cannot be read`);
  }
}

/** Resolves every `{env}`/`{file}` ref that is available and returns the values (for the redactor deny-set). */
export function collectSecretValues(
  config: unknown,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string[] {
  const out: string[] = [];
  const stack: unknown[] = [config];
  while (stack.length > 0) {
    const v = stack.pop();
    if (isSecretRef(v)) {
      try {
        out.push(resolveSecret(v, opts));
      } catch {
        // unresolved secrets are reported when used
      }
    } else if (Array.isArray(v)) stack.push(...v);
    else if (isPlainObject(v)) stack.push(...Object.values(v));
  }
  return out;
}

/** Masks secret refs' resolved values and secret-looking strings for `sw config print`. */
export function maskConfig<T>(config: T): T {
  return createRedactor().redactObject(config);
}
