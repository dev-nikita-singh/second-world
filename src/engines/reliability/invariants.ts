/**
 * Duplicate-operation invariants. See docs/03-engines/reliability-lab.md §3 ("Duplicate operations:
 * invariant checks after the fault, e.g. count orders by idempotency key") and
 * docs/03-engines/evidence-and-history.md (trust ladder).
 *
 * During faults (timeouts, dropped responses, resets) clients retry and a non-idempotent server may
 * apply one logical mutation twice. The workload sends one unique key per logical operation
 * (`Idempotency-Key` header and/or the `$SW_OP_KEY` marker in path/body/headers), reuses it on every
 * retry, and records per-operation outcomes in an {@link OpLedger} (exact counters, bounded detail).
 * After the recovery phase the configured invariants are evaluated against the app's own state:
 *
 * - `no-duplicates`: at most one resource per workload key in a collection (`key` path in each item)
 * - `count-matches`: resources created (after − before) == operations the workload saw succeed (2xx);
 *   ambiguous operations (timeout / reset / 5xx: may or may not have been applied) widen the upper
 *   bound by one each. Above → duplicates; below → lost writes.
 * - `conserved`: Σ weight·sum(field) over collections stays constant, or changes by exactly
 *   `perOperation` per confirmed operation (ambiguous ones widen the range), ± tolerance.
 *
 * Pure helpers (selectPath, itemsOf, evalNoDuplicates, evalCount, evalConserved) are deterministic;
 * no recursion on user-sized input; all collections are size-capped.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HttpExecutor, HttpRequestSpec, HttpResult } from "../../adapters/http/undici-executor.js";
import { parseDuration } from "../../core/config/units.js";

export const OP_KEY_MARKER = "$SW_OP_KEY";
/** Max items read from one collection (all pages together). */
export const MAX_COLLECTION_ITEMS = 100_000;
/** Hard cap on pages read for one collection (`page.maxPages` defaults to 1000). */
export const MAX_COLLECTION_PAGES = 10_000;
/** Max operations whose per-key detail is kept (counters stay exact beyond it). */
export const MAX_TRACKED_OPS = 20_000;
/** Max statuses kept per operation. */
const MAX_ATTEMPT_LOG = 8;
/** Max duplicated keys / examples listed in a result. */
export const MAX_EXAMPLES = 20;

const Ms = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({
      code: "custom",
      message: e instanceof Error ? e.message : `invalid duration ${String(v)}`,
    });
    return z.NEVER;
  }
});

// ------------------------------------------------------------------------------------------ schema

/** Per-route idempotency: one key per logical operation, reused on client retries. */
export const IdempotencySchema = z
  .object({
    /** Header carrying the key; false = only substitute `$SW_OP_KEY` in path/body/headers. */
    header: z.union([z.string().min(1), z.literal(false)]).default("Idempotency-Key"),
    /** Client retries per logical operation (same key). */
    retries: z.number().int().min(0).max(10).default(2),
    /** Delay before retry k (k = 0, 1, …): backoff · 2^k. */
    backoff: Ms.default(100),
    /** What triggers a retry. transport = reset/refused/socket errors; timeout = client timeout. */
    retryOn: z.array(z.enum(["transport", "timeout", "5xx", "429"])).default(["transport", "timeout", "5xx"]),
  })
  .strict();
export type IdempotencySpec = z.output<typeof IdempotencySchema>;

const MaxPages = z.number().int().min(1).max(MAX_COLLECTION_PAGES).default(1000);
const Param = z.string().min(1).max(100);

/**
 * Opt-in pagination of a collection (docs/03-engines/reliability-lab.md, "Duplicate-operation
 * invariants"). Every page URL passes the safety guard; a `next` link to another origin is refused.
 * Pagination ends on an empty page (offset/page), a missing cursor (cursor) or a missing
 * `rel="next"` link (link). Bounds hit (maxPages, MAX_COLLECTION_ITEMS, byte budget), loops
 * (repeated cursor/URL/identical page) and refusals end it early and mark the collection partial.
 */
export const PageSchema = z.discriminatedUnion("style", [
  z
    .object({
      style: z.literal("offset"),
      offsetParam: Param.default("offset"),
      limitParam: Param.default("limit"),
      limit: z.number().int().min(1).max(10_000).default(100),
      /** First offset. */
      start: z.number().int().min(0).default(0),
      maxPages: MaxPages,
    })
    .strict(),
  z
    .object({
      style: z.literal("page"),
      pageParam: Param.default("page"),
      sizeParam: Param.default("size"),
      size: z.number().int().min(1).max(10_000).default(100),
      /** First page number. */
      start: z.number().int().min(0).default(1),
      maxPages: MaxPages,
    })
    .strict(),
  z
    .object({
      style: z.literal("cursor"),
      /** Path of the next cursor in the response JSON ("next_cursor", "meta.next"). Absent/null/"" = last page. */
      cursor: z.string().min(1),
      /** Query parameter carrying the cursor. */
      param: Param.default("cursor"),
      limitParam: Param.optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
      maxPages: MaxPages,
    })
    .strict(),
  z
    .object({
      /** RFC 8288 `Link: <url>; rel="next"` response header (same origin only). */
      style: z.literal("link"),
      limitParam: Param.optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
      maxPages: MaxPages,
    })
    .strict(),
]);
export type PageSpec = z.output<typeof PageSchema>;

const Collection = {
  /** "GET /orders", "/orders" (GET) or an absolute URL on an allowed host. Relative to the target origin. */
  collection: z.string().min(1),
  /** Opt-in pagination (default: one request). */
  page: PageSchema.optional(),
  /** Path to the item array in the response ("items", "data.orders"); default: root array or items/data/results. */
  items: z.string().optional(),
  /** Extra request headers (values are never copied into evidence). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Reuse the (auth-resolved) headers of this workload route. */
  headersFrom: z.string().optional(),
};

const NoDuplicates = z
  .object({
    type: z.literal("no-duplicates"),
    name: z.string().min(1).optional(),
    ...Collection,
    /** Path to the idempotency key / client request id inside each item. */
    key: z.string().min(1),
    /** Path to the resource id inside each item (evidence only). */
    id: z.string().default("id"),
    /** workload: only keys this run sent (default); all: any key value. */
    scope: z.enum(["workload", "all"]).default("workload"),
  })
  .strict();

const CountMatches = z
  .object({
    type: z.literal("count-matches"),
    name: z.string().min(1).optional(),
    ...Collection,
    /** Workload routes whose operations create the resources. Default: routes with `idempotency`. */
    routes: z.array(z.string()).min(1).optional(),
    /** Resources created per successful operation. */
    perOperation: z.number().int().min(0).max(1000).default(1),
  })
  .strict();

const ConservedTerm = z
  .object({
    ...Collection,
    /** Numeric path inside each item; `*` iterates arrays ("items.*.qty"). */
    field: z.string().min(1),
    weight: z.number().default(1),
  })
  .strict();

const Conserved = z
  .object({
    type: z.literal("conserved"),
    name: z.string().min(1).optional(),
    terms: z.array(ConservedTerm).min(1).max(10),
    routes: z.array(z.string()).min(1).optional(),
    /** Expected change of the weighted sum per confirmed operation (0 = constant). */
    perOperation: z.number().default(0),
    tolerance: z.number().min(0).default(0),
  })
  .strict();

export const InvariantSchema = z.discriminatedUnion("type", [NoDuplicates, CountMatches, Conserved]);
export type InvariantSpec = z.output<typeof InvariantSchema>;
export type InvariantType = InvariantSpec["type"];
export type CollectionSpec = Pick<
  z.output<typeof NoDuplicates>,
  "collection" | "items" | "headers" | "headersFrom" | "page"
>;

export function invariantName(inv: InvariantSpec): string {
  if (inv.name) return inv.name;
  if (inv.type === "conserved")
    return `conserved:${inv.terms.map((t) => `${t.collection}.${t.field}`).join("+")}`;
  return `${inv.type}:${inv.collection}${inv.type === "no-duplicates" ? `.${inv.key}` : ""}`;
}

// ------------------------------------------------------------------------------------------ paths

function splitPath(path: string): string[] {
  return path
    .replace(/\[(\d+|\*)?\]/g, (_m, g: string | undefined) => `.${g ?? "*"}`)
    .split(".")
    .filter((s) => s.length > 0);
}

/**
 * Values at a dotted path. `*` (or `[]`) iterates arrays / object values; numeric segments index
 * arrays. Iterative; at most `limit` values.
 */
export function selectPath(root: unknown, path: string, limit = 1_000_000): unknown[] {
  let frontier: unknown[] = [root];
  for (const seg of splitPath(path)) {
    const next: unknown[] = [];
    for (const v of frontier) {
      if (v === null || typeof v !== "object") continue;
      if (seg === "*") {
        const vals = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
        for (const x of vals) {
          if (next.length >= limit) break;
          next.push(x);
        }
      } else if (Array.isArray(v)) {
        if (/^\d+$/.test(seg) && Number(seg) < v.length) next.push(v[Number(seg)]);
      } else if (Object.hasOwn(v, seg)) next.push((v as Record<string, unknown>)[seg]);
      if (next.length >= limit) break;
    }
    frontier = next;
  }
  return frontier.filter((x) => x !== undefined);
}

/** The item array of a collection response. */
export function itemsOf(body: unknown, itemsPath?: string): unknown[] {
  if (itemsPath !== undefined && itemsPath !== "") {
    const sel = selectPath(body, itemsPath, 1);
    const arr = sel[0];
    if (!Array.isArray(arr)) throw new Error(`"${itemsPath}" is not an array in the response`);
    return arr;
  }
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const k of ["items", "data", "results", "records"]) {
      const v = (body as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  throw new Error("response has no item array (set `items` to its path)");
}

function scalarKey(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Sum of the finite numbers at `field` in every item (`*` allowed). */
export function sumField(items: readonly unknown[], field: string): { sum: number; values: number } {
  let sum = 0;
  let values = 0;
  for (const it of items) {
    for (const v of selectPath(it, field)) {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
      if (Number.isFinite(n)) {
        sum += n;
        values++;
      }
    }
  }
  return { sum, values };
}

// ------------------------------------------------------------------------------------------ ledger

export type AttemptClass = "ok" | "rejected" | "ambiguous" | "unsent" | "aborted";
export type LedgerPhase = "steady" | "fault" | "recovery";

export interface OpDetail {
  key: string | null;
  route: string;
  attempts: number;
  /** Status per attempt (0 = transport error), capped. */
  statuses: number[];
  /** Phase when the first attempt started. */
  phase: LedgerPhase;
  /** Final classification of the logical operation. */
  outcome: AttemptClass;
}

export interface RouteOpCounts {
  ops: number;
  /** Final 2xx/3xx. */
  confirmed: number;
  /** Final 4xx with no earlier ambiguous attempt (not applied). */
  rejected: number;
  /** May or may not have been applied (timeout / reset / 5xx somewhere, no success). */
  ambiguous: number;
  /** Never reached the server (refused, DNS, safety). */
  unsent: number;
  /** Interrupted by the end of the run. */
  aborted: number;
  /** Operations that needed ≥ 1 retry. */
  retried: number;
  attempts: number;
  /** Retried operations whose first attempt started while the fault was active. */
  retriedDuringFault: number;
}

const emptyCounts = (): RouteOpCounts => ({
  ops: 0,
  confirmed: 0,
  rejected: 0,
  ambiguous: 0,
  unsent: 0,
  aborted: 0,
  retried: 0,
  attempts: 0,
  retriedDuringFault: 0,
});

export function classifyAttempt(r: Pick<HttpResult, "status" | "error">): AttemptClass {
  if (r.error) {
    if (r.error.kind === "aborted") return "aborted";
    if (
      r.error.kind === "econnrefused" ||
      r.error.kind === "connect-timeout" ||
      r.error.kind === "dns" ||
      r.error.kind === "safety"
    )
      return "unsent";
    return "ambiguous";
  }
  if (r.status >= 200 && r.status < 400) return "ok";
  if (r.status >= 500 || r.status === 0) return "ambiguous";
  return "rejected";
}

function retryable(r: Pick<HttpResult, "status" | "error">, on: IdempotencySpec["retryOn"]): boolean {
  if (r.error) {
    if (r.error.kind === "aborted" || r.error.kind === "safety") return false;
    return r.error.kind === "timeout" ? on.includes("timeout") : on.includes("transport");
  }
  if (r.status === 429) return on.includes("429");
  return r.status >= 500 && on.includes("5xx");
}

/** Per-run record of logical operations: exact per-route counters, bounded per-key detail. */
export class OpLedger {
  /** Set by the runner when the fault is applied / reverted. */
  phase: LedgerPhase = "steady";
  readonly counts = new Map<string, RouteOpCounts>();
  private readonly detail = new Map<string, OpDetail>();
  private seq = 0;
  /** Operations whose detail was not kept (MAX_TRACKED_OPS reached). */
  untracked = 0;

  constructor(
    /** Unique per run, e.g. "sw-01h2x3-r0". Keys are `${prefix}-${n}`. */
    readonly prefix: string,
    private readonly maxTracked = MAX_TRACKED_OPS,
  ) {}

  nextKey(): string {
    return `${this.prefix}-${++this.seq}`;
  }

  /** True when `key` was generated by this ledger. */
  owns(key: string): boolean {
    return key.startsWith(`${this.prefix}-`) && /^\d+$/.test(key.slice(this.prefix.length + 1));
  }

  get(key: string): OpDetail | undefined {
    return this.detail.get(key);
  }

  routeCounts(route: string): RouteOpCounts {
    return this.counts.get(route) ?? emptyCounts();
  }

  /** Records one finished logical operation (all its attempts). */
  record(
    route: string,
    key: string | null,
    attempts: AttemptClass[],
    statuses: number[],
    phase: LedgerPhase,
  ): void {
    let c = this.counts.get(route);
    if (!c) {
      c = emptyCounts();
      this.counts.set(route, c);
    }
    const last = attempts[attempts.length - 1] ?? "aborted";
    const anyAmbiguous = attempts.some((a) => a === "ambiguous");
    const outcome: AttemptClass =
      last === "ok"
        ? "ok"
        : last === "aborted"
          ? anyAmbiguous
            ? "ambiguous"
            : "aborted"
          : anyAmbiguous
            ? "ambiguous"
            : last;
    c.ops++;
    c.attempts += attempts.length;
    if (attempts.length > 1) {
      c.retried++;
      if (phase === "fault") c.retriedDuringFault++;
    }
    if (outcome === "ok") c.confirmed++;
    else if (outcome === "rejected") c.rejected++;
    else if (outcome === "ambiguous") c.ambiguous++;
    else if (outcome === "unsent") c.unsent++;
    else c.aborted++;
    if (key === null) return;
    if (this.detail.size >= this.maxTracked) {
      this.untracked++;
      return;
    }
    this.detail.set(key, {
      key,
      route,
      attempts: attempts.length,
      statuses: statuses.slice(0, MAX_ATTEMPT_LOG),
      phase,
      outcome,
    });
  }
}

// ------------------------------------------------------------------------------------------ executor

function headerList(h: HttpRequestSpec["headers"]): string[] {
  if (!h) return [];
  if (Array.isArray(h)) return h.slice();
  const out: string[] = [];
  for (const [k, v] of Object.entries(h)) out.push(k, v);
  return out;
}

function getHeader(h: HttpRequestSpec["headers"], name: string): string | undefined {
  const list = headerList(h);
  for (let i = 0; i + 1 < list.length; i += 2)
    if ((list[i] as string).toLowerCase() === name) return list[i + 1];
  return undefined;
}

/** Puts `key` into the request: marker substitution in path/headers/body + the idempotency header. */
export function withOpKey(req: HttpRequestSpec, key: string, header: string | false): HttpRequestSpec {
  const list = headerList(req.headers);
  let body = req.body;
  let bodyChanged = false;
  if (body !== undefined) {
    const s = typeof body === "string" ? body : body.includes(OP_KEY_MARKER) ? body.toString("utf8") : null;
    if (s?.includes(OP_KEY_MARKER)) {
      body = s.split(OP_KEY_MARKER).join(key);
      bodyChanged = true;
    }
  }
  const out: string[] = [];
  const hl = header === false ? null : header.toLowerCase();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = list[i] as string;
    const v = list[i + 1] as string;
    const kl = k.toLowerCase();
    if (hl !== null && kl === hl) continue;
    if (bodyChanged && kl === "content-length") continue;
    out.push(k, v.includes(OP_KEY_MARKER) ? v.split(OP_KEY_MARKER).join(key) : v);
  }
  if (header !== false) out.push(header, key);
  if (bodyChanged && typeof body === "string") out.push("content-length", String(Buffer.byteLength(body)));
  const next: HttpRequestSpec = {
    ...req,
    path: req.path.includes(OP_KEY_MARKER)
      ? req.path.split(OP_KEY_MARKER).join(encodeURIComponent(key))
      : req.path,
    headers: out,
  };
  if (body !== undefined) next.body = body;
  return next;
}

export interface OpExecutorOptions {
  routeHeader: string;
  /** Routes with idempotency → keyed + retried; routes in `counted` without it → counted only. */
  idempotency: ReadonlyMap<string, IdempotencySpec>;
  counted: ReadonlySet<string>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Wraps an executor (usually the recording one, so every attempt is recorded): one key per logical
 * operation, client retries with the same key, outcome recorded in the ledger. The result returned
 * to the load generator is the last attempt's, timed from the first attempt (logical latency).
 */
export function opExecutor(inner: HttpExecutor, ledger: OpLedger, opts: OpExecutorOptions): HttpExecutor {
  return {
    async execute(req, signal) {
      const route = getHeader(req.headers, opts.routeHeader) ?? "default";
      const idem = opts.idempotency.get(route);
      if (!idem && !opts.counted.has(route)) return inner.execute(req, signal);
      const phase = ledger.phase;
      const key = idem ? ledger.nextKey() : null;
      const sent = key !== null && idem ? withOpKey(req, key, idem.header) : req;
      const classes: AttemptClass[] = [];
      const statuses: number[] = [];
      const maxAttempts = 1 + (idem?.retries ?? 0);
      let first: HttpResult | undefined;
      let r: HttpResult;
      for (let a = 0; ; a++) {
        r = await inner.execute(sent, signal);
        first ??= r;
        classes.push(classifyAttempt(r));
        statuses.push(r.status);
        if (!idem || a + 1 >= maxAttempts || signal?.aborted || !retryable(r, idem.retryOn)) break;
        try {
          await opts.sleep(idem.backoff * 2 ** a, signal);
        } catch {
          break;
        }
        if (signal?.aborted) break;
      }
      ledger.record(route, key, classes, statuses, phase);
      if (classes.length > 1 && r.error?.kind !== "aborted") return { ...r, tStart: first.tStart };
      return r;
    },
    get inFlight() {
      return inner.inFlight;
    },
    get openSockets() {
      return inner.openSockets;
    },
    close: () => inner.close(),
  };
}

// ------------------------------------------------------------------------------------------ evaluation

export interface DuplicateGroup {
  key: string;
  count: number;
  /** Resource ids (capped). */
  ids: string[];
}

/**
 * Groups items by key; returns keys with > 1 resource (sorted by count desc, key). An item whose id
 * was already seen under the same key is the same resource listed twice (e.g. a page boundary that
 * shifted), not a duplicate: it is skipped and counted in `repeated`.
 */
export function evalNoDuplicates(
  items: readonly unknown[],
  keyPath: string,
  idPath: string,
  include: (key: string) => boolean,
): {
  checked: number;
  distinct: number;
  unkeyed: number;
  repeated: number;
  duplicates: DuplicateGroup[];
  extra: number;
} {
  const groups = new Map<string, DuplicateGroup>();
  const seenIds = new Set<string>();
  let unkeyed = 0;
  let checked = 0;
  let repeated = 0;
  for (const it of items) {
    const key = scalarKey(selectPath(it, keyPath, 1)[0]);
    if (key === undefined) {
      unkeyed++;
      continue;
    }
    if (!include(key)) continue;
    const id = scalarKey(selectPath(it, idPath, 1)[0]);
    if (id !== undefined) {
      const pair = JSON.stringify([key, id]);
      if (seenIds.has(pair)) {
        repeated++;
        continue;
      }
      seenIds.add(pair);
    }
    checked++;
    let g = groups.get(key);
    if (!g) {
      g = { key, count: 0, ids: [] };
      groups.set(key, g);
    }
    g.count++;
    if (id !== undefined && g.ids.length < 5) g.ids.push(id);
  }
  const duplicates = [...groups.values()].filter((g) => g.count > 1);
  duplicates.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const extra = duplicates.reduce((s, g) => s + g.count - 1, 0);
  return { checked, distinct: groups.size, unkeyed, repeated, duplicates, extra };
}

export interface RangeVerdict {
  /** Allowed change [min, max]. */
  expected: { min: number; max: number };
  observed: number;
  held: boolean;
  /** observed above max → "excess", below min → "deficit". */
  direction: "ok" | "excess" | "deficit";
}

function range(lo: number, hi: number, observed: number, tol: number): RangeVerdict {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const eps = tol + 1e-9 * Math.max(1, Math.abs(min), Math.abs(max));
  const direction = observed > max + eps ? "excess" : observed < min - eps ? "deficit" : "ok";
  return { expected: { min, max }, observed, held: direction === "ok", direction };
}

/** count-matches: created = after − before must lie in [confirmed, confirmed + ambiguous] × perOperation. */
export function evalCount(
  before: number,
  after: number,
  ops: Pick<RouteOpCounts, "confirmed" | "ambiguous">,
  perOperation = 1,
): RangeVerdict {
  return range(
    ops.confirmed * perOperation,
    (ops.confirmed + ops.ambiguous) * perOperation,
    after - before,
    0,
  );
}

/** conserved: Δsum must lie in perOperation × [confirmed, confirmed + ambiguous] ± tolerance. */
export function evalConserved(
  before: number,
  after: number,
  ops: Pick<RouteOpCounts, "confirmed" | "ambiguous">,
  perOperation = 0,
  tolerance = 0,
): RangeVerdict {
  return range(
    ops.confirmed * perOperation,
    (ops.confirmed + ops.ambiguous) * perOperation,
    after - before,
    tolerance,
  );
}

/** Sums counters over routes. */
export function sumCounts(ledger: OpLedger, routes: readonly string[]): RouteOpCounts {
  const s = emptyCounts();
  for (const r of routes) {
    const c = ledger.routeCounts(r);
    for (const k of Object.keys(s) as (keyof RouteOpCounts)[]) s[k] += c[k];
  }
  return s;
}

// ------------------------------------------------------------------------------------------ fetching

/**
 * Items of a collection. `partial` is set when pagination stopped early (a bound, a loop or a
 * refused link): the items are only a prefix of the collection and invariants on them are not trusted.
 */
export type CollectionItems = unknown[] & { partial?: string; pages?: number };

export interface CollectionFetcher {
  /** Item array of a collection (throws with a readable message on HTTP/parse errors). */
  items(c: CollectionSpec): Promise<CollectionItems>;
}

/** Parses "GET /orders", "/orders", "https://h/x" → method + url. */
export function parseCollectionRef(ref: string, target: string): { method: string; url: URL } {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(ref);
  const method = m ? (m[1] as string).toUpperCase() : "GET";
  const rest = m ? (m[2] as string) : ref.trim();
  return { method, url: new URL(rest, new URL(target).origin) };
}

/**
 * The `rel="next"` target of an RFC 8288 Link header (relative URLs resolved against `base`), or
 * null. Handles several links per header, multiple rel values and quoted/unquoted params.
 */
export function nextLink(header: string | string[] | undefined, base: URL): URL | null {
  if (header === undefined) return null;
  const text = Array.isArray(header) ? header.join(", ") : header;
  const re = /<([^>]*)>([^<]*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const params = m[2] as string;
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i.exec(params);
    const rels = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/);
    if (!rels.includes("next")) continue;
    try {
      return new URL((m[1] as string).trim(), base);
    } catch {
      return null;
    }
  }
  return null;
}

function cursorValue(body: unknown, path: string): string | null {
  const v = selectPath(body, path, 1)[0];
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function createCollectionFetcher(opts: {
  executor: HttpExecutor;
  target: string;
  routeHeaders: (route: string) => Record<string, string> | undefined;
  checkUrl: (u: URL) => void;
  signal?: AbortSignal;
  /** Max bytes of one response. */
  maxBodyBytes: number;
  /** Max bytes over all pages of one collection (default 4 × maxBodyBytes). */
  maxTotalBytes?: number;
  /** Max items over all pages (default MAX_COLLECTION_ITEMS). */
  maxItems?: number;
}): CollectionFetcher {
  const maxItems = opts.maxItems ?? MAX_COLLECTION_ITEMS;
  const maxTotalBytes = opts.maxTotalBytes ?? 4 * opts.maxBodyBytes;

  async function fetchJson(
    method: string,
    url: URL,
    headers: Record<string, string>,
    label: string,
  ): Promise<{ body: unknown; raw: Buffer; headers: HttpResult["headers"] }> {
    opts.checkUrl(url);
    const r = await opts.executor.execute(
      { origin: url.origin, method, path: `${url.pathname}${url.search}`, headers, readBody: true },
      opts.signal,
    );
    if (r.error) throw new Error(`${label}: ${r.error.kind}`);
    if (r.status < 200 || r.status >= 300) throw new Error(`${label}: HTTP ${r.status}`);
    if (r.bytesIn > opts.maxBodyBytes)
      throw new Error(`${label}: response larger than ${opts.maxBodyBytes} bytes`);
    const raw = r.body ?? Buffer.alloc(0);
    try {
      return { body: JSON.parse(raw.toString("utf8")), raw, headers: r.headers };
    } catch {
      throw new Error(`${label}: response is not JSON`);
    }
  }

  async function fetchPages(
    method: string,
    first: URL,
    headers: Record<string, string>,
    label: string,
    page: PageSpec,
    itemsPath: string | undefined,
  ): Promise<CollectionItems> {
    const out: CollectionItems = [];
    const seenUrls = new Set<string>();
    const seenCursors = new Set<string>();
    const seenBodies = new Set<string>();
    let totalBytes = 0;
    let pages = 0;
    let partial: string | undefined;
    let offset = page.style === "offset" ? page.start : 0;
    let pageNo = page.style === "page" ? page.start : 0;
    const setParam = (u: URL, param: string | undefined, value: number | undefined) => {
      if (param !== undefined && value !== undefined) u.searchParams.set(param, String(value));
    };
    let url: URL | null = new URL(first.href);
    if (page.style === "offset") {
      setParam(url, page.offsetParam, offset);
      setParam(url, page.limitParam, page.limit);
    } else if (page.style === "page") {
      setParam(url, page.pageParam, pageNo);
      setParam(url, page.sizeParam, page.size);
    } else setParam(url, page.limitParam, page.limit);

    while (url !== null) {
      if (opts.signal?.aborted) throw new Error(`${label}: aborted`);
      if (pages >= page.maxPages) {
        partial = `page limit reached (maxPages ${page.maxPages})`;
        break;
      }
      if (seenUrls.has(url.href)) {
        partial = "pagination loop: a page URL repeated";
        break;
      }
      seenUrls.add(url.href);
      const res = await fetchJson(method, url, headers, `${label} (page ${pages + 1})`);
      pages++;
      totalBytes += res.raw.length;
      const items = itemsOf(res.body, itemsPath);
      const digest = createHash("sha256").update(res.raw).digest("base64");
      if (items.length > 0 && seenBodies.has(digest)) {
        partial = `pagination loop: page ${pages} repeats an earlier page (pagination parameter ignored?)`;
        break;
      }
      seenBodies.add(digest);
      if (out.length + items.length > maxItems) {
        for (let i = 0; out.length < maxItems; i++) out.push(items[i]);
        partial = `item limit reached (${maxItems} items)`;
        break;
      }
      for (const it of items) out.push(it);
      if (totalBytes > maxTotalBytes) {
        partial = `byte budget reached (${maxTotalBytes} bytes)`;
        break;
      }
      let next: URL | null = null;
      if (page.style === "offset" || page.style === "page") {
        // Ends on an EMPTY page only: a short page may just be a server-side size clamp.
        if (items.length > 0) {
          next = new URL(url.href);
          if (page.style === "offset") {
            offset += items.length;
            setParam(next, page.offsetParam, offset);
          } else {
            pageNo++;
            setParam(next, page.pageParam, pageNo);
          }
        }
      } else if (page.style === "cursor") {
        const cur = cursorValue(res.body, page.cursor);
        if (cur !== null) {
          if (seenCursors.has(cur)) {
            partial = `pagination loop: cursor repeated after page ${pages}`;
            break;
          }
          seenCursors.add(cur);
          next = new URL(url.href);
          next.searchParams.set(page.param, cur);
        }
      } else {
        const link = res.headers?.link;
        next = nextLink(typeof link === "string" || Array.isArray(link) ? link : undefined, url);
        if (next !== null && next.origin !== first.origin) {
          partial = `next link to another origin (${next.protocol}//${next.host}) refused`;
          break;
        }
      }
      url = next;
    }
    out.pages = pages;
    if (partial !== undefined)
      out.partial = `${label}: ${partial}; read ${out.length} item(s) from ${pages} page(s)`;
    return out;
  }

  return {
    async items(c) {
      const { method, url } = parseCollectionRef(c.collection, opts.target);
      const headers: Record<string, string> = {};
      const from = c.headersFrom !== undefined ? opts.routeHeaders(c.headersFrom) : undefined;
      for (const [k, v] of Object.entries(from ?? {})) {
        const kl = k.toLowerCase();
        if (
          kl === "x-sw-route" ||
          kl === "content-type" ||
          kl === "content-length" ||
          v.includes(OP_KEY_MARKER)
        )
          continue;
        headers[kl] = v;
      }
      for (const [k, v] of Object.entries(c.headers)) headers[k.toLowerCase()] = v;
      headers.accept ??= "application/json";
      const label = `${method} ${url.pathname}`;
      if (c.page) return fetchPages(method, url, headers, label, c.page, c.items);
      const { body } = await fetchJson(method, url, headers, label);
      const items = itemsOf(body, c.items);
      if (items.length > maxItems)
        throw new Error(`${label}: ${items.length} items > ${maxItems} (narrow the collection)`);
      return items;
    },
  };
}

// ------------------------------------------------------------------------------------------ run-level

/** Baseline taken before the workload starts (count-matches: item count; conserved: weighted sum). */
export type InvariantBaseline = { value: number; partial?: string[] } | { error: string } | null;

const partialOf = (reasons: string[]): { partial?: string[] } =>
  reasons.length > 0 ? { partial: reasons } : {};

export async function takeBaselines(
  invariants: readonly InvariantSpec[],
  fetcher: CollectionFetcher,
): Promise<InvariantBaseline[]> {
  const out: InvariantBaseline[] = [];
  for (const inv of invariants) {
    try {
      if (inv.type === "no-duplicates") out.push(null);
      else if (inv.type === "count-matches") {
        const items = await fetcher.items(inv);
        out.push({ value: items.length, ...partialOf(items.partial ? [items.partial] : []) });
      } else {
        const w = await weightedSum(inv.terms, fetcher);
        out.push({ value: w.sum, ...partialOf(w.partial) });
      }
    } catch (e) {
      out.push({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function weightedSum(
  terms: z.output<typeof ConservedTerm>[],
  fetcher: CollectionFetcher,
): Promise<{ sum: number; partial: string[] }> {
  let sum = 0;
  const partial: string[] = [];
  for (const t of terms) {
    const items = await fetcher.items(t);
    if (items.partial) partial.push(items.partial);
    sum += t.weight * sumField(items, t.field).sum;
  }
  return { sum, partial };
}

export interface DuplicateEvidence extends DuplicateGroup {
  route: string | null;
  attempts: number | null;
  statuses: number[];
  phase: LedgerPhase | null;
  outcome: AttemptClass | null;
}

/** Result of one invariant in one run (ReliabilityData.runs[].invariants). */
export interface InvariantResult {
  name: string;
  type: InvariantType;
  status: "held" | "violated" | "error";
  /** Human-readable verdict (no secrets). */
  detail: string;
  /** count-matches / conserved. */
  before?: number;
  after?: number;
  expected?: { min: number; max: number };
  observed?: number;
  direction?: "ok" | "excess" | "deficit";
  /** Operations of the attributed routes. */
  ops?: RouteOpCounts;
  /** no-duplicates. */
  checked?: number;
  duplicateKeys?: number;
  extraResources?: number;
  duplicates?: DuplicateEvidence[];
  error?: string;
  /**
   * Set when a collection was read only partially (pagination bound, loop or refused link). The
   * result is then not trusted: status "error", except a no-duplicates violation (duplicates found in
   * a prefix of the collection are real; the counts are lower bounds).
   */
  partial?: string[];
}

const UNTRUSTED = "not trusted: evaluated on a partial collection";

export function defaultCountedRoutes(inv: InvariantSpec, idempotentRoutes: readonly string[]): string[] {
  if (inv.type === "no-duplicates") return [];
  return inv.routes ?? [...idempotentRoutes];
}

export async function evaluateInvariants(
  invariants: readonly InvariantSpec[],
  baselines: readonly InvariantBaseline[],
  fetcher: CollectionFetcher,
  ledger: OpLedger,
  idempotentRoutes: readonly string[],
): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  for (const [i, inv] of invariants.entries()) {
    const name = invariantName(inv);
    try {
      if (inv.type === "no-duplicates") {
        const items = await fetcher.items(inv);
        const ev = evalNoDuplicates(
          items,
          inv.key,
          inv.id,
          inv.scope === "all" ? () => true : (k) => ledger.owns(k),
        );
        const duplicates: DuplicateEvidence[] = ev.duplicates.slice(0, MAX_EXAMPLES).map((g) => {
          const d = ledger.get(g.key);
          return {
            ...g,
            route: d?.route ?? null,
            attempts: d?.attempts ?? null,
            statuses: d?.statuses ?? [],
            phase: d?.phase ?? null,
            outcome: d?.outcome ?? null,
          };
        });
        const held = ev.duplicates.length === 0;
        const unattributable = inv.scope === "workload" && ev.checked === 0;
        const partial = items.partial;
        let detail = unattributable
          ? `not evaluated: no resource carries a key sent by this run (key path "${inv.key}"; ${ev.unkeyed} item(s) without a key)`
          : held
            ? `${ev.checked} resource(s) with ${ev.distinct} distinct key(s): no duplicates`
            : `${ev.duplicates.length} key(s) have more than one resource (${ev.extra} extra of ${ev.checked})`;
        let error = unattributable ? "no resource carries a workload key" : undefined;
        if (partial !== undefined) {
          if (held || unattributable) {
            error = `${UNTRUSTED} (${partial})`;
            detail = `${UNTRUSTED} (${partial}): ${detail}`;
          } else detail = `at least ${detail}; partial collection (${partial})`;
        }
        out.push({
          name,
          type: inv.type,
          status: unattributable || (held && partial !== undefined) ? "error" : held ? "held" : "violated",
          detail,
          checked: ev.checked,
          duplicateKeys: ev.duplicates.length,
          extraResources: ev.extra,
          duplicates,
          ...(error !== undefined ? { error } : {}),
          ...partialOf(partial !== undefined ? [partial] : []),
        });
        continue;
      }
      const base = baselines[i];
      if (!base || "error" in base)
        throw new Error(`baseline: ${base && "error" in base ? base.error : "missing"}`);
      const routes = defaultCountedRoutes(inv, idempotentRoutes);
      const ops = sumCounts(ledger, routes);
      const partial = [...(base.partial ?? [])];
      const untrusted = (detail: string) =>
        partial.length > 0
          ? {
              status: "error" as const,
              detail: `${UNTRUSTED} (${partial.join("; ")}): ${detail}`,
              error: `${UNTRUSTED} (${partial.join("; ")})`,
              partial,
            }
          : null;
      if (inv.type === "count-matches") {
        const afterItems = await fetcher.items(inv);
        if (afterItems.partial) partial.push(afterItems.partial);
        const after = afterItems.length;
        const v = evalCount(base.value, after, ops, inv.perOperation);
        const detail = `${v.observed} resource(s) created; ${ops.confirmed} confirmed + ${ops.ambiguous} ambiguous operation(s) allow ${fmtRange(v.expected)}${v.direction === "excess" ? " → duplicates" : v.direction === "deficit" ? " → lost writes" : ""}`;
        out.push({
          name,
          type: inv.type,
          status: v.held ? "held" : "violated",
          detail,
          before: base.value,
          after,
          expected: v.expected,
          observed: v.observed,
          direction: v.direction,
          ops,
          ...untrusted(detail),
        });
      } else {
        const w = await weightedSum(inv.terms, fetcher);
        partial.push(...w.partial);
        const after = w.sum;
        const v = evalConserved(base.value, after, ops, inv.perOperation, inv.tolerance);
        const detail = `sum ${round(base.value)} → ${round(after)} (Δ ${round(v.observed)}), allowed Δ ${fmtRange(v.expected)}${inv.tolerance > 0 ? ` ± ${inv.tolerance}` : ""}`;
        out.push({
          name,
          type: inv.type,
          status: v.held ? "held" : "violated",
          detail,
          before: base.value,
          after,
          expected: v.expected,
          observed: v.observed,
          direction: v.direction,
          ops,
          ...untrusted(detail),
        });
      }
    } catch (e) {
      out.push({
        name,
        type: inv.type,
        status: "error",
        detail: `not evaluated: ${e instanceof Error ? e.message : String(e)}`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function fmtRange(r: { min: number; max: number }): string {
  return r.min === r.max ? `${round(r.min)}` : `${round(r.min)}..${round(r.max)}`;
}

// ------------------------------------------------------------------------------------------ detections

export interface InvariantDetection {
  ruleId: string;
  severity: "high" | "medium";
  title: string;
  description: string;
  recommendation: string;
  metrics: { metric: string; value: number; unit: string }[];
  notes: string[];
  /** Groups hits of the same invariant across repetitions. */
  group: string;
}

const PHASE_LABEL: Record<LedgerPhase, string> = {
  steady: "before the fault",
  fault: "while the fault was active",
  recovery: "after the revert",
};

/**
 * Violated invariants → detections (kind "detector" in the engine: observation, reproduced-defect
 * when hit in every one of ≥ 2 repetitions). `redact` scrubs every free-text value (keys, ids).
 */
export function invariantDetections(
  results: readonly InvariantResult[],
  ctx: { dependency: string; faults: readonly string[]; redact: (s: string) => string },
): InvariantDetection[] {
  const out: InvariantDetection[] = [];
  const fault = ctx.faults.length > 0 ? ctx.faults.join(" + ") : "no fault";
  for (const r of results) {
    if (r.status !== "violated") continue;
    const opsNote = r.ops
      ? `Workload operations: ${r.ops.ops} (${r.ops.confirmed} confirmed 2xx, ${r.ops.ambiguous} ambiguous, ${r.ops.rejected} rejected 4xx, ${r.ops.unsent} unsent); ${r.ops.retried} retried with the same key, ${r.ops.retriedDuringFault} of them first sent while the fault was active`
      : null;
    const faultNote = `Fault active during the run: ${fault} on ${ctx.dependency}`;
    if (r.type === "no-duplicates") {
      const dups = r.duplicates ?? [];
      const duringFault = dups.filter((d) => d.phase === "fault").length;
      const notes = dups.map((d) =>
        ctx.redact(
          `key ${d.key}: ${d.count} resources${d.ids.length ? ` (ids ${d.ids.join(", ")})` : ""}${d.attempts !== null ? `; ${d.attempts} attempt(s) [${d.statuses.map((s) => (s === 0 ? "error" : String(s))).join(", ")}], outcome ${d.outcome}, first sent ${PHASE_LABEL[d.phase ?? "steady"]}` : "; not in the bounded ledger"}`,
        ),
      );
      if ((r.duplicateKeys ?? 0) > dups.length)
        notes.push(`… ${(r.duplicateKeys ?? 0) - dups.length} more duplicated key(s)`);
      notes.push(faultNote);
      out.push({
        ruleId: "reliability/duplicate-operation",
        severity: "high",
        group: `reliability/duplicate-operation|${r.name}`,
        title: ctx.redact(
          `Duplicate operations: ${r.duplicateKeys} idempotency key(s) applied more than once (${r.name})`,
        ),
        description: ctx.redact(
          `After the fault experiment, ${r.duplicateKeys} key(s) map to more than one resource (${r.extraResources} extra resource(s) among ${r.checked} checked). Each key identifies ONE logical operation that the client retried with the same key; ${duringFault} of the listed keys were first sent ${PHASE_LABEL.fault} (${fault}). The server applied the retried mutation again instead of replaying the first result.`,
        ),
        recommendation:
          "Honour the Idempotency-Key: reserve the key atomically (unique constraint) before doing the work and replay the stored response on retries",
        metrics: [
          { metric: "invariant.duplicate_keys", value: r.duplicateKeys ?? 0, unit: "count" },
          { metric: "invariant.extra_resources", value: r.extraResources ?? 0, unit: "count" },
          { metric: "invariant.checked_resources", value: r.checked ?? 0, unit: "count" },
        ],
        notes,
      });
      continue;
    }
    const exp = r.expected ?? { min: 0, max: 0 };
    const metrics = [
      { metric: "invariant.expected_min", value: exp.min, unit: "value" },
      { metric: "invariant.expected_max", value: exp.max, unit: "value" },
      { metric: "invariant.observed", value: r.observed ?? 0, unit: "value" },
      { metric: "invariant.before", value: r.before ?? 0, unit: "value" },
      { metric: "invariant.after", value: r.after ?? 0, unit: "value" },
    ];
    const notes = [ctx.redact(`${r.name}: ${r.detail}`), ...(opsNote ? [opsNote] : []), faultNote];
    if (r.type === "count-matches") {
      const excess = r.direction === "excess";
      out.push({
        ruleId: excess ? "reliability/duplicate-operation" : "reliability/lost-write",
        severity: "high",
        group: `${excess ? "reliability/duplicate-operation" : "reliability/lost-write"}|${r.name}`,
        title: ctx.redact(
          excess
            ? `Duplicate operations: ${r.observed} resources created for at most ${exp.max} operation(s) (${r.name})`
            : `Lost writes: ${r.observed} resources created for ${exp.min} confirmed operation(s) (${r.name})`,
        ),
        description: ctx.redact(
          excess
            ? `The collection grew by ${r.observed} while the workload saw ${r.ops?.confirmed ?? 0} successful (2xx) operation(s) and ${r.ops?.ambiguous ?? 0} ambiguous one(s) (timeout, reset or 5xx; counted as possibly applied once). Retried operations were applied more than once during/after ${fault} on ${ctx.dependency}.`
            : `The collection grew by only ${r.observed} although the server confirmed ${exp.min} operation(s) with 2xx: acknowledged writes were lost during/after ${fault} on ${ctx.dependency}.`,
        ),
        recommendation: excess
          ? "Make the mutation idempotent (store key → result, replay on retry); never apply a retried request twice"
          : "Only acknowledge a write after it is durable; check rollbacks and caches around the dependency failure",
        metrics,
        notes,
      });
    } else {
      out.push({
        ruleId: "reliability/invariant-violated",
        severity: "high",
        group: `reliability/invariant-violated|${r.name}`,
        title: ctx.redact(
          `Conservation violated: Δ ${round(r.observed ?? 0)} outside ${fmtRange(exp)} (${r.name})`,
        ),
        description: ctx.redact(
          `The conserved quantity changed by ${round(r.observed ?? 0)} (from ${round(r.before ?? 0)} to ${round(r.after ?? 0)}) but ${r.ops?.confirmed ?? 0} confirmed operation(s) allow ${fmtRange(exp)}. Operations were applied twice, partially, or lost during/after ${fault} on ${ctx.dependency}.`,
        ),
        recommendation:
          "Apply each logical operation exactly once and atomically (idempotency key + transaction covering every affected record)",
        metrics,
        notes,
      });
    }
  }
  return out;
}
