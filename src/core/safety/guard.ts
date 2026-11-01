/**
 * Safety Guard: every outbound action passes through here.
 * See docs/11-safety-security-privacy.md §1–3 and docs/04 §3.4 (GCRA).
 *
 * - Target classification: loopback allowed; private needs allowHosts; public needs
 *   allowHosts + allowPublic + approval (interactive confirm or --yes).
 * - Budgets: ceilings (maxRps, maxConcurrency, maxRequests, maxDuration), a GCRA rate limiter
 *   and a request-count lease shared across all leases of the guard.
 * - Approvals for disruptive actions; non-interactive without `approve` → SafetyError.
 * - Append-only JSONL audit log with SHA-256 hash chaining.
 * - killSwitch: AbortSignal aborted by kill() or by the parent signal.
 */
import { createHash } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { isIP, type LookupFunction } from "node:net";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { systemClock } from "../clock.js";
import { SafetyError, TargetError } from "../errors.js";
import { createRedactor } from "../log/redact.js";
import type {
  BudgetLease,
  BudgetRequest,
  Clock,
  DisruptiveAction,
  SafetyDecision,
  SafetyGuard,
} from "../types.js";
import { Gcra } from "./gcra.js";

export type TargetClass = "loopback" | "private" | "public" | "invalid";

export interface SafetyConfig {
  allowHosts?: string[];
  allowPublic?: boolean;
  maxRps?: number;
  maxConcurrency?: number;
  maxRequests?: number;
  /** ms */
  maxDurationMs?: number;
  allowMutations?: boolean;
  approveDisruptive?: boolean;
  environment?: "local" | "isolated" | "staging" | "production";
}

export const DEFAULT_SAFETY: Required<Omit<SafetyConfig, "environment">> & {
  environment: SafetyConfig["environment"];
} = {
  allowHosts: ["127.0.0.1", "localhost", "::1"],
  allowPublic: false,
  maxRps: 2000,
  maxConcurrency: 500,
  maxRequests: 2_000_000,
  maxDurationMs: 30 * 60_000,
  allowMutations: false,
  approveDisruptive: false,
  environment: "local",
};

export interface SafetyGuardOptions {
  interactive: boolean;
  /** --yes / --approve-disruptive */
  approve?: boolean;
  signal?: AbortSignal;
  auditFile?: string;
  clock?: Clock;
  /** Injected confirm prompt (tests); default uses @clack/prompts when stdin+stdout are TTYs. */
  confirm?: (message: string) => Promise<boolean>;
  /** DNS resolver (tests); default `dns.promises.lookup(host, { all: true, verbatim: true })`. */
  resolver?: (host: string) => Promise<ResolvedAddress[]>;
  /** Upper bound for one DNS resolution (pre-flight pin and mid-run recheck). Default 10 s. */
  dnsTimeoutMs?: number;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface DnsPin {
  host: string;
  addresses: ResolvedAddress[];
  /** Strictest class among the hostname and every resolved address. */
  cls: TargetClass;
  pinnedAt: string;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  user: string;
  ci?: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface SafetyLease extends BudgetLease {
  /** Waits until the GCRA limiter admits one request (respects killSwitch + signal). */
  /** Waits for a rate-cap token. Resolves `true` only if the cap actually delayed this call. */
  throttle(signal?: AbortSignal): Promise<boolean>;
  /** Lease-scoped signal: aborted on killSwitch, release(), or when maxDuration elapses. */
  readonly signal: AbortSignal;
  readonly limits: Required<
    Pick<BudgetRequest, "maxRps" | "maxConcurrency" | "maxRequests" | "maxDurationMs">
  >;
}

export interface SafetyGuardEx extends SafetyGuard {
  reserve(req: BudgetRequest): SafetyLease;
  classify(host: string): TargetClass;
  /** Throws SafetyError if the target is not allowed. */
  assertTarget(url: URL | string): void;
  /** Like checkTarget but may prompt for approval (public targets / production). */
  preflight(url: URL | string): Promise<void>;
  kill(reason?: unknown): void;
  auditEntries(): readonly AuditEntry[];
  readonly config: Readonly<SafetyConfig>;
  /**
   * DNS pinning (docs/11 §2). Resolves the host once, classifies EVERY address and pins them.
   * Throws SafetyError when an address falls in a class the config does not allow
   * (e.g. an allowed public name resolving to a private IP).
   */
  pinHost(url: URL | string): Promise<DnsPin | null>;
  /** `net.LookupFunction` for undici `connect: { lookup }`: pinned addresses only; unpinned hosts are checked, resolved and pinned once. */
  readonly lookup: LookupFunction;
  /** Alias of `lookup`. */
  readonly pinnedLookup: LookupFunction;
  /** Re-resolves a pinned host; a different address class → kill switch + SafetyError SW_SAFETY_DNS_REBIND. */
  recheckDns(host: string): Promise<void>;
  pins(): readonly DnsPin[];
  /** Checks a redirect `Location` (relative or absolute) against the same rules as the original target. */
  checkRedirect(from: URL | string, location: string): SafetyDecision;
}

// ---------------------------------------------------------------- classification

function stripBrackets(h: string): string {
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

function classifyV4(n: number): TargetClass {
  if (inCidr4(n, "127.0.0.0", 8) || n === 0) return "loopback";
  if (
    inCidr4(n, "10.0.0.0", 8) ||
    inCidr4(n, "172.16.0.0", 12) ||
    inCidr4(n, "192.168.0.0", 16) ||
    inCidr4(n, "169.254.0.0", 16) ||
    inCidr4(n, "100.64.0.0", 10)
  ) {
    return "private";
  }
  return "public";
}

/** Classify a hostname or IP literal (no DNS). */
export function classifyHost(hostRaw: string): TargetClass {
  if (!hostRaw) return "invalid";
  const host = stripBrackets(hostRaw.toLowerCase()).replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const kind = isIP(host);
  if (kind === 4) return classifyV4(ipv4ToInt(host) as number);
  if (kind === 6) {
    const h = host.split("%")[0] as string;
    if (h === "::1" || h === "::") return "loopback";
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return classifyV4(ipv4ToInt(mapped[1] as string) as number);
    // Hex form of an IPv4-mapped address: WHATWG URL serialises [::ffff:127.0.0.1] as [::ffff:7f00:1].
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mappedHex) {
      const n =
        Number.parseInt(mappedHex[1] as string, 16) * 0x10000 + Number.parseInt(mappedHex[2] as string, 16);
      return classifyV4(n >>> 0);
    }
    const first = Number.parseInt(h.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return "private"; // fe80::/10
    return "public";
  }
  if (!/^[a-z0-9_.-]+$/.test(host)) return "invalid";
  if (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    host === "host.docker.internal" ||
    !host.includes(".")
  ) {
    return "private";
  }
  return "public";
}

/**
 * Host allow-list matching: exact (case-insensitive), `*.suffix` (one or more labels, not the apex),
 * `host:port`, and IPv4 CIDR (`10.0.0.0/8`).
 */
export function hostMatches(pattern: string, hostRaw: string, port?: string): boolean {
  const host = stripBrackets(hostRaw.toLowerCase()).replace(/\.$/, "");
  let p = pattern.trim().toLowerCase();
  if (p === "*") return true;
  // host:port (not IPv6)
  const portMatch = /^(.*[^:]):(\d+)$/.exec(p);
  if (portMatch && !p.startsWith("[") && (portMatch[1] as string).split(":").length === 1) {
    if (port !== undefined && port !== portMatch[2]) return false;
    if (port === undefined) return false;
    p = portMatch[1] as string;
  }
  p = stripBrackets(p);
  const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(p);
  if (cidr) {
    const ip = ipv4ToInt(host);
    const bits = Number(cidr[2]);
    return ip !== null && bits <= 32 && inCidr4(ip, cidr[1] as string, bits);
  }
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".staging.x"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return p === host;
}

function defaultPort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80";
}

// ---------------------------------------------------------------- audit

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const GENESIS = "0".repeat(64);

interface ChainHead {
  hash: string;
  seq: number;
  /** The file does not end with "\n" (a torn write): the next append starts a fresh line. */
  needsNewline: boolean;
}

function parseEntry(line: string): AuditEntry | undefined {
  try {
    const e = JSON.parse(line) as AuditEntry;
    return e && typeof e.hash === "string" && typeof e.prevHash === "string" && typeof e.seq === "number"
      ? e
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Head of the chain in `file`: the last parseable entry, read from the end in growing windows (bounded
 * memory for large logs). Unparseable trailing bytes (a torn write) are skipped.
 */
function chainHeadOf(file: string): ChainHead {
  let fd: number | undefined;
  try {
    if (!existsSync(file)) return { hash: GENESIS, seq: 0, needsNewline: false };
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return { hash: GENESIS, seq: 0, needsNewline: false };
    const lastByte = Buffer.alloc(1);
    readSync(fd, lastByte, 0, 1, size - 1);
    const needsNewline = lastByte[0] !== 0x0a;
    for (let win = 64 * 1024; ; win *= 4) {
      const len = Math.min(size, win);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split(/\r?\n/);
      // The first line of a partial window may be cut: only trust it when the window is the whole file.
      const from = len === size ? 0 : 1;
      for (let i = lines.length - 1; i >= from; i--) {
        const e = parseEntry(lines[i] as string);
        if (e) return { hash: e.hash, seq: e.seq, needsNewline };
      }
      if (len === size) return { hash: GENESIS, seq: 0, needsNewline };
    }
  } catch {
    return { hash: GENESIS, seq: 0, needsNewline: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const lockSleep = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cross-process exclusive section on `<file>.lock` (O_EXCL create). Several `sw` processes in one
 * project append to the same audit log; reading the chain head and appending must not interleave.
 * Held for one small append; a lock older than 10 s is stale (crashed holder) and removed.
 * Returns false (fn not run) when the lock could not be taken within ~2 s.
 */
function withAuditLock(file: string, fn: () => void): boolean {
  const lock = `${file}.lock`;
  const t0 = performance.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {
        // vanished meanwhile: retry
      }
      if (performance.now() - t0 > 2000) return false;
      Atomics.wait(lockSleep, 0, 0, 2);
    }
  }
  try {
    fn();
    return true;
  } finally {
    rmSync(lock, { force: true });
  }
}

function entryHash(e: Omit<AuditEntry, "hash">): string {
  const { prevHash, ...rest } = e;
  return sha256(prevHash + JSON.stringify(rest));
}

export interface AuditVerifyResult {
  ok: boolean;
  /** Valid entries (ok) or non-blank lines (not ok). */
  entries: number;
  /** First line (1-based) where the chain breaks. */
  brokenAt?: number;
  /** hash-mismatch: the entry was edited; prev-hash-mismatch: a line before it was removed, reordered or replaced. */
  reason?: "hash-mismatch" | "prev-hash-mismatch";
  /** Unparseable lines the chain continues around (torn writes from a crash); not tampering. */
  torn?: number[];
}

/** Calls `onLine(line, lineNo)` for each line of `file`, reading 64 KiB at a time (bounded memory). */
function forEachLine(file: string, onLine: (line: string, no: number) => boolean): void {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const dec = new StringDecoder("utf8"); // multi-byte characters may straddle chunks
    let rest = "";
    let no = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const parts = (rest + dec.write(buf.subarray(0, n))).split("\n");
      rest = parts.pop() as string;
      for (const p of parts) if (!onLine(p.replace(/\r$/, ""), ++no)) return;
    }
    rest += dec.end();
    if (rest) onLine(rest.replace(/\r$/, ""), ++no);
  } finally {
    closeSync(fd);
  }
}

/**
 * Verifies the hash chain of an audit JSONL file (docs/11 §3). Each entry's hash covers its content and
 * the previous entry's hash, so an edited, deleted, reordered or replaced line breaks the chain at the
 * first affected line. Removing entries from the END is not detectable by a chain alone.
 * A missing file is an empty chain.
 */
export function verifyAuditLog(file: string): AuditVerifyResult {
  if (!existsSync(file)) return { ok: true, entries: 0 };
  let prev = GENESIS;
  let entries = 0;
  let lines = 0;
  const torn: number[] = [];
  let broken: { at: number; reason: NonNullable<AuditVerifyResult["reason"]> } | undefined;
  forEachLine(file, (line, no) => {
    if (!line.trim()) return true;
    lines++;
    if (broken) return true;
    const e = parseEntry(line);
    if (!e) {
      torn.push(no);
      return true;
    }
    const { hash, ...rest } = e;
    if (e.prevHash !== prev) broken = { at: no, reason: "prev-hash-mismatch" };
    else if (entryHash(rest) !== hash) broken = { at: no, reason: "hash-mismatch" };
    else {
      prev = hash;
      entries++;
    }
    return true;
  });
  if (broken) return { ok: false, entries: lines, brokenAt: broken.at, reason: broken.reason };
  return { ok: true, entries, ...(torn.length > 0 ? { torn } : {}) };
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

function ciJob(): string | undefined {
  const e = process.env;
  if (e.GITHUB_ACTIONS) return `github:${e.GITHUB_REPOSITORY ?? ""}#${e.GITHUB_RUN_ID ?? ""}`;
  if (e.GITLAB_CI) return `gitlab:${e.CI_PROJECT_PATH ?? ""}#${e.CI_JOB_ID ?? ""}`;
  if (e.CI) return "ci";
  return undefined;
}

// ---------------------------------------------------------------- guard

const MAX_AUDIT_IN_MEMORY = 1000;
/** Default bound for one DNS resolution (docs/11 §2). */
const DNS_TIMEOUT_MS = 10_000;

export function createSafetyGuard(
  cfgIn: SafetyConfig = {},
  opts: SafetyGuardOptions = { interactive: false },
): SafetyGuardEx {
  const cfg: SafetyConfig = { ...DEFAULT_SAFETY, ...stripUndefined(cfgIn) };
  const allowHosts = cfg.allowHosts ?? [];
  const clock = opts.clock;
  const now = (): number => (clock ? clock.now() : performance.now());
  const isoNow = (): string => (clock ? clock.isoNow() : new Date().toISOString());
  const redactor = createRedactor();

  const killCtl = new AbortController();
  const killSwitch = opts.signal ? AbortSignal.any([killCtl.signal, opts.signal]) : killCtl.signal;

  const approvedHosts = new Set<string>();
  const approvedActions = new Set<DisruptiveAction>();
  let totalTaken = 0;
  const globalMaxRequests = cfg.maxRequests ?? Number.POSITIVE_INFINITY;
  // safety.maxRps is a world-wide cap (docs/11 §2 hard budgets): every lease throttles through this
  // one GCRA, so N engines running concurrently in one world share the rate instead of getting N×.
  // A lease that asks for a lower rate gets its own extra per-lease GCRA on top (see reserve()).
  const globalGcra = rpsGcra(cfg.maxRps);

  // audit chain: with a file, the head is re-read from the file under a lock at every append, so
  // parallel `sw` processes sharing .second-world/audit.log extend ONE chain (docs/11 §3).
  const entries: AuditEntry[] = [];
  let chain = { hash: GENESIS, seq: 0 };
  let auditDirReady = false;
  const user = currentUser();
  const ci = ciJob();

  function audit(ev: { action: string; target?: string; detail?: Record<string, unknown> }): void {
    try {
      const body = {
        ts: isoNow(),
        user,
        ...(ci ? { ci } : {}),
        action: ev.action,
        ...(ev.target ? { target: redactor.redactString(ev.target) } : {}),
        ...(ev.detail ? { detail: redactor.redactObject(ev.detail) } : {}),
      };
      const make = (head: { hash: string; seq: number }): AuditEntry => {
        const base: Omit<AuditEntry, "hash"> = { seq: head.seq + 1, ...body, prevHash: head.hash };
        return { ...base, hash: entryHash(base) };
      };
      let entry: AuditEntry | undefined;
      const file = opts.auditFile;
      if (file) {
        try {
          if (!auditDirReady) {
            mkdirSync(dirname(file), { recursive: true });
            auditDirReady = true;
          }
          const append = (): void => {
            const head = chainHeadOf(file);
            const e = make(head);
            appendFileSync(file, `${head.needsNewline ? "\n" : ""}${JSON.stringify(e)}\n`, "utf8");
            entry = e;
          };
          // Lock not obtainable in time: append anyway (a possibly forked chain beats a lost record).
          if (!withAuditLock(file, append)) append();
        } catch {
          // file unwritable: keep the entry in memory only
        }
      }
      entry ??= make(chain);
      chain = { hash: entry.hash, seq: entry.seq };
      entries.push(entry);
      if (entries.length > MAX_AUDIT_IN_MEMORY) entries.shift();
    } catch {
      // audit must never crash the run
    }
  }

  function isAllowListed(u: URL): boolean {
    const port = defaultPort(u);
    return allowHosts.some((p) => hostMatches(p, u.hostname, port));
  }

  function checkTarget(urlIn: URL | string): SafetyDecision {
    let u: URL;
    try {
      u = typeof urlIn === "string" ? new URL(urlIn) : urlIn;
    } catch {
      return { allowed: false, code: "SW_SAFETY_INVALID_URL", reason: `Invalid URL: ${String(urlIn)}` };
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) {
      return {
        allowed: false,
        code: "SW_SAFETY_PROTOCOL",
        reason: `Protocol ${u.protocol} is not allowed`,
        hint: "Use an http(s):// or ws(s):// target",
      };
    }
    if (killSwitch.aborted)
      return { allowed: false, code: "SW_SAFETY_KILLED", reason: "Kill switch engaged" };
    const host = u.hostname;
    const cls = classifyHost(host);
    const listed = isAllowListed(u);
    if (cls === "invalid")
      return { allowed: false, code: "SW_SAFETY_INVALID_HOST", reason: `Invalid host "${host}"` };
    if (cfg.environment === "production" && !approvedActions.has("production-target") && !opts.approve) {
      return {
        allowed: false,
        code: "SW_SAFETY_PRODUCTION",
        reason: `environment is "production": targeting ${host} requires explicit approval`,
        hint: "Re-run with --yes (and review safety settings) or run interactively to confirm",
      };
    }
    return decide(host, cls, listed);
  }

  /** Class-based decision (shared by checkTarget and DNS pinning). */
  function decide(host: string, cls: TargetClass, listed: boolean): SafetyDecision {
    if (cls === "invalid")
      return { allowed: false, code: "SW_SAFETY_INVALID_HOST", reason: `Invalid host "${host}"` };
    if (cls === "loopback") return { allowed: true };
    if (cls === "private") {
      if (listed) return { allowed: true };
      return {
        allowed: false,
        code: "SW_SAFETY_HOST_NOT_ALLOWED",
        reason: `Private host "${host}" is not in safety.allowHosts`,
        hint: `Add "${host}" (or a wildcard like "*.${host.split(".").slice(1).join(".") || host}") to safety.allowHosts`,
      };
    }
    // public
    if (!listed) {
      return {
        allowed: false,
        code: "SW_SAFETY_PUBLIC_TARGET",
        reason: `Public host "${host}" is blocked: not in safety.allowHosts`,
        hint: `Only test systems you own. To proceed add "${host}" to safety.allowHosts, set safety.allowPublic: true and confirm (or pass --yes)`,
      };
    }
    if (!cfg.allowPublic) {
      return {
        allowed: false,
        code: "SW_SAFETY_PUBLIC_TARGET",
        reason: `Public host "${host}" requires safety.allowPublic: true`,
        hint: "Set safety.allowPublic: true in your config and confirm (or pass --yes)",
      };
    }
    if (opts.approve || approvedHosts.has(host.toLowerCase())) return { allowed: true };
    return {
      allowed: false,
      code: "SW_SAFETY_APPROVAL_REQUIRED",
      reason: `Public host "${host}" requires confirmation`,
      hint: "Run interactively to confirm, or pass --yes",
    };
  }

  // ------------------------------------------------------------ DNS pinning (docs/11 §2)
  const RANK: Record<TargetClass, number> = { loopback: 0, private: 1, public: 2, invalid: 3 };
  const pinsByHost = new Map<string, DnsPin>();
  const inflight = new Map<string, Promise<DnsPin>>();
  const resolver =
    opts.resolver ??
    (async (host: string): Promise<ResolvedAddress[]> =>
      (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((a) => ({
        address: a.address,
        family: a.family,
      })));

  const dnsTimeoutMs = opts.dnsTimeoutMs ?? DNS_TIMEOUT_MS;

  /** `resolver(host)` bounded by dnsTimeoutMs: getaddrinfo has no timeout of its own and can block. */
  function resolveBounded(host: string): Promise<ResolvedAddress[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_res, rej) => {
      timer = setTimeout(
        () =>
          rej(
            Object.assign(new Error(`DNS lookup timed out after ${dnsTimeoutMs} ms`), { code: "ETIMEOUT" }),
          ),
        dnsTimeoutMs,
      );
      timer.unref?.();
    });
    return Promise.race([resolver(host), timeout]).finally(() => clearTimeout(timer));
  }

  function strictest(a: TargetClass, b: TargetClass): TargetClass {
    return RANK[b] > RANK[a] ? b : a;
  }

  function classOf(host: string, addrs: ResolvedAddress[]): TargetClass {
    let cls = classifyHost(host);
    for (const a of addrs) cls = strictest(cls, classifyHost(a.address));
    return cls;
  }

  async function resolveAndCheck(host: string, listedName: boolean, port: string): Promise<DnsPin> {
    const key = host.toLowerCase();
    let addrs: ResolvedAddress[];
    try {
      addrs = await resolveBounded(key);
    } catch (e) {
      throw new TargetError("SW_TARGET_DNS", `Cannot resolve "${host}": ${(e as Error).message}`, {
        hint: "Check the host name, your DNS/VPN, or use an IP address",
        cause: e,
      });
    }
    if (addrs.length === 0) throw new TargetError("SW_TARGET_DNS", `"${host}" resolved to no addresses`);
    const cls = classOf(key, addrs);
    if (cls !== classifyHost(key)) {
      const allAddrsListed = addrs.every((a) => allowHosts.some((p) => hostMatches(p, a.address, port)));
      // A loopback NAME (localhost, *.localhost) must resolve to loopback (RFC 6761 §6.3): the name
      // being on the (default) allow-list says nothing about a LAN/public answer from a tampered
      // hosts file or resolver, so only the addresses themselves can authorise that.
      const nameVouches = listedName && classifyHost(key) !== "loopback";
      const d = decide(host, cls, nameVouches || allAddrsListed);
      if (!d.allowed) {
        const list = addrs.map((a) => a.address).join(", ");
        audit({
          action: "safety.blocked",
          target: host,
          detail: { code: "SW_SAFETY_DNS_CLASS", addresses: list, cls },
        });
        throw new SafetyError(
          "SW_SAFETY_DNS_CLASS",
          `"${host}" resolves to ${cls} address(es) ${list}: ${d.reason}`,
          {
            hint: d.hint ?? "Add the resolved addresses (or a CIDR) to safety.allowHosts if this is intended",
          },
        );
      }
    }
    const pin: DnsPin = { host: key, addresses: addrs, cls, pinnedAt: isoNow() };
    pinsByHost.set(key, pin);
    audit({ action: "dns.pinned", target: key, detail: { addresses: addrs.map((a) => a.address), cls } });
    return pin;
  }

  async function pinHost(urlIn: URL | string): Promise<DnsPin | null> {
    const u = typeof urlIn === "string" ? safeUrl(urlIn) : urlIn;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return null;
    const key = host.toLowerCase();
    const existing = pinsByHost.get(key);
    if (existing) return existing;
    let p = inflight.get(key);
    if (!p) {
      p = resolveAndCheck(host, isAllowListed(u), defaultPort(u));
      inflight.set(key, p);
      p.then(
        () => inflight.delete(key),
        () => inflight.delete(key),
      );
    }
    return p;
  }

  type Cb = (err: NodeJS.ErrnoException | null, address: string | ResolvedAddress[], family?: number) => void;

  function lookupErr(e: Error, code: string): NodeJS.ErrnoException {
    return Object.assign(e, { code }) as NodeJS.ErrnoException;
  }

  const lookup = ((hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as Cb;
    const o = (typeof options === "object" && options !== null ? options : {}) as {
      all?: boolean;
      family?: number | string;
    };
    const want =
      o.family === "IPv4" ? 4 : o.family === "IPv6" ? 6 : typeof o.family === "number" ? o.family : 0;
    const host = hostname.toLowerCase();
    const empty = o.all ? [] : "";
    const finish = (pin: DnsPin): void => {
      const list = want === 4 || want === 6 ? pin.addresses.filter((a) => a.family === want) : pin.addresses;
      const first = list[0];
      if (!first) {
        cb(lookupErr(new Error(`no IPv${want} address pinned for ${hostname}`), "ENOTFOUND"), empty);
        return;
      }
      if (o.all)
        cb(
          null,
          list.map((a) => ({ address: a.address, family: a.family })),
        );
      else cb(null, first.address, first.family);
    };
    const pinned = pinsByHost.get(host);
    if (pinned) {
      finish(pinned);
      return;
    }
    if (isIP(host)) {
      const fam = isIP(host);
      if (o.all) cb(null, [{ address: host, family: fam }]);
      else cb(null, host, fam);
      return;
    }
    // Unpinned host: must pass the normal target check, then is resolved, checked and pinned once.
    let u: URL;
    try {
      u = new URL(`http://${host}`);
    } catch {
      // Never throw synchronously out of a LookupFunction: net.connect expects the callback.
      cb(
        lookupErr(
          new SafetyError("SW_SAFETY_INVALID_HOST", `Invalid host "${hostname}"`),
          "SW_SAFETY_INVALID_HOST",
        ),
        empty,
      );
      return;
    }
    const d = checkTarget(u);
    if (!d.allowed) {
      const e = new SafetyError(d.code as `SW_SAFETY_${string}`, d.reason, d.hint ? { hint: d.hint } : {});
      cb(lookupErr(e, d.code), empty);
      return;
    }
    pinHost(u).then(
      (pin) => {
        if (pin) finish(pin);
        else cb(lookupErr(new Error(`cannot pin ${hostname}`), "ENOTFOUND"), empty);
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        cb(lookupErr(e, (err as { code?: string }).code ?? "ENOTFOUND"), empty);
      },
    );
  }) as unknown as LookupFunction;

  async function recheckDns(hostIn: string): Promise<void> {
    const host = hostIn.toLowerCase();
    const pin = pinsByHost.get(host);
    if (!pin) return;
    let addrs: ResolvedAddress[];
    try {
      addrs = await resolveBounded(host);
    } catch {
      return; // transient resolution failure: connections keep using the pinned addresses
    }
    const cls = classOf(host, addrs);
    // A rebind = the overall class changed, or any new address is in a class none of the pinned
    // addresses had (e.g. public → private, or a loopback address appearing). Same-class IP churn
    // (load balancers) is fine.
    const pinnedClasses = new Set(pin.addresses.map((a) => classifyHost(a.address)));
    const differs = cls !== pin.cls || addrs.some((a) => !pinnedClasses.has(classifyHost(a.address)));
    if (!differs) return;
    const err = new SafetyError(
      "SW_SAFETY_DNS_REBIND",
      `DNS for "${host}" changed address class mid-run (${pin.cls} → ${cls}: ${addrs.map((a) => a.address).join(", ")})`,
      {
        hint: "Possible DNS rebinding: the run was aborted. Connections only ever use the addresses pinned at pre-flight",
      },
    );
    audit({
      action: "safety.dns-rebind",
      target: host,
      detail: {
        pinned: pin.addresses.map((a) => a.address),
        now: addrs.map((a) => a.address),
        from: pin.cls,
        to: cls,
      },
    });
    if (!killCtl.signal.aborted) killCtl.abort(err);
    throw err;
  }

  function checkRedirect(from: URL | string, location: string): SafetyDecision {
    let next: URL;
    try {
      next = new URL(location, typeof from === "string" ? from : from.href);
    } catch {
      return {
        allowed: false,
        code: "SW_SAFETY_INVALID_URL",
        reason: `Invalid redirect location: ${location}`,
      };
    }
    const d = checkTarget(next);
    if (!d.allowed) {
      audit({
        action: "safety.redirect-blocked",
        target: next.origin,
        detail: { from: String(from), code: d.code },
      });
      return { ...d, reason: `Redirect to ${next.origin} blocked: ${d.reason}` };
    }
    return d;
  }

  function assertTarget(url: URL | string): void {
    const d = checkTarget(typeof url === "string" ? safeUrl(url) : url);
    if (!d.allowed) {
      audit({ action: "safety.blocked", target: String(url), detail: { code: d.code, reason: d.reason } });
      throw new SafetyError(d.code as `SW_SAFETY_${string}`, d.reason, {
        hint: d.hint,
        details: { target: String(url) },
      });
    }
  }

  async function confirmPrompt(message: string): Promise<boolean> {
    if (opts.confirm) return opts.confirm(message);
    const prompts = await import("@clack/prompts");
    const r = await prompts.confirm({ message, initialValue: false });
    return r === true;
  }

  function canPrompt(): boolean {
    return (
      opts.interactive &&
      (Boolean(opts.confirm) || (process.stdin.isTTY === true && process.stdout.isTTY === true))
    );
  }

  async function requireApproval(action: DisruptiveAction, detail = ""): Promise<void> {
    if (approvedActions.has(action)) return;
    if (opts.approve || (cfg.approveDisruptive && action !== "production-target")) {
      approvedActions.add(action);
      audit({
        action: "approval.granted",
        detail: { action, detail, source: opts.approve ? "flag" : "config" },
      });
      return;
    }
    if (!canPrompt()) {
      audit({ action: "approval.missing", detail: { action, detail } });
      throw new SafetyError(
        "SW_SAFETY_APPROVAL_REQUIRED",
        `Action "${action}" requires approval${detail ? `: ${detail}` : ""}`,
        {
          hint: "Re-run with --yes / --approve-disruptive (logged to the audit trail), or run in an interactive terminal",
        },
      );
    }
    const ok = await confirmPrompt(`Approve ${action}${detail ? ` (${detail})` : ""}?`);
    if (!ok) {
      audit({ action: "approval.declined", detail: { action, detail } });
      throw new SafetyError("SW_SAFETY_DECLINED", `Approval for "${action}" was declined`);
    }
    approvedActions.add(action);
    audit({ action: "approval.granted", detail: { action, detail, source: "interactive" } });
  }

  async function preflight(urlIn: URL | string): Promise<void> {
    const u = typeof urlIn === "string" ? safeUrl(urlIn) : urlIn;
    if (cfg.environment === "production") await requireApproval("production-target", u.host);
    const d = checkTarget(u);
    if (d.allowed) {
      await pinHost(u);
      audit({ action: "target.allowed", target: u.origin });
      return;
    }
    if (d.code === "SW_SAFETY_APPROVAL_REQUIRED" && canPrompt()) {
      const ok = await confirmPrompt(`Send traffic to PUBLIC host ${u.host}? Only test systems you own.`);
      if (ok) {
        approvedHosts.add(u.hostname.toLowerCase());
        audit({
          action: "approval.granted",
          target: u.origin,
          detail: { action: "public-target", source: "interactive" },
        });
        await pinHost(u);
        return;
      }
    }
    assertTarget(u);
  }

  function reserve(req: BudgetRequest): SafetyLease {
    const over: string[] = [];
    const lim = {
      maxRps: req.maxRps ?? cfg.maxRps ?? Number.POSITIVE_INFINITY,
      maxConcurrency: req.maxConcurrency ?? cfg.maxConcurrency ?? Number.POSITIVE_INFINITY,
      maxRequests: req.maxRequests ?? cfg.maxRequests ?? Number.POSITIVE_INFINITY,
      maxDurationMs: req.maxDurationMs ?? cfg.maxDurationMs ?? Number.POSITIVE_INFINITY,
    };
    if (cfg.maxRps !== undefined && lim.maxRps > cfg.maxRps)
      over.push(`rate ${lim.maxRps}/s > safety.maxRps ${cfg.maxRps}`);
    if (cfg.maxConcurrency !== undefined && lim.maxConcurrency > cfg.maxConcurrency)
      over.push(`concurrency ${lim.maxConcurrency} > safety.maxConcurrency ${cfg.maxConcurrency}`);
    if (cfg.maxRequests !== undefined && lim.maxRequests > cfg.maxRequests)
      over.push(`requests ${lim.maxRequests} > safety.maxRequests ${cfg.maxRequests}`);
    if (cfg.maxDurationMs !== undefined && lim.maxDurationMs > cfg.maxDurationMs)
      over.push(`duration ${lim.maxDurationMs}ms > safety.maxDuration ${cfg.maxDurationMs}ms`);
    if (over.length > 0) {
      audit({ action: "budget.rejected", detail: { request: { ...req }, over } });
      throw new SafetyError(
        "SW_SAFETY_BUDGET",
        `Requested budget exceeds safety limits: ${over.join("; ")}`,
        {
          hint: "Lower the requested load or raise the limits in the safety section of your config",
          details: { over },
        },
      );
    }
    if (killSwitch.aborted) throw new SafetyError("SW_SAFETY_KILLED", "Kill switch engaged");

    const leaseCtl = new AbortController();
    const leaseSignal = AbortSignal.any([leaseCtl.signal, killSwitch]);
    const startedAt = now();
    let taken = 0;
    let released = false;
    // Per-lease limiter only when the lease is stricter than the world-wide cap.
    const leaseGcra = globalGcra && lim.maxRps >= globalGcra.rate ? null : rpsGcra(lim.maxRps);
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    if (!clock && Number.isFinite(lim.maxDurationMs)) {
      durationTimer = setTimeout(
        () => leaseCtl.abort(new SafetyError("SW_SAFETY_BUDGET", "safety.maxDuration reached")),
        lim.maxDurationMs,
      );
      durationTimer.unref?.();
    }
    audit({ action: "budget.reserved", detail: { ...lim } });

    const lease: SafetyLease = {
      take(n = 1): boolean {
        if (released || leaseSignal.aborted) return false;
        if (now() - startedAt > lim.maxDurationMs) {
          leaseCtl.abort(new SafetyError("SW_SAFETY_BUDGET", "safety.maxDuration reached"));
          return false;
        }
        if (taken + n > lim.maxRequests || totalTaken + n > globalMaxRequests) return false;
        taken += n;
        totalTaken += n;
        return true;
      },
      get remaining() {
        return Math.max(0, Math.min(lim.maxRequests - taken, globalMaxRequests - totalTaken));
      },
      release(): void {
        if (released) return;
        released = true;
        if (durationTimer) clearTimeout(durationTimer);
        leaseCtl.abort(new Error("lease released"));
        audit({ action: "budget.released", detail: { taken } });
      },
      async throttle(signal?: AbortSignal): Promise<boolean> {
        if (!leaseGcra && !globalGcra) return false;
        const sig = signal ? AbortSignal.any([signal, leaseSignal]) : leaseSignal;
        const c = clock ?? systemClock;
        // Lease first (its own pace), then the shared world-wide cap; waited if either delayed us.
        const waitedLease = leaseGcra ? await leaseGcra.take(c, 1, sig) : false;
        const waitedGlobal = globalGcra ? await globalGcra.take(c, 1, sig) : false;
        return waitedLease || waitedGlobal;
      },
      signal: leaseSignal,
      limits: lim,
    };
    return lease;
  }

  return {
    checkTarget: (u: URL) => checkTarget(u),
    assertTarget,
    preflight,
    classify: classifyHost,
    reserve,
    requireApproval,
    audit,
    get killSwitch() {
      return killSwitch;
    },
    kill(reason?: unknown): void {
      if (killCtl.signal.aborted) return;
      audit({
        action: "kill-switch",
        detail: { reason: reason instanceof Error ? reason.message : String(reason ?? "") },
      });
      killCtl.abort(reason ?? new SafetyError("SW_SAFETY_KILLED", "Kill switch engaged"));
    },
    auditEntries: () => entries,
    config: cfg,
    pinHost,
    lookup,
    pinnedLookup: lookup,
    recheckDns,
    pins: () => [...pinsByHost.values()],
    checkRedirect,
  };
}

/** GCRA for a requests/second cap (burst = 10% of a second's worth), or null when uncapped. */
function rpsGcra(rps: number | undefined): Gcra | null {
  if (rps === undefined || !Number.isFinite(rps) || rps <= 0) return null;
  return new Gcra({ rate: rps, burst: Math.max(1, Math.ceil(rps / 10)) });
}

function safeUrl(s: string): URL {
  try {
    return new URL(s);
  } catch {
    throw new SafetyError("SW_SAFETY_INVALID_URL", `Invalid URL: ${s}`, {
      hint: "Use a full URL like http://127.0.0.1:3000",
    });
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
