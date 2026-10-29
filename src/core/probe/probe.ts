/**
 * Environment & capability probe. See docs/06-environments-and-portability.md §3–4.
 * Non-invasive: reads files and env vars, runs `<tool> --version` with a 2 s timeout (full mode only).
 * MUST never throw: every section is guarded and falls back to conservative defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { createRedactor } from "../log/redact.js";
import type { CapabilityId, CapabilityStatus, EnvironmentReport } from "../types.js";

export interface ProbeOptions {
  /** Run external tool version checks (git, docker, toxiproxy, k6). Default false. */
  full?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  stdout?: { isTTY?: boolean; columns?: number };
  /** Injected tool runner for tests: returns stdout or null. */
  runTool?: (cmd: string) => Promise<string | null>;
}

type ToolName = "git" | "docker" | "toxiproxy" | "k6";
const TOOLS: ToolName[] = ["git", "docker", "toxiproxy", "k6"];

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** cgroup v2 `cpu.max` ("max 100000" | "200000 100000") or v1 cfs quota/period → cores. */
export function parseCpuQuota(v2: string | null, v1Quota: string | null, v1Period: string | null): number | undefined {
  if (v2) {
    const [q, p] = v2.trim().split(/\s+/);
    if (q && q !== "max" && p) {
      const n = Number(q) / Number(p);
      if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
    }
    return undefined;
  }
  if (v1Quota && v1Period) {
    const q = Number(v1Quota.trim());
    const p = Number(v1Period.trim());
    if (q > 0 && p > 0) return Math.round((q / p) * 100) / 100;
  }
  return undefined;
}

/** cgroup memory limit; "max" or absurd values (> 2^60) mean unlimited. */
export function parseMemLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (t === "max") return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n >= 2 ** 60) return undefined;
  return n;
}

/** Parses "Max open files" soft limit from /proc/self/limits. */
export function parseFdLimit(limits: string | null): number | undefined {
  if (!limits) return undefined;
  const m = /^Max open files\s+(\S+)/m.exec(limits);
  if (!m || m[1] === "unlimited") return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function probeOs(env: NodeJS.ProcessEnv): EnvironmentReport["os"] {
  const platform = process.platform;
  const out: EnvironmentReport["os"] = {
    platform,
    release: safe(() => os.release(), ""),
    arch: safe(() => os.arch(), process.arch),
  };
  if (platform === "linux") {
    const header = safe(
      () => (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header,
      undefined,
    );
    out.libc = header?.glibcVersionRuntime ? "glibc" : "musl";
    out.wsl = /microsoft/i.test(out.release) || Boolean(env.WSL_DISTRO_NAME);
  }
  return out;
}

async function probeRuntime(): Promise<EnvironmentReport["runtime"]> {
  const g = globalThis as { Bun?: unknown; Deno?: { version?: { deno?: string } } };
  const name: "node" | "bun" | "deno" = process.versions.bun ? "bun" : g.Deno ? "deno" : "node";
  const version = name === "bun" ? String(process.versions.bun) : name === "deno" ? String(g.Deno?.version?.deno ?? "") : process.versions.node;
  let workerThreads = false;
  try {
    const wt = await import("node:worker_threads");
    workerThreads = typeof wt.Worker === "function";
  } catch {
    workerThreads = false;
  }
  // node:sqlite is detected without loading it (loading prints an ExperimentalWarning on Node 22/24).
  let sqlite = false;
  let compileCache = false;
  try {
    const m = (await import("node:module")) as { enableCompileCache?: unknown; isBuiltin?: (s: string) => boolean };
    compileCache = typeof m.enableCompileCache === "function";
    sqlite = typeof m.isBuiltin === "function" && m.isBuiltin("node:sqlite");
  } catch {
    sqlite = false;
  }
  return { name, version, features: { workerThreads, sqlite, compileCache } };
}

function probeResources(): EnvironmentReport["resources"] {
  const cpus = safe(() => os.availableParallelism(), safe(() => os.cpus().length, 1)) || 1;
  const out: EnvironmentReport["resources"] = { cpus, memTotal: safe(() => os.totalmem(), 0) };
  if (process.platform === "linux") {
    const quota = parseCpuQuota(
      readText("/sys/fs/cgroup/cpu.max"),
      readText("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
      readText("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    );
    if (quota !== undefined) out.cpuQuota = quota;
    const mem =
      parseMemLimit(readText("/sys/fs/cgroup/memory.max")) ??
      parseMemLimit(readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    if (mem !== undefined && mem < out.memTotal * 2) out.memLimit = mem;
    const fd = parseFdLimit(readText("/proc/self/limits"));
    if (fd !== undefined) out.fdLimit = fd;
  }
  return out;
}

function probeContainer(env: NodeJS.ProcessEnv): EnvironmentReport["container"] {
  if (process.platform !== "linux") return { inside: false };
  if (env.KUBERNETES_SERVICE_HOST) return { inside: true, runtime: "kubernetes" };
  if (existsSync("/run/.containerenv")) return { inside: true, runtime: "podman" };
  if (existsSync("/.dockerenv")) return { inside: true, runtime: "docker" };
  const cg = readText("/proc/1/cgroup") ?? "";
  if (/kubepods/.test(cg)) return { inside: true, runtime: "kubernetes" };
  if (/docker|containerd/.test(cg)) return { inside: true, runtime: "docker" };
  if (/lxc/.test(cg)) return { inside: true, runtime: "lxc" };
  return { inside: false };
}

async function probeCi(env: NodeJS.ProcessEnv): Promise<EnvironmentReport["ci"]> {
  try {
    if (env === process.env) {
      const ci = (await import("ci-info")) as unknown as { isCI: boolean; name: string | null; default?: { isCI: boolean; name: string | null } };
      const c = ci.default ?? ci;
      return c.isCI ? { inside: true, ...(c.name ? { provider: c.name } : {}) } : { inside: false };
    }
  } catch {
    // fall through to env heuristic
  }
  if (env.GITHUB_ACTIONS) return { inside: true, provider: "GitHub Actions" };
  if (env.GITLAB_CI) return { inside: true, provider: "GitLab CI" };
  if (env.TF_BUILD) return { inside: true, provider: "Azure Pipelines" };
  if (env.CI && env.CI !== "false" && env.CI !== "0") return { inside: true };
  return { inside: false };
}

export function detectTerminal(
  env: NodeJS.ProcessEnv,
  stdout: { isTTY?: boolean; columns?: number } = process.stdout,
): EnvironmentReport["terminal"] {
  const tty = stdout.isTTY === true;
  let color: boolean;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") color = false;
  else if (env.FORCE_COLOR !== undefined) color = env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  else if (env.TERM === "dumb") color = false;
  else color = tty;
  let unicode: boolean;
  if (process.platform === "win32") {
    unicode =
      Boolean(env.WT_SESSION) ||
      Boolean(env.TERMINUS_SUBLIME) ||
      env.ConEmuTask === "{cmd::Cmder}" ||
      env.TERM_PROGRAM === "vscode" ||
      env.TERM === "xterm-256color" ||
      env.TERM === "alacritty" ||
      Boolean(env.CI);
  } else {
    unicode = env.TERM !== "linux" && env.TERM !== "dumb";
  }
  return { tty, color, unicode, width: stdout.columns && stdout.columns > 0 ? stdout.columns : 80 };
}

function probeNetwork(env: NodeJS.ProcessEnv): EnvironmentReport["network"] {
  const pick = (k: string): string | undefined => env[k] ?? env[k.toLowerCase()];
  const proxyRaw = pick("HTTPS_PROXY") ?? pick("HTTP_PROXY") ?? pick("ALL_PROXY");
  const noProxyRaw = pick("NO_PROXY");
  const out: EnvironmentReport["network"] = { extraCA: Boolean(env.NODE_EXTRA_CA_CERTS) };
  if (proxyRaw) out.proxy = createRedactor().redactString(proxyRaw);
  if (noProxyRaw) {
    out.noProxy = noProxyRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return out;
}

async function defaultRunTool(cmd: string): Promise<string | null> {
  try {
    const { execa } = await import("execa");
    const r = await execa(cmd, ["--version"], { timeout: 2000, reject: false, stdin: "ignore" });
    if (r.exitCode !== 0 || r.failed) return null;
    return String(r.stdout || r.stderr || "").trim() || null;
  } catch {
    return null;
  }
}

function extractVersion(s: string): string {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(s);
  return m ? (m[1] as string) : s.split(/\r?\n/)[0]?.slice(0, 60) ?? s;
}

async function probeTools(full: boolean, run: (cmd: string) => Promise<string | null>): Promise<EnvironmentReport["tools"]> {
  if (!full) return {};
  const results = await Promise.all(TOOLS.map(async (t) => [t, await run(t).catch(() => null)] as const));
  const out: EnvironmentReport["tools"] = {};
  for (const [t, v] of results) if (v) out[t] = extractVersion(v);
  return out;
}

function capabilities(r: Omit<EnvironmentReport, "capabilities">, full: boolean, env: NodeJS.ProcessEnv) {
  const caps: Partial<Record<CapabilityId, CapabilityStatus>> = {};
  caps["network.target"] = { available: true };
  caps["fs.read"] = { available: true };
  caps.worker_threads = r.runtime.features.workerThreads
    ? { available: true }
    : { available: false, reason: "worker_threads unavailable in this runtime", fix: "Use Node.js >= 22.19; generator runs single-threaded" };
  caps.sqlite = r.runtime.features.sqlite
    ? { available: true }
    : { available: false, reason: "node:sqlite not available", fix: "History uses JSONL (no action needed); Node 24+ ships node:sqlite" };
  const toolCap = (t: ToolName, fix: string): CapabilityStatus =>
    r.tools[t] ? { available: true } : full ? { available: false, reason: `${t} not found on PATH`, fix } : { available: false, reason: "not probed (run `sw doctor`)" };
  caps.git = toolCap("git", "Install git (https://git-scm.com); Evolution and commit metadata are disabled without it");
  caps.docker = toolCap("docker", "Install/start Docker; Reliability Lab falls back to the built-in proxy, Evolution sandbox disabled");
  caps["telemetry.otlp"] = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { available: true }
    : { available: false, reason: "no OTLP endpoint configured", fix: "Set OTEL_EXPORTER_OTLP_ENDPOINT to read server-side metrics" };
  caps.tty = r.terminal.tty
    ? { available: true }
    : { available: false, reason: "stdout is not a TTY", fix: "Live dashboard disabled; line-based progress is used" };
  return caps;
}

/** Minimal report used when the probe itself fails unexpectedly. */
function fallbackReport(): EnvironmentReport {
  return {
    os: { platform: process.platform, release: "", arch: process.arch },
    runtime: { name: "node", version: process.versions.node ?? "", features: { workerThreads: false, sqlite: false, compileCache: false } },
    resources: { cpus: 1, memTotal: 0 },
    container: { inside: false },
    ci: { inside: false },
    terminal: { tty: false, color: false, unicode: false, width: 80 },
    network: { extraCA: false },
    tools: {},
    capabilities: {},
  };
}

export async function probeEnvironment(opts: ProbeOptions = {}): Promise<EnvironmentReport> {
  try {
    const env = opts.env ?? process.env;
    const full = opts.full === true;
    const [runtime, ci, tools] = await Promise.all([
      probeRuntime().catch(() => fallbackReport().runtime),
      probeCi(env).catch(() => ({ inside: false })),
      probeTools(full, opts.runTool ?? defaultRunTool).catch(() => ({})),
    ]);
    const base: Omit<EnvironmentReport, "capabilities"> = {
      os: safe(() => probeOs(env), fallbackReport().os),
      runtime,
      resources: safe(() => probeResources(), fallbackReport().resources),
      container: safe(() => probeContainer(env), { inside: false }),
      ci,
      terminal: safe(() => detectTerminal(env, opts.stdout ?? process.stdout), fallbackReport().terminal),
      network: safe(() => probeNetwork(env), { extraCA: false }),
      tools,
    };
    return { ...base, capabilities: safe(() => capabilities(base, full, env), {}) };
  } catch {
    return fallbackReport();
  }
}

// ---------------------------------------------------------------- doctor checklist

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  label: string;
  fix?: string;
}

const GiB = 1024 ** 3;

/** Turns a report into the `sw doctor` checklist (docs/06 §3). Pure function. */
export function doctorChecks(r: EnvironmentReport): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const major = Number(r.runtime.version.split(".")[0]);
  const minor = Number(r.runtime.version.split(".")[1]);
  const nodeOk = r.runtime.name !== "node" || major > 22 || (major === 22 && minor >= 19);
  out.push({
    id: "runtime",
    status: nodeOk ? "ok" : "fail",
    label: `${r.runtime.name === "node" ? "Node" : r.runtime.name} ${r.runtime.version}`,
    ...(nodeOk ? {} : { fix: "Upgrade to Node.js >= 22.19 (24 LTS recommended)" }),
  });
  out.push({ id: "os", status: "info", label: `${r.os.platform} ${r.os.arch} ${r.os.release}${r.os.libc ? ` (${r.os.libc})` : ""}${r.os.wsl ? " WSL" : ""}` });
  out.push({
    id: "worker_threads",
    status: r.runtime.features.workerThreads ? "ok" : "warn",
    label: "worker_threads",
    ...(r.capabilities.worker_threads?.fix && !r.runtime.features.workerThreads ? { fix: r.capabilities.worker_threads.fix } : {}),
  });
  out.push({
    id: "sqlite",
    status: r.runtime.features.sqlite ? "ok" : "info",
    label: r.runtime.features.sqlite ? "node:sqlite" : "node:sqlite unavailable (JSONL history)",
  });
  const quota = r.resources.cpuQuota !== undefined ? ` (cgroup quota: ${r.resources.cpuQuota.toFixed(1)})` : "";
  out.push({ id: "cpus", status: r.resources.cpus >= 2 ? "ok" : "warn", label: `${r.resources.cpus} CPUs${quota}`, ...(r.resources.cpus < 2 ? { fix: "Load generation shares 1 CPU with the target; results may be generator-bound" } : {}) });
  const mem = r.resources.memLimit ?? r.resources.memTotal;
  out.push({ id: "memory", status: mem >= GiB ? "ok" : "warn", label: `${(mem / GiB).toFixed(1)} GiB memory${r.resources.memLimit ? " (cgroup limit)" : ""}` });
  if (r.resources.fdLimit !== undefined) {
    const low = r.resources.fdLimit < 4096;
    out.push({
      id: "fd",
      status: low ? "warn" : "ok",
      label: `fd limit ${r.resources.fdLimit}${low ? " — high-concurrency tests may fail" : ""}`,
      ...(low ? { fix: "ulimit -n 65535" } : {}),
    });
  }
  if (r.container.inside) out.push({ id: "container", status: "info", label: `inside container (${r.container.runtime ?? "unknown"})` });
  if (r.ci.inside) out.push({ id: "ci", status: "info", label: `CI: ${r.ci.provider ?? "detected"}` });
  // Quick mode skips `<tool> --version`: a missing version then means "not probed", not "not found".
  const probed = !(r.capabilities.git?.reason ?? "").startsWith("not probed");
  for (const t of ["git", "docker", "toxiproxy", "k6"] as const) {
    const v = r.tools[t];
    if (v) out.push({ id: `tool.${t}`, status: "ok", label: `${t} ${v}` });
    else if (!probed) out.push({ id: `tool.${t}`, status: "info", label: `${t} not probed (run \`sw doctor\`)` });
    else {
      const cap = t === "git" || t === "docker" ? r.capabilities[t] : undefined;
      out.push({
        id: `tool.${t}`,
        status: t === "git" || t === "docker" ? "warn" : "info",
        label: `${t} not found`,
        ...(cap?.fix ? { fix: cap.fix } : {}),
      });
    }
  }
  if (r.network.proxy) {
    out.push({
      id: "proxy",
      status: "warn",
      label: `proxy set (${r.network.proxy}) — load targets bypass it`,
      fix: "Set http.proxy in config to route load traffic through the proxy",
    });
  }
  if (r.network.extraCA) out.push({ id: "ca", status: "info", label: "NODE_EXTRA_CA_CERTS set" });
  out.push({
    id: "tty",
    status: "info",
    label: r.terminal.tty ? `TTY ${r.terminal.width} cols${r.terminal.color ? ", color" : ""}${r.terminal.unicode ? ", unicode" : ""}` : "non-TTY output (line-based progress)",
  });
  return out;
}
