/**
 * `sw init` — project detection + config scaffold. See docs/09-cli-and-api.md §1 (init) and
 * docs/11-safety-security-privacy.md §8 (responsible use). Detection is read-only (package.json,
 * lockfiles, files on disk); nothing is executed. Writes sw.config.ts with local-only safety and
 * adds `.second-world/` to .gitignore. Never overwrites an existing config without --force.
 * With an OpenAPI contract: the target comes from servers[0] (when local) and the perf scenario is a
 * GET that needs no auth and no required parameters, so the first `sw perf` measures a real route.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parse as parseYaml } from "yaml";
import { CONFIG_FILE_NAMES } from "../../core/config/loader.js";
import { ConfigError } from "../../core/errors.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style } from "../output.js";

export interface ProjectDetection {
  root: string;
  name?: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  frameworks: string[];
  openapi?: string;
  startScript?: string;
  tsconfig?: string;
  typescript: boolean;
  existingConfig?: string;
}

const FRAMEWORK_DEPS: Array<[string, string]> = [
  ["express", "express"],
  ["fastify", "fastify"],
  ["@nestjs/core", "nest"],
  ["hono", "hono"],
  ["koa", "koa"],
  ["next", "next"],
];

const OPENAPI_CANDIDATES = [
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "swagger.yaml",
  "swagger.yml",
  "swagger.json",
  "docs/openapi.yaml",
  "docs/openapi.yml",
  "docs/openapi.json",
  "api/openapi.yaml",
  "api/openapi.yml",
  "api/openapi.json",
  "spec/openapi.yaml",
];

/** Read-only project detection. Never throws on malformed package.json. */
export function detectProject(root: string): ProjectDetection {
  let pkg: {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^﻿/, ""));
  } catch {
    // no / invalid package.json
  }
  let pm: ProjectDetection["packageManager"] = "npm";
  if (existsSync(join(root, "pnpm-lock.yaml"))) pm = "pnpm";
  else if (existsSync(join(root, "yarn.lock"))) pm = "yarn";
  else if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) pm = "bun";
  else if (existsSync(join(root, "package-lock.json"))) pm = "npm";
  else if (typeof pkg.packageManager === "string") {
    const n = pkg.packageManager.split("@")[0];
    if (n === "pnpm" || n === "yarn" || n === "bun" || n === "npm") pm = n;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const frameworks = FRAMEWORK_DEPS.filter(([d]) => d in deps).map(([, f]) => f);
  const scripts = pkg.scripts ?? {};
  const startScript = ["start:test", "start", "dev", "serve"].find((k) => typeof scripts[k] === "string");
  const openapi = OPENAPI_CANDIDATES.find((f) => existsSync(join(root, f)));
  const tsconfig = existsSync(join(root, "tsconfig.json")) ? "tsconfig.json" : undefined;
  const existingConfig = CONFIG_FILE_NAMES.find((f) => existsSync(join(root, f)));
  return {
    root,
    ...(pkg.name ? { name: pkg.name } : {}),
    packageManager: pm,
    frameworks,
    ...(openapi ? { openapi } : {}),
    ...(startScript ? { startScript } : {}),
    ...(tsconfig ? { tsconfig } : {}),
    typescript: Boolean(tsconfig) || "typescript" in deps,
    ...(existingConfig ? { existingConfig } : {}),
  };
}

const DEFAULT_ORIGIN = "http://127.0.0.1:3000";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);
const HEALTH_RE = /\/(health|healthz|healthcheck|ready|readyz|live|livez|ping)$/i;

/** What `sw init` takes from an OpenAPI contract (all optional; empty when it cannot be read). */
export interface ContractHints {
  /** Target URL from servers[0]: variables resolved; relative → default origin; remote → default origin + its path. */
  serverUrl?: string;
  /** Why servers[0] was not used as is. */
  serverNote?: string;
  /** A health-like GET without parameters (path below the server's base). */
  healthPath?: string;
  /** A GET with no auth and no required parameters, for the generated perf scenario. */
  perfGet?: { path: string; name: string };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Resolves a local `$ref` ("#/components/parameters/X"); undefined for remote refs. */
function deref(doc: Obj, v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined;
  const ref = v.$ref;
  if (typeof ref !== "string") return v;
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const seg of ref.slice(2).split("/")) {
    cur = isObj(cur) ? cur[seg.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  }
  return isObj(cur) ? cur : undefined;
}

function serverOf(doc: Obj): Pick<ContractHints, "serverUrl" | "serverNote"> {
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const first = servers[0];
  if (!isObj(first) || typeof first.url !== "string") return {};
  const declared = first.url;
  const vars = isObj(first.variables) ? first.variables : {};
  let unresolved = false;
  const raw = declared.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (isObj(v) && typeof v.default === "string") return v.default;
    unresolved = true;
    return "";
  });
  if (unresolved)
    return { serverNote: `servers[0] "${declared}" has a variable without a default: not used` };
  let url: URL;
  try {
    url = new URL(raw, `${DEFAULT_ORIGIN}/`);
  } catch {
    return { serverNote: `servers[0] "${declared}" is not a valid URL: not used` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return {};
  const path = url.pathname.replace(/\/+$/, "");
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (absolute && !LOCAL_HOSTS.has(url.hostname)) {
    return {
      serverUrl: `${DEFAULT_ORIGIN}${path}`,
      serverNote: `servers[0] ${url.origin} is not local: target set to ${DEFAULT_ORIGIN}${path} (edit targets.api to point at your local instance)`,
    };
  }
  const host = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
  const serverUrl = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${path}`;
  return absolute
    ? { serverUrl }
    : { serverUrl, serverNote: `servers[0] "${declared}" is relative: target set to ${serverUrl}` };
}

/** True when the operation can be called anonymously (no security, or an empty `{}` alternative). */
function anonymous(doc: Obj, op: Obj): boolean {
  const sec = Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : [];
  return sec.length === 0 || sec.some((r) => isObj(r) && Object.keys(r).length === 0);
}

/**
 * What `sw init` can use from an OpenAPI 3.x / Swagger document (YAML or JSON text). Pure and total:
 * an unreadable contract yields `{}`. Operations are taken in document order, `deprecated` ones are
 * skipped, and health-like paths are only the perf route when nothing else qualifies.
 */
export function contractHints(text: string): ContractHints {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return {};
  }
  if (!isObj(doc)) return {};
  const root = doc;
  const out: ContractHints = { ...serverOf(root) };
  const paths = isObj(root.paths) ? root.paths : {};
  let healthGet: ContractHints["perfGet"];
  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = deref(root, itemRaw);
    const op = item ? deref(root, item.get) : undefined;
    if (!item || !op || !path.startsWith("/") || path.includes("{") || op.deprecated === true) continue;
    const params = [
      ...(Array.isArray(item.parameters) ? item.parameters : []),
      ...(Array.isArray(op.parameters) ? op.parameters : []),
    ].map((p) => deref(root, p));
    if (params.some((p) => p === undefined || p.required === true || p.in === "path")) continue;
    if (deref(root, op.requestBody)?.required === true) continue;
    if (!anonymous(root, op)) continue;
    const name = typeof op.operationId === "string" && op.operationId ? op.operationId : `GET ${path}`;
    if (HEALTH_RE.test(path)) {
      out.healthPath ??= path;
      healthGet ??= { path, name };
      continue;
    }
    out.perfGet ??= { path, name };
  }
  if (!out.perfGet && healthGet) out.perfGet = healthGet;
  return out;
}

/** The target's base path + an operation path ("/api" + "/articles"); steps starting with "/" are origin-relative. */
function underBase(targetUrl: string, path: string): string {
  let base = "";
  try {
    base = new URL(targetUrl).pathname.replace(/\/+$/, "");
  } catch {
    // invalid URL: the config loader reports it
  }
  return `${base}${path}`;
}

export interface InitAnswers {
  targetUrl: string;
  healthPath: string;
}

function q(s: string): string {
  return JSON.stringify(s);
}

/** Renders sw.config.ts (plain object with a type-only import, so it loads even before install). */
export function renderConfig(d: ProjectDetection, a: InitAnswers, hints: ContractHints = {}): string {
  const pmRun = d.packageManager === "npm" ? ["npm", "run"] : [d.packageManager, "run"];
  const lines: string[] = [];
  lines.push(
    "// SECOND WORLD config — generated by `sw init`. Reference: docs/08-configuration.md; `sw config schema` prints the JSON Schema.",
  );
  lines.push("// Only test systems you own or are explicitly authorised to test.");
  lines.push('import type { ConfigInput } from "second-world";');
  lines.push("");
  lines.push("const config: ConfigInput = {");
  lines.push("  $schemaVersion: 1,");
  lines.push(`  project: { root: ".", name: ${q(d.name ?? "my-service")} },`);
  lines.push('  environment: "local",');
  lines.push("  targets: {");
  lines.push(`    api: { url: ${q(a.targetUrl)}, health: ${q(a.healthPath)} },`);
  lines.push("  },");
  lines.push("  safety: {");
  lines.push('    allowHosts: ["127.0.0.1", "localhost", "::1"],');
  lines.push("    allowPublic: false,");
  lines.push('    maxRps: 500, maxConcurrency: 200, maxRequests: 200_000, maxDuration: "15m",');
  lines.push("    allowMutations: false,");
  lines.push("    approveDisruptive: false,");
  lines.push("  },");
  if (d.startScript) {
    lines.push("  hooks: {");
    lines.push(
      `    start: { command: [${pmRun.map(q).join(", ")}, ${q(d.startScript)}], readyWhen: { http: ${q(a.healthPath)} }, timeout: "60s" },`,
    );
    lines.push("  },");
  }
  lines.push("  performance: {");
  lines.push('    target: "api",');
  lines.push('    rate: 50, duration: "30s", warmup: "5s",');
  if (hints.perfGet) {
    lines.push(
      `    // From ${d.openapi ?? "the OpenAPI contract"}: a GET that needs no auth and no required parameters.`,
    );
    lines.push(
      `    scenarios: [{ name: ${q(hints.perfGet.name)}, steps: [{ method: "GET", path: ${q(underBase(a.targetUrl, hints.perfGet.path))} }] }],`,
    );
  }
  lines.push('    thresholds: { "http.p95": "< 300ms", "http.error_rate": "< 1%" },');
  lines.push("  },");
  lines.push('  stress: { mode: "step", stages: [10, 25, 50, 100], hold: "20s" },');
  const archInclude = d.typescript ? '["src/**/*.ts"]' : '["src/**/*.js", "src/**/*.ts"]';
  lines.push(
    `  architecture: { include: ${archInclude}${d.tsconfig ? `, tsconfig: ${q(d.tsconfig)}` : ""} },`,
  );
  if (d.openapi) lines.push(`  bugs: { target: "api", openapi: ${q(`./${d.openapi}`)} },`);
  lines.push(
    '  report: { formats: ["tty", "json", "md"], outDir: ".second-world/reports", failOn: "high" },',
  );
  lines.push('  history: { dir: ".second-world/history" },');
  lines.push("  profiles: {");
  lines.push(
    '    ci: { performance: { rate: 20, duration: "60s" }, report: { formats: ["json", "junit", "md"] } },',
  );
  lines.push("  },");
  lines.push("};");
  lines.push("");
  lines.push("export default config;");
  lines.push("");
  return lines.join("\n");
}

/** Appends `.second-world/` to .gitignore (creating it) unless already ignored. Returns true if changed. */
export function ensureGitignore(root: string): boolean {
  const p = join(root, ".gitignore");
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    // create
  }
  const has = text.split(/\r?\n/).some((l) => /^\/?\.second-world\/?\s*$/.test(l.trim()));
  if (has) return false;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(
    p,
    `${text}${sep}# SECOND WORLD artifacts (reports, history, cache, audit log)\n.second-world/\n`,
    "utf8",
  );
  return true;
}

/**
 * What `sw init` found and what the user has to do next (pure; printed after the config is written).
 * Says plainly what was NOT detected, because every gap changes what the next command needs.
 */
export function initSummary(
  d: ProjectDetection,
  a: InitAnswers,
  o: { interactive: boolean; targetFlag: boolean },
  hints?: ContractHints,
): string[] {
  const lines: string[] = [];
  lines.push(
    `detected: ${d.packageManager} · frameworks: ${d.frameworks.join(", ") || "none"} · OpenAPI: ${d.openapi ?? "not found"} · start script: ${d.startScript ?? "not found"}`,
  );
  const fromServer = hints?.serverUrl !== undefined && hints.serverUrl === a.targetUrl;
  if (fromServer && hints?.serverNote) lines.push(hints.serverNote);
  if (fromServer && !hints?.serverNote) {
    lines.push(`target ${a.targetUrl} (from ${d.openapi} servers[0], health ${a.healthPath})`);
  } else if (!o.interactive && !o.targetFlag) {
    lines.push(
      `target ${a.targetUrl} (default, health ${a.healthPath}) — edit targets.api in sw.config.ts, or re-run \`sw init --force --target <url>\``,
    );
  } else {
    lines.push(`target ${a.targetUrl} (health ${a.healthPath})`);
  }
  if (!d.startScript) {
    lines.push(
      "no start script found: start your service yourself before running a test (hooks.start is not set)",
    );
  }
  if (!d.openapi) {
    lines.push("no OpenAPI file found: `sw bugs` needs one — set bugs.openapi in sw.config.ts");
  }
  if (hints?.perfGet) {
    lines.push(
      `perf scenario: GET ${underBase(a.targetUrl, hints.perfGet.path)} (from ${d.openapi}; add your own under performance.scenarios)`,
    );
  } else if (hints) {
    lines.push(
      `perf: ${d.openapi} has no GET without auth or required parameters, so \`sw perf\` sends GET / — add performance.scenarios`,
    );
  }
  lines.push("next: start your service, then run `sw doctor` and `sw perf`");
  return lines;
}

/**
 * Test seams for the interactive path (no real TTY needed): `cwd`, whether to prompt, and the
 * streams @clack/prompts reads keystrokes from / renders to.
 */
export interface InitIo {
  cwd?: string;
  interactive?: boolean;
  input?: Readable;
  output?: Writable;
}

export async function initCommand(
  o: { force?: boolean; json?: boolean; target?: string },
  g: GlobalOptions,
  io: InitIo = {},
): Promise<void> {
  const root = io.cwd ?? process.cwd();
  const s = style(colorEnabled(g));
  const d = detectProject(root);
  if (d.existingConfig && !o.force) {
    throw new ConfigError("SW_CONFIG_EXISTS", `A config already exists: ${d.existingConfig}`, {
      hint: "Re-run with --force to overwrite it, or edit it directly",
    });
  }
  let hints: ContractHints | undefined;
  if (d.openapi) {
    try {
      hints = contractHints(readFileSync(join(root, d.openapi), "utf8"));
    } catch {
      hints = {};
    }
  }
  const defaults: InitAnswers = {
    targetUrl: o.target ?? hints?.serverUrl ?? DEFAULT_ORIGIN,
    healthPath: hints?.healthPath ?? "/healthz",
  };
  let answers = defaults;
  const interactive =
    io.interactive ??
    (!g.yes && process.stdin.isTTY === true && process.stdout.isTTY === true && !process.env.CI);
  if (interactive) {
    const p = await import("@clack/prompts");
    const streams = {
      ...(io.input === undefined ? {} : { input: io.input }),
      ...(io.output === undefined ? {} : { output: io.output }),
    };
    p.intro("SECOND WORLD init", streams);
    p.note(
      [
        `package manager: ${d.packageManager}`,
        `frameworks: ${d.frameworks.join(", ") || "none detected"}`,
        `OpenAPI: ${d.openapi ?? "not found"}`,
        `start script: ${d.startScript ?? "not found"}`,
      ].join("\n"),
      "Detected",
      streams,
    );
    const url = await p.text({
      ...streams,
      message: "Target URL of your service (local)",
      initialValue: defaults.targetUrl,
      validate: (v) => {
        try {
          new URL(v ?? "");
          return undefined;
        } catch {
          return "Enter a full URL, e.g. http://127.0.0.1:3000";
        }
      },
    });
    // Ctrl+C / Esc at any prompt → exit 130, nothing written; answering "No" to the last one → exit 0.
    if (p.isCancel(url)) {
      p.cancel("cancelled", streams);
      process.exitCode = 130;
      return;
    }
    const health = await p.text({
      ...streams,
      message: "Health check path",
      initialValue: defaults.healthPath,
    });
    if (p.isCancel(health)) {
      p.cancel("cancelled", streams);
      process.exitCode = 130;
      return;
    }
    answers = { targetUrl: String(url), healthPath: String(health) };
    const ok = await p.confirm({
      ...streams,
      message: "Write sw.config.ts and update .gitignore?",
      initialValue: true,
    });
    if (p.isCancel(ok)) {
      p.cancel("cancelled, nothing written", streams);
      process.exitCode = 130;
      return;
    }
    if (ok !== true) {
      p.cancel("nothing written", streams);
      process.exitCode = 0;
      return;
    }
  }
  const file = join(root, "sw.config.ts");
  writeFileSync(file, renderConfig(d, answers, hints), "utf8");
  const gi = ensureGitignore(root);
  if (o.json) {
    out(
      JSON.stringify({ written: file, gitignoreUpdated: gi, detection: d, contract: hints ?? null }, null, 2),
    );
  } else {
    out(`${s.ok} wrote ${file}`);
    if (gi) out(`${s.ok} added .second-world/ to .gitignore`);
    for (const line of initSummary(d, answers, { interactive, targetFlag: o.target !== undefined }, hints)) {
      out(`${s.info} ${line}`);
    }
    err(s.dim("SECOND WORLD is for testing systems you own or are explicitly authorised to test."));
  }
  process.exitCode = 0;
}
