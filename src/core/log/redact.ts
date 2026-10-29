/**
 * Secret redaction pipeline. See docs/11-safety-security-privacy.md §4 and
 * docs/04-data-structures-and-algorithms.md §9.4.
 *
 * Stages: known header names / key names → exact config secrets → patterns
 * (Bearer, JWT, AWS/GCP/provider keys, PEM, basic-auth URLs, connection-string passwords)
 * → Shannon entropy ≥ 4.0 for ≥ 20-char values next to key-like names.
 * Replacement: «redacted:<8-hex sha256>» so equal values stay correlatable.
 * Objects are walked iteratively (no recursion on user-sized input).
 */
import { createHash } from "node:crypto";

export const DEFAULT_REDACT_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-amz-security-token",
];

/** Object keys whose (string) values are always redacted. */
const SENSITIVE_KEY = /^(?:.*[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth|credentials?|cookie|session[_-]?id)$/i;
/** Key-like names used for the entropy rule in free text. */
const KEYLIKE_ASSIGN =
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|auth|credential|signature|sig)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&]{20,})/gi;

export interface RedactPattern {
  name: string;
  re: RegExp;
  /** Capture group to redact; 0 (default) = whole match. */
  group?: number;
}

export const BUILTIN_PATTERNS: RedactPattern[] = [
  {
    name: "pem-private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g },
  { name: "bearer", re: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9\-._~+/]{8,}=*)/gi, group: 1 },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  {
    name: "aws-secret-key",
    re: /\baws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
    group: 1,
  },
  { name: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "azure-conn-key", re: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{20,})/g, group: 1 },
  { name: "url-basic-auth", re: /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):([^@/\s]+)@/gi, group: 2 },
  { name: "conn-string-password", re: /\b(?:password|pwd)\s*=\s*([^;'"\s]+)/gi, group: 1 },
];

export interface RedactorOptions {
  /** Header names (case-insensitive) whose values are always redacted. Defaults to DEFAULT_REDACT_HEADERS. */
  headers?: string[];
  /** Exact secret values (e.g. resolved config secrets) to redact anywhere. */
  secrets?: Iterable<string>;
  /** Extra patterns appended to the built-ins. */
  patterns?: Array<RedactPattern | RegExp>;
  /** Disable the entropy rule (default enabled). */
  entropy?: boolean;
}

export interface Redactor {
  redactString(s: string): string;
  redactHeaders<H extends Record<string, unknown>>(h: H): H;
  /** Deep copy with secrets replaced. Handles cycles, Maps→plain objects are not converted. */
  redactObject<T>(o: T): T;
  /** Adds an exact secret value to the deny-set (values < 4 chars are ignored). */
  addSecret(value: string): void;
}

export function redactionMarker(value: string): string {
  return `«redacted:${createHash("sha256").update(value).digest("hex").slice(0, 8)}»`;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const headerSet = new Set((opts.headers ?? DEFAULT_REDACT_HEADERS).map((h) => h.toLowerCase()));
  const secrets = new Set<string>();
  let secretRe: RegExp | null = null;
  const patterns: RedactPattern[] = [
    ...BUILTIN_PATTERNS,
    ...(opts.patterns ?? []).map((p, i) =>
      p instanceof RegExp
        ? { name: `custom-${i}`, re: p.global ? p : new RegExp(p.source, `${p.flags}g`) }
        : { ...p, re: p.re.global ? p.re : new RegExp(p.re.source, `${p.re.flags}g`) },
    ),
  ];
  const entropy = opts.entropy !== false;

  function rebuildSecretRe(): void {
    if (secrets.size === 0) {
      secretRe = null;
      return;
    }
    const sorted = [...secrets].sort((a, b) => b.length - a.length).map(escapeRe);
    secretRe = new RegExp(sorted.join("|"), "g");
  }

  function addSecret(v: string): void {
    if (typeof v !== "string" || v.length < 4) return;
    if (!secrets.has(v)) {
      secrets.add(v);
      rebuildSecretRe();
    }
  }
  for (const s of opts.secrets ?? []) addSecret(s);

  function redactString(input: string): string {
    if (typeof input !== "string" || input.length === 0) return input;
    let s = input;
    if (secretRe) s = s.replace(secretRe, (m) => redactionMarker(m));
    for (const p of patterns) {
      p.re.lastIndex = 0;
      if (!p.re.test(s)) continue;
      p.re.lastIndex = 0;
      const g = p.group ?? 0;
      s = s.replace(p.re, (...args: unknown[]) => {
        const match = args[0] as string;
        if (match.includes("«redacted:") && g === 0) return match;
        if (g === 0) return redactionMarker(match);
        const part = args[g] as string | undefined;
        if (part === undefined || part.startsWith("«redacted:")) return match;
        // replace the last occurrence of the group text inside the match (groups are suffix-ish)
        const idx = match.lastIndexOf(part);
        return match.slice(0, idx) + redactionMarker(part) + match.slice(idx + part.length);
      });
    }
    if (entropy) {
      KEYLIKE_ASSIGN.lastIndex = 0;
      s = s.replace(KEYLIKE_ASSIGN, (m, name: string, sep: string, value: string) => {
        if (value.startsWith("«")) return m;
        if (shannonEntropy(value) >= 4.0) return `${name}${sep}${redactionMarker(value)}`;
        return m;
      });
    }
    return s;
  }

  function redactValueForKey(key: string, v: unknown): unknown {
    if (typeof v === "string" && (SENSITIVE_KEY.test(key) || headerSet.has(key.toLowerCase()))) {
      return v.startsWith("«redacted:") ? v : redactionMarker(v);
    }
    return undefined;
  }

  function redactHeaders<H extends Record<string, unknown>>(h: H): H {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(h ?? {})) {
      if (headerSet.has(k.toLowerCase())) {
        out[k] = Array.isArray(v) ? v.map((x) => redactionMarker(String(x))) : v == null ? v : redactionMarker(String(v));
      } else if (typeof v === "string") out[k] = redactString(v);
      else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? redactString(x) : x));
      else out[k] = v;
    }
    return out as H;
  }

  function redactObject<T>(root: T): T {
    if (typeof root === "string") return redactString(root) as T;
    if (root === null || typeof root !== "object") return root;
    const seen = new WeakMap<object, unknown>();
    const mkContainer = (src: object): Record<string, unknown> | unknown[] => (Array.isArray(src) ? [] : {});
    const out = mkContainer(root as object);
    seen.set(root as object, out);
    const stack: Array<{ src: object; dst: Record<string, unknown> | unknown[] }> = [{ src: root as object, dst: out }];
    while (stack.length > 0) {
      const { src, dst } = stack.pop() as { src: object; dst: Record<string, unknown> | unknown[] };
      const entries: Array<[string, unknown]> =
        src instanceof Error
          ? [
              ["name", src.name],
              ["message", src.message],
              ["stack", src.stack],
              ...Object.entries(src),
            ]
          : Object.entries(src);
      for (const [k, v] of entries) {
        let nv: unknown;
        const forced = Array.isArray(src) ? undefined : redactValueForKey(k, v);
        if (forced !== undefined) nv = forced;
        else if (typeof v === "string") nv = redactString(v);
        else if (v !== null && typeof v === "object") {
          if (seen.has(v)) nv = "[Circular]";
          else if (v instanceof Date) nv = v.toISOString();
          else if (v instanceof URL) nv = redactString(v.href);
          else if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) nv = `[binary ${(v as Uint8Array).byteLength} bytes]`;
          else {
            const c = mkContainer(v);
            seen.set(v, c);
            stack.push({ src: v, dst: c });
            nv = c;
          }
        } else if (typeof v === "bigint") nv = v.toString();
        else nv = v;
        if (Array.isArray(dst)) dst[Number(k)] = nv;
        else dst[k] = nv;
      }
    }
    return out as T;
  }

  return { redactString, redactHeaders, redactObject, addSecret };
}
