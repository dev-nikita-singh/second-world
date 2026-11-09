/**
 * Browser side of the UI API (contract: src/ui/shared/api-types.ts). The session token comes from the URL
 * fragment on first load, is kept in sessionStorage (this tab only) and sent as a Bearer header.
 */
import type {
  ApiError,
  FindingsPage,
  JobLine,
  JobRequest,
  RunDetail,
  RunJob,
  RunsPage,
  SessionInfo,
  TargetInfo,
} from "../shared/api-types.js";
import { linkFromHash } from "./lib/route.js";

const KEY = "sw-ui-token";

let token: string | null = null;

/** Takes the token from "#t=…" (and removes it from the address bar) or from this tab's storage. */
export function initToken(): string | null {
  const link = linkFromHash(location.hash);
  if (link) {
    token = link.token;
    try {
      sessionStorage.setItem(KEY, link.token);
    } catch {
      /* private mode: keep it in memory */
    }
    history.replaceState(null, "", `${location.pathname}${link.route}`);
    return token;
  }
  try {
    token = sessionStorage.getItem(KEY);
  } catch {
    token = null;
  }
  return token;
}

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly needs: Array<"mutations" | "disruptive"> = [],
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
  } catch {
    throw new ApiFailure(
      0,
      "OFFLINE",
      "The SECOND WORLD UI server is not reachable. Is `sw ui` still running?",
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as ApiError | null)?.error;
    throw new ApiFailure(
      res.status,
      e?.code ?? "HTTP",
      e?.message ?? `Request failed (${res.status})`,
      e?.needs ?? [],
      e?.issues ?? [],
    );
  }
  return json as T;
}

export const api = {
  session: () => call<SessionInfo>("GET", "/api/session"),
  targets: () => call<{ targets: TargetInfo[] }>("GET", "/api/targets"),
  runs: (q: { engine?: string; status?: string; search?: string; before?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return call<RunsPage>("GET", `/api/runs${s ? `?${s}` : ""}`);
  },
  run: (id: string) => call<RunDetail>("GET", `/api/runs/${encodeURIComponent(id)}`),
  compare: (baseline: string, current: string) =>
    call<unknown>(
      "GET",
      `/api/runs/diff?baseline=${encodeURIComponent(baseline)}&current=${encodeURIComponent(current)}`,
    ),
  findings: () => call<FindingsPage>("GET", "/api/findings"),
  config: () => call<{ path: string | null; config: unknown }>("GET", "/api/config"),
  doctor: () =>
    call<{ checks?: Array<{ status: string; label: string; fix?: string }> }>("GET", "/api/doctor"),
  currentJob: () => call<{ job: RunJob | null }>("GET", "/api/jobs/current"),
  startJob: (req: JobRequest) => call<{ job: RunJob }>("POST", "/api/jobs", req),
  stopJob: (id: string) => call<{ job: RunJob }>("POST", `/api/jobs/${encodeURIComponent(id)}/stop`),
  replay: (runId: string, fingerprint: string) =>
    call<{ job: RunJob }>("POST", `/api/runs/${encodeURIComponent(runId)}/replay`, { fingerprint }),
};

/** Downloads a report file (needs the token header, so not a plain link). */
export async function downloadReport(runId: string, fmt: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/report.${fmt}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiFailure(res.status, "DOWNLOAD", `Download failed (${res.status})`);
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `report.${fmt}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface JobStream {
  close(): void;
}

/** Live output of a job (SSE). Reconnects are handled by EventSource; the server replays buffered lines. */
export function streamJob(
  id: string,
  on: {
    line(l: JobLine): void;
    status(j: RunJob): void;
    end(j: RunJob): void;
    error(msg: string): void;
    reset(): void;
  },
): JobStream {
  const es = new EventSource(
    `/api/jobs/${encodeURIComponent(id)}/events?t=${encodeURIComponent(token ?? "")}`,
  );
  let ended = false;
  es.addEventListener("open", () => on.reset());
  es.addEventListener("line", (e) => on.line(JSON.parse((e as MessageEvent).data) as JobLine));
  es.addEventListener("status", (e) => on.status(JSON.parse((e as MessageEvent).data) as RunJob));
  es.addEventListener("end", (e) => {
    ended = true;
    on.end(JSON.parse((e as MessageEvent).data) as RunJob);
    es.close();
  });
  es.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (typeof data === "string") {
      ended = true;
      on.error((JSON.parse(data) as { message: string }).message);
      es.close();
    } else if (!ended && es.readyState === EventSource.CLOSED) {
      on.error("Lost the connection to the UI server.");
    }
  });
  return { close: () => es.close() };
}
