/**
 * Developer-defined Bug Hunter invariant (docs/03-engines/api-bug-hunter.md §1.4), loaded by
 * `bugs.invariants` in sw.config.ts: a page of articles never holds more than `limit` items
 * (default 20), and never more than the articles left after `offset`.
 *
 * Plain .mjs so it loads with or without a TypeScript loader.
 *
 * @param {{ method: string, url: string, status: number, body: unknown }} ex
 * @returns {true | string}
 */
export default function pageSize(ex) {
  if (ex.method !== "GET" || ex.status !== 200) return true;
  const url = new URL(ex.url);
  if (url.pathname !== "/api/articles" && url.pathname !== "/api/articles/feed") return true;
  const body = /** @type {{ articles?: unknown[], articlesCount?: number }} */ (ex.body ?? {});
  if (!Array.isArray(body.articles)) return true;
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const n = body.articles.length;
  if (Number.isFinite(limit) && n > limit) return `page has ${n} articles but limit=${limit}`;
  if (
    typeof body.articlesCount === "number" &&
    Number.isFinite(offset) &&
    n > Math.max(0, body.articlesCount - offset)
  )
    return `page has ${n} articles but only ${body.articlesCount - offset} remain after offset=${offset}`;
  return true;
}
