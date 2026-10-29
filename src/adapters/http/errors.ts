/**
 * Classification of transport errors for the Performance Lab.
 * See docs/03-engines/performance-lab.md §4 (Errors group).
 */

export type TransportErrorKind =
  | "timeout"
  | "connect-timeout"
  | "econnrefused"
  | "econnreset"
  | "epipe"
  | "dns"
  | "safety"
  | "redirect-limit"
  | "socket"
  | "aborted"
  | "other";

export const TRANSPORT_ERROR_KINDS: readonly TransportErrorKind[] = [
  "timeout",
  "connect-timeout",
  "econnrefused",
  "econnreset",
  "epipe",
  "dns",
  "safety",
  "redirect-limit",
  "socket",
  "aborted",
  "other",
];

function codeOf(e: unknown): string | undefined {
  if (e !== null && typeof e === "object") {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function nameOf(e: unknown): string | undefined {
  if (e !== null && typeof e === "object") {
    const n = (e as { name?: unknown }).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}

/**
 * Maps an error thrown by undici (or node:net) to a stable kind.
 * `timedOut` / `cancelled` tell whether our own per-request timeout or the run signal fired,
 * because both surface as a generic AbortError.
 */
export function classifyError(
  e: unknown,
  flags: { timedOut?: boolean; cancelled?: boolean } = {},
): TransportErrorKind {
  if (flags.timedOut) return "timeout";
  // Walk the cause chain (bounded) - undici wraps socket errors.
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const code = codeOf(cur);
    // Safety Guard refusals (e.g. pinned DNS lookup blocking a host) are not network errors.
    if (code?.startsWith("SW_SAFETY_")) return "safety";
    switch (code) {
      case "UND_ERR_CONNECT_TIMEOUT":
        return "connect-timeout";
      case "UND_ERR_HEADERS_TIMEOUT":
      case "UND_ERR_BODY_TIMEOUT":
      case "ETIMEDOUT":
      case "ABORT_ERR_TIMEOUT":
        return "timeout";
      case "ECONNREFUSED":
        return "econnrefused";
      case "ECONNRESET":
        return "econnreset";
      case "EPIPE":
        return "epipe";
      case "ENOTFOUND":
      case "EAI_AGAIN":
      case "EAI_FAIL":
      case "EAI_NONAME":
        return "dns";
      default:
        break;
    }
    const name = nameOf(cur);
    if (name === "TimeoutError") return "timeout";
    cur = (cur as { cause?: unknown }).cause;
  }
  const code = codeOf(e);
  if (code === "UND_ERR_SOCKET" || code === "UND_ERR_CLOSED" || code === "UND_ERR_DESTROYED") {
    return flags.cancelled ? "aborted" : "socket";
  }
  if (flags.cancelled || code === "UND_ERR_ABORTED" || nameOf(e) === "AbortError") return "aborted";
  return "other";
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const code = codeOf(e);
    return code ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
}
