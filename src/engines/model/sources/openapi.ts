/**
 * OpenAPI → observations (confidence 0.8, docs/03-engines/system-model.md §1). Reuses the Bug Hunter's
 * contract loader (swagger-parser bundle; OpenAPI 3.0/3.1, Swagger 2 best-effort).
 * The contract is assumed to describe the primary (project) service; `servers[].url` gives its host:port.
 */
import { indexContract, loadContract } from "../../bugs/contract.js";
import { DEFAULT_CONFIDENCE } from "../confidence.js";
import type { ModelEvidence } from "../types.js";
import { emptySet, normRoutePath, type ObservationSet, PRIMARY_KEY, urlIdentity } from "./observation.js";

export async function fromOpenApi(
  source: string | Record<string, unknown>,
  cwd: string,
): Promise<ObservationSet> {
  const contract =
    typeof source === "string"
      ? await loadContract(source, cwd)
      : indexContract(structuredClone(source), "(inline)");
  const set = emptySet();
  set.coverage.openapi = true;
  const origin = typeof source === "string" ? source.replace(/\\/g, "/") : "(inline openapi)";
  const ev = (detail: string): ModelEvidence => ({
    source: "openapi",
    confidence: DEFAULT_CONFIDENCE.openapi,
    origin,
    detail,
  });
  const doc = contract.document;
  const servers = Array.isArray(doc.servers) ? (doc.servers as { url?: unknown }[]) : [];
  const hosts: string[] = [];
  const hostnames: string[] = [];
  const prefixes = new Set<string>();
  for (const s of servers) {
    if (typeof s?.url !== "string") continue;
    const id = urlIdentity(s.url);
    if (id?.hostPort) hosts.push(id.hostPort);
    if (id?.hostname) hostnames.push(id.hostname);
    let p = "";
    try {
      p = new URL(s.url).pathname;
    } catch {
      p = s.url.startsWith("/") ? s.url : "";
    }
    prefixes.add(p.replace(/\/+$/, ""));
  }
  const prefix = prefixes.size === 1 ? ([...prefixes][0] as string) : "";
  const title = typeof contract.title === "string" ? contract.title : undefined;
  set.nodes.push({
    key: PRIMARY_KEY,
    kind: "service",
    name: title ?? "app",
    evidence: [
      ev(
        `OpenAPI ${contract.version}${title ? ` "${title}"` : ""}, ${contract.operations.length} operations`,
      ),
    ],
    ...(hosts.length ? { hosts } : {}),
    ...(hostnames.length ? { serviceNames: hostnames } : {}),
    fuzzy: false,
  });
  for (const op of contract.operations) {
    const path = normRoutePath(prefix + op.path);
    set.nodes.push({
      key: `openapi:${op.method} ${path}`,
      kind: "route",
      name: `${op.method} ${path}`,
      route: { method: op.method, path, serviceKey: PRIMARY_KEY },
      evidence: [ev(`operation ${op.operationId ?? op.key}${op.summary ? `: ${op.summary}` : ""}`)],
      fuzzy: false,
    });
  }
  return set;
}
