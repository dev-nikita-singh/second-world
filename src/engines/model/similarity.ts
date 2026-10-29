/**
 * Jaro-Winkler similarity + name normalisation — docs/04-data-structures-and-algorithms.md §5.9.
 * Used only to PROPOSE merges (with lowered confidence); exact host/service.name matches are preferred.
 */

/** Jaro similarity in [0, 1]. */
export function jaro(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 1 : 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Uint8Array(la);
  const mb = new Uint8Array(lb);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(lb - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (mb[j] || a.charCodeAt(i) !== b.charCodeAt(j)) continue;
      ma[i] = 1;
      mb[j] = 1;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) t++;
    k++;
  }
  const m = matches;
  return (m / la + m / lb + (m - t / 2) / m) / 3;
}

/** Jaro-Winkler with prefix scale p (default 0.1, prefix capped at 4). */
export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  let l = 0;
  const max = Math.min(4, a.length, b.length);
  while (l < max && a.charCodeAt(l) === b.charCodeAt(l)) l++;
  return j + l * p * (1 - j);
}

const SUFFIX_WORDS = [
  "service",
  "svc",
  "client",
  "api",
  "server",
  "app",
  "srv",
  "gateway",
  "provider",
  "fake",
  "mock",
  "stub",
  "impl",
  "adapter",
];

/**
 * Normalise a component name for comparison: split camelCase/kebab/snake/dots, lower-case,
 * drop generic suffix/prefix words (`-svc`, `Service`, `Client`, `api`, …), drop trailing `_url`/`_host`
 * style env suffixes, join without separators. Keeps the original when everything would be stripped.
 * `PaymentClient` → `payment`, `payments-svc` → `payments`, `PAYMENTS_URL` → `payments`.
 */
export function normalizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  const envSuffix = new Set([
    "url",
    "uri",
    "host",
    "hostname",
    "addr",
    "address",
    "endpoint",
    "base",
    "port",
    "dsn",
  ]);
  let ws = words.slice();
  while (ws.length > 1 && envSuffix.has(ws[ws.length - 1] as string)) ws.pop();
  const kept = ws.filter((w) => !SUFFIX_WORDS.includes(w));
  if (kept.length > 0) ws = kept;
  return ws.join("");
}

/** Singular/plural-insensitive equality helper: "payment" ~ "payments". */
export function stem(n: string): string {
  if (n.length > 3 && n.endsWith("ies")) return `${n.slice(0, -3)}y`;
  if (n.length > 3 && n.endsWith("s") && !n.endsWith("ss")) return n.slice(0, -1);
  return n;
}
