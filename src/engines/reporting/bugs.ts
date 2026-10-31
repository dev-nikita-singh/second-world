/**
 * API Bug Hunter rendering (docs/03-engines/api-bug-hunter.md): pass/fail matrix
 * (operation × technique), coverage, findings with replay classification (flaky k/n
 * with Wilson CI), curl reproductions, discovery-mode draft-contract note.
 *
 * Credentials: sw-bugs already writes curl with `$SW_AUTH_<ROLE>` placeholders and
 * redacts exchanges. As defence in depth, `scrubSecrets` replaces any literal
 * credential in auth/cookie/api-key headers or `-u user:pass` before display.
 */
import type { BugFindingSummary, BugsData, OperationRow, TechniqueCell } from "../bugs/types.js";
import type { Block, CellLike } from "./blocks.js";
import { fmtDuration, fmtPct } from "./model.js";

export function isBugsData(d: unknown): d is BugsData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    (o.mode === "contract" || o.mode === "discovery") &&
    Array.isArray(o.matrix) &&
    Array.isArray(o.findings) &&
    typeof o.coverage === "object" &&
    o.coverage !== null &&
    typeof o.reproductions === "object" &&
    o.reproductions !== null
  );
}

/**
 * Credential-bearing headers: name, separator, then the value up to the header's own closing
 * quote. Three passes by the character before the name, so the value always ends at the right
 * place (e.g. `-H 'Authorization: Digest username="u", response="…"'` is redacted whole):
 *   'name: value'       → value runs to the next '
 *   "name: value" / "name": "value" (JSON) → value runs to the next " (or a backslash)
 *   name: value (unquoted) → value runs to any quote, backslash or line end
 * The VALUE is handled by `scrubHeaderValue` (tokenised; no regex backtracking into the scheme
 * word — an earlier optional-scheme regex replaced "Bearer" itself and kept the token).
 */
const H = "((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)";
const SECRET_HEADERS: RegExp[] = [
  new RegExp(`(')${H}(\\s*:\\s*)([^'\\r\\n]*)`, "gi"),
  new RegExp(`(")${H}("?\\s*:\\s*"?)([^"\\\\\\r\\n]*)`, "gi"),
  new RegExp(`(^|[^'"\\w-])${H}(\\s*:\\s*)([^'"\\\\\\r\\n]*)`, "gi"),
];
/** A whole env-var placeholder: $NAME or ${NAME}. */
const PLACEHOLDER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const AUTH_SCHEMES = new Set(["bearer", "basic", "token", "digest", "negotiate", "ntlm", "apikey"]);

/**
 * Value of a credential header → kept only when it is a placeholder (`$SW_AUTH_USER`, the env
 * var holding the full header value) or "<scheme> <placeholder>"; otherwise the credential part
 * is replaced: "Bearer abc" → "Bearer [REDACTED]", "abc" → "[REDACTED]".
 */
export function scrubHeaderValue(name: string, value: string): string {
  const lead = /^\s*/.exec(value)?.[0] ?? "";
  const trail = /\s*$/.exec(value.slice(lead.length))?.[0] ?? "";
  const core = value.slice(lead.length, value.length - trail.length);
  if (core === "" || PLACEHOLDER.test(core)) return value;
  const isAuth = /authorization$/i.test(name);
  const m = /^(\S+)(\s+)(.*)$/s.exec(core);
  if (isAuth && m && AUTH_SCHEMES.has((m[1] ?? "").toLowerCase())) {
    const rest = m[3] ?? "";
    if (PLACEHOLDER.test(rest)) return value;
    return `${lead}${m[1]}${m[2]}[REDACTED]${trail}`;
  }
  return `${lead}[REDACTED]${trail}`;
}

/** Shown above curl reproductions (bugs and agent). The env var holds the FULL header value. */
export const REPRO_AUTH_HINT =
  "Credentials are never printed. Before running these commands: export SW_AUTH_<ROLE>='<full header value, e.g. Bearer …>'";

/** Non-header credential forms (no optional groups before the lookahead → no backtracking leaks). */
const SECRET_PATTERNS: [RegExp, string][] = [
  // curl -u user:password / --user user:password (quoted or not)
  [/((?:^|\s)(?:-u|--user)\s+)(['"]?)(?!\$)([^\s'"]+)/g, "$1$2[REDACTED]"],
  // query-string tokens
  [/([?&](?:access_token|token|api_key|apikey|key|password)=)(?!\$)[^&\s'"]+/gi, "$1[REDACTED]"],
];

/** Replace literal credentials with [REDACTED]; `$SW_AUTH_*` placeholders (and their scheme word) are kept. */
export function scrubSecrets(s: string): string {
  let r = s;
  for (const re of SECRET_HEADERS) {
    r = r.replace(
      re,
      (_m, pre: string, name: string, sep: string, value: string) =>
        `${pre}${name}${sep}${scrubHeaderValue(name, value)}`,
    );
  }
  for (const [re, to] of SECRET_PATTERNS) r = r.replace(re, to);
  return r;
}

/** Technique columns: configured order first, then any extra (e.g. "discovery"), only those used. */
export function techniqueColumns(d: BugsData): string[] {
  const used = new Set<string>();
  for (const row of d.matrix) for (const t of Object.keys(row.techniques)) used.add(t);
  const order = [...d.techniques, "discovery"].filter((t, i, a) => a.indexOf(t) === i);
  return [...order.filter((t) => used.has(t)), ...[...used].filter((t) => !order.includes(t)).sort()];
}

export function cellOf(row: OperationRow, technique: string): TechniqueCell | undefined {
  return (row.techniques as Record<string, TechniqueCell | undefined>)[technique];
}

function matrixCell(c: TechniqueCell | undefined): CellLike {
  if (!c || c.cases === 0) return { text: "-", tone: "muted" };
  const parts = [`${c.passed}/${c.cases}`];
  if (c.failed > 0) parts.push(`✗${c.failed}`);
  if (c.inconclusive > 0) parts.push(`?${c.inconclusive}`);
  return { text: parts.join(" "), tone: c.failed > 0 ? "bad" : c.passed === c.cases ? "good" : "warn" };
}

/** "flaky 2/5 (Wilson 95% CI 12%–77%)" or "reproduced 3/3". */
export function replayText(
  f: Pick<BugFindingSummary, "classification" | "flaky" | "failures" | "replays" | "wilson">,
): string {
  if (f.replays === 0) return f.classification === "observation" ? "observed (not replayed)" : "not replayed";
  const ci = `Wilson 95% CI ${fmtPct(f.wilson.lower)}–${fmtPct(f.wilson.upper)}`;
  if (f.flaky) return `flaky ${f.failures}/${f.replays} (${ci})`;
  return `reproduced ${f.failures}/${f.replays} (${ci})`;
}

const CLS_ORDER = { "reproduced-defect": 0, observation: 1 } as const;
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function sortBugFindings(fs: readonly BugFindingSummary[]): BugFindingSummary[] {
  return [...fs].sort(
    (a, b) =>
      (CLS_ORDER[a.classification] ?? 9) - (CLS_ORDER[b.classification] ?? 9) ||
      (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) ||
      (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0) ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );
}

export interface BugsBlockOptions {
  /** Max reproductions printed (default 10; the JSON report has all). */
  maxReproductions?: number;
}

export function bugsBlocks(d: BugsData, opts: BugsBlockOptions = {}): Block[] {
  const b: Block[] = [];
  const contract = d.contract
    ? `${d.contract.title ?? d.contract.source} v${d.contract.version} (${d.contract.operations} operations)`
    : "none (discovery mode)";
  b.push({
    kind: "kv",
    items: [
      ["mode", d.mode],
      ["target", d.target],
      ["contract", contract],
      ["seed", String(d.seed)],
      [
        "requests",
        `${d.requests.sent} sent, ${d.requests.replays} replays, ${d.requests.hookRuns} hook runs${d.requests.transportErrors > 0 ? `, ${d.requests.transportErrors} transport errors` : ""}${d.requests.rateLimited > 0 ? `, ${d.requests.rateLimited} rate-limited` : ""}`,
      ],
      [
        "mutations",
        d.mutationsAllowed
          ? "allowed"
          : {
              text: `blocked (${d.requests.mutationsBlocked} mutating requests not sent)`,
              tone: d.requests.mutationsBlocked > 0 ? "warn" : "muted",
            },
      ],
      ["duration", fmtDuration(d.durationMs)],
    ],
  });

  if (d.mode === "discovery" || d.draftContract) {
    const paths =
      d.draftContract && typeof d.draftContract.paths === "object" && d.draftContract.paths !== null
        ? Object.keys(d.draftContract.paths).length
        : 0;
    b.push({
      kind: "text",
      tone: "warn",
      text: `Discovery mode: no contract was given, so only crashes and observed behaviour were checked. A draft OpenAPI 3.1 contract inferred from observed traffic${paths > 0 ? ` (${paths} paths)` : ""} is included in the JSON report (data.draftContract); review it and pass it as the contract to enable conformance checks.`,
    });
  }

  const cov = d.coverage;
  const tech = Object.entries(cov.techniques)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
  b.push({ kind: "heading", level: 3, text: "Coverage" });
  b.push({
    kind: "kv",
    items: [
      ["operations exercised", `${cov.operations.exercised}/${cov.operations.total}`],
      ["statuses observed / documented", `${cov.statuses.observed}/${cov.statuses.documented}`],
      ["coverage ratio", fmtPct(cov.ratio)],
      ["cases by technique", tech || "-"],
    ],
  });

  const cols = techniqueColumns(d);
  if (d.matrix.length > 0) {
    b.push({
      kind: "table",
      title: "Matrix (passed/cases per operation × technique)",
      head: ["operation", "verdict", ...cols, "statuses"],
      align: ["l", "l", ...cols.map(() => "r" as const), "l"],
      rows: d.matrix.map((row) => [
        row.operation,
        row.verdict === "fail"
          ? { text: "FAIL", tone: "bad" }
          : row.verdict === "pass"
            ? { text: "pass", tone: "good" }
            : { text: "untested", tone: "muted" },
        ...cols.map((t) => matrixCell(cellOf(row, t))),
        Object.entries(row.statuses)
          .sort(([a], [z]) => (a < z ? -1 : 1))
          .map(([s, n]) => {
            const undocumented = row.documentedStatuses.length > 0 && !row.documentedStatuses.includes(s);
            return `${s}x${n}${undocumented ? "!" : ""}`;
          })
          .join(" "),
      ]),
    });
    const undocumented = d.matrix.some((r) =>
      Object.keys(r.statuses).some(
        (s) => r.documentedStatuses.length > 0 && !r.documentedStatuses.includes(s),
      ),
    );
    b.push({
      kind: "text",
      tone: "muted",
      text: `cells: passed/cases, ✗ failed cases, ? inconclusive, - not run. statuses: code x count${undocumented ? "; ! = not documented in the contract" : ""}.`,
    });
  }

  const fs = sortBugFindings(d.findings);
  if (fs.length > 0) {
    b.push({
      kind: "table",
      title: `Bug findings (${fs.length})`,
      head: ["classification", "severity", "rule", "operation", "technique", "replays", "seen", "title"],
      rows: fs.map((f) => [
        f.classification === "reproduced-defect"
          ? { text: f.classification, tone: "bad" }
          : { text: f.classification, tone: "muted" },
        f.severity,
        f.ruleId,
        f.operation,
        f.technique,
        f.flaky ? { text: replayText(f), tone: "warn" } : replayText(f),
        `${f.occurrences}x${f.minimized ? " (minimized)" : ""}`,
        f.title,
      ]),
    });
  }

  const max = opts.maxReproductions ?? 10;
  const repro = fs
    .map((f) => ({ f, r: d.reproductions[f.fingerprint] }))
    .filter((x) => x.r && x.r.curl.length > 0);
  if (repro.length > 0) {
    b.push({ kind: "heading", level: 3, text: "Reproductions" });
    b.push({
      kind: "text",
      tone: "muted",
      text: REPRO_AUTH_HINT,
    });
    for (const { f, r } of repro.slice(0, max)) {
      if (!r) continue;
      b.push({
        kind: "code",
        title: `${f.ruleId} on ${f.operation} (seed ${r.seed})${r.message ? ` — ${r.message}` : ""}`,
        lines: r.curl.map(scrubSecrets),
        lang: "sh",
      });
    }
    if (repro.length > max)
      b.push({
        kind: "text",
        tone: "muted",
        text: `${repro.length - max} more reproduction(s) in the JSON report (data.reproductions).`,
      });
  }
  return b;
}

/** Text summary used in JUnit failure bodies. */
export function cellFailureSummary(c: TechniqueCell): string {
  return `${c.failed} of ${c.cases} case(s) failed, ${c.passed} passed${c.inconclusive > 0 ? `, ${c.inconclusive} inconclusive` : ""}`;
}
