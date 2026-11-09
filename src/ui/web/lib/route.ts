/** Hash routing for the UI (no DOM). `#/runs/<id>` etc. Tested in tests/unit/ui/web/route.test.ts. */

export type Route =
  | { page: "dashboard" }
  | { page: "runs" }
  | { page: "run"; id: string; finding?: string }
  | { page: "compare"; baseline: string; current: string }
  | { page: "findings" }
  | { page: "new"; engine?: string }
  | { page: "job"; id: string }
  | { page: "settings" };

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  // The session token arrives as "#t=…": that is the dashboard.
  if (raw === "" || raw === "/" || raw.startsWith("t=")) return { page: "dashboard" };
  const [path = "", query = ""] = raw.split("?", 2);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "runs":
      if (parts[1] && RUN_ID.test(parts[1])) {
        const f = q.get("finding");
        return f ? { page: "run", id: parts[1], finding: f } : { page: "run", id: parts[1] };
      }
      return { page: "runs" };
    case "compare": {
      const b = q.get("baseline") ?? "";
      const c = q.get("current") ?? "";
      if (RUN_ID.test(b) && RUN_ID.test(c)) return { page: "compare", baseline: b, current: c };
      return { page: "runs" };
    }
    case "findings":
      return { page: "findings" };
    case "new":
      return parts[1] ? { page: "new", engine: parts[1] } : { page: "new" };
    case "jobs":
      return parts[1] ? { page: "job", id: parts[1] } : { page: "dashboard" };
    case "settings":
      return { page: "settings" };
    default:
      return { page: "dashboard" };
  }
}

export function href(r: Route): string {
  switch (r.page) {
    case "dashboard":
      return "#/";
    case "runs":
      return "#/runs";
    case "run":
      return `#/runs/${r.id}${r.finding ? `?finding=${encodeURIComponent(r.finding)}` : ""}`;
    case "compare":
      return `#/compare?baseline=${r.baseline}&current=${r.current}`;
    case "findings":
      return "#/findings";
    case "new":
      return r.engine ? `#/new/${encodeURIComponent(r.engine)}` : "#/new";
    case "job":
      return `#/jobs/${encodeURIComponent(r.id)}`;
    case "settings":
      return "#/settings";
  }
}

/** Reads the session token from "#t=…" (first load) without keeping it in the visible URL. */
export function tokenFromHash(hash: string): string | null {
  return linkFromHash(hash)?.token ?? null;
}

/**
 * "#t=<token>" or "#t=<token>&r=/runs/<id>" (a deep link: the page to show once the token is stored).
 * Returns null for anything else.
 */
export function linkFromHash(hash: string): { token: string; route: string } | null {
  const m = /^#t=([A-Za-z0-9_-]{16,})(?:&r=(\/[A-Za-z0-9/_?=&.%-]*))?$/.exec(hash);
  if (!m?.[1]) return null;
  return { token: m[1], route: `#${m[2] ?? "/"}` };
}
