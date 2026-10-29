/**
 * Human unit parsing. See docs/08-configuration.md §2.
 * Everything is normalised to ms, bytes, per-second and 0..1 fractions.
 * Hand-written scanners, no eval, strict errors via ConfigError.
 */
import { ConfigError } from "../errors.js";

const DURATION_UNITS: Record<string, number> = {
  us: 0.001,
  µs: 0.001,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  k: 1000,
  m: 1000 ** 2,
  g: 1000 ** 3,
};

const RATE_UNITS: Record<string, number> = {
  ms: 1000,
  s: 1,
  sec: 1,
  second: 1,
  m: 1 / 60,
  min: 1 / 60,
  minute: 1 / 60,
  h: 1 / 3600,
  hour: 1 / 3600,
};

function bad(kind: string, v: unknown, example: string, path?: string): ConfigError {
  const where = path ? `${path}: ` : "";
  return new ConfigError("SW_CONFIG_UNIT", `${where}Invalid ${kind} ${JSON.stringify(v)}`, {
    hint: `Use a ${kind} like ${example}`,
    details: path ? { path } : undefined,
  });
}

/** Scans a leading decimal number; returns [value, nextIndex] or null. */
function scanNumber(s: string, i: number): [number, number] | null {
  const start = i;
  while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
  if (s[i] === ".") {
    i++;
    while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
  }
  const text = s.slice(start, i);
  if (text === "" || text === ".") return null;
  // allow 1_000 style separators? keep strict: underscores not allowed
  const n = Number(text);
  return Number.isFinite(n) ? [n, i] : null;
}

function scanLetters(s: string, i: number): [string, number] {
  const start = i;
  while (i < s.length && /[a-zµ]/i.test(s[i] as string)) i++;
  return [s.slice(start, i), i];
}

function isFiniteNonNeg(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** "250ms", "30s", "5m", "1h30m", "1.5s"; number = ms. Returns milliseconds. */
export function parseDuration(v: string | number, path?: string): number {
  if (typeof v === "number") {
    if (!isFiniteNonNeg(v)) throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
    return v;
  }
  if (typeof v !== "string") throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
  const s = v.trim();
  if (s === "") throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let i = 0;
  let total = 0;
  let parts = 0;
  let lastScale = Number.POSITIVE_INFINITY;
  while (i < s.length) {
    while (s[i] === " ") i++;
    const num = scanNumber(s, i);
    if (!num) throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
    i = num[1];
    while (s[i] === " ") i++;
    const [unitRaw, next] = scanLetters(s, i);
    const unit = unitRaw.toLowerCase();
    const scale = DURATION_UNITS[unit];
    if (scale === undefined) throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
    // components must be strictly decreasing (1h30m ok, 30m1h not)
    if (scale >= lastScale) throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
    lastScale = scale;
    total += num[0] * scale;
    i = next;
    parts++;
  }
  if (parts === 0 || !Number.isFinite(total)) throw bad("duration", v, '"250ms", "30s", "1h30m"', path);
  return total;
}

/** "512B", "10KB" (1000), "5MiB" (1024); number = bytes. Returns bytes. */
export function parseBytes(v: string | number, path?: string): number {
  const ex = '"512B", "10KB", "5MiB"';
  if (typeof v === "number") {
    if (!isFiniteNonNeg(v)) throw bad("size", v, ex, path);
    return v;
  }
  if (typeof v !== "string") throw bad("size", v, ex, path);
  const s = v.trim();
  const num = scanNumber(s, 0);
  if (!num) throw bad("size", v, ex, path);
  let i = num[1];
  while (s[i] === " ") i++;
  const [unitRaw, next] = scanLetters(s, i);
  if (next !== s.length) throw bad("size", v, ex, path);
  if (unitRaw === "") return num[0];
  const scale = BYTE_UNITS[unitRaw.toLowerCase()];
  if (scale === undefined) throw bad("size", v, ex, path);
  return Math.round(num[0] * scale);
}

/** "200/s", "12000/m", "5/ms", "100 rps"; number = per second. Returns per-second rate. */
export function parseRate(v: string | number, path?: string): number {
  const ex = '"200/s", "12000/m"';
  if (typeof v === "number") {
    if (!isFiniteNonNeg(v)) throw bad("rate", v, ex, path);
    return v;
  }
  if (typeof v !== "string") throw bad("rate", v, ex, path);
  const s = v.trim();
  const num = scanNumber(s, 0);
  if (!num) throw bad("rate", v, ex, path);
  let i = num[1];
  while (s[i] === " ") i++;
  if (i === s.length) return num[0];
  if (s.slice(i).toLowerCase() === "rps") return num[0];
  if (s[i] !== "/") throw bad("rate", v, ex, path);
  i++;
  while (s[i] === " ") i++;
  const [unitRaw, next] = scanLetters(s, i);
  if (next !== s.length) throw bad("rate", v, ex, path);
  const scale = RATE_UNITS[unitRaw.toLowerCase()];
  if (scale === undefined) throw bad("rate", v, ex, path);
  return num[0] * scale;
}

/** "1%", "0.5%", 0.01, "0.01" → fraction 0..1. */
export function parsePercent(v: string | number, path?: string): number {
  const ex = '"1%", "0.5%", 0.01';
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const s = v.trim();
    const num = scanNumber(s, 0);
    if (!num) throw bad("percentage", v, ex, path);
    let i = num[1];
    while (s[i] === " ") i++;
    if (i === s.length) n = num[0];
    else if (s[i] === "%" && i === s.length - 1) n = num[0] / 100;
    else throw bad("percentage", v, ex, path);
  } else throw bad("percentage", v, ex, path);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw bad("percentage", v, ex, path);
  return n;
}

/** Formats ms compactly: 0.25 → "250µs", 250 → "250ms", 1500 → "1.5s", 5400000 → "1h30m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const neg = ms < 0;
  const a = Math.abs(ms);
  let out: string;
  if (a === 0) out = "0ms";
  else if (a < 1) out = `${trim(a * 1000)}µs`;
  else if (a < 1000) out = `${trim(a)}ms`;
  else if (a < 60_000) out = `${trim(a / 1000)}s`;
  else {
    const totalS = Math.round(a / 1000);
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    out = `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}` || "0s";
  }
  return neg ? `-${out}` : out;
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Formats bytes with binary units ("1.5 MiB"). */
export function formatBytes(b: number): string {
  if (!Number.isFinite(b)) return String(b);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = b;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trim(v)} ${units[i]}`;
}
