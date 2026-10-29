/**
 * Toxiproxy injector over its REST API (no client library). See docs/03-engines/reliability-lab.md §1.
 * API: GET /version, GET/POST /proxies, POST /proxies/{name}/toxics, DELETE /proxies/{name}/toxics/{toxic}.
 *
 * Fault → toxic: latency → latency{latency,jitter}; bandwidth → bandwidth{rate KB/s};
 * reset → reset_peer{timeout:0}; blackhole → timeout{timeout:0}; slow-body → slicer{average_size,delay µs}.
 * `percent` → toxicity. http-status is not supported (Toxiproxy is TCP-level): use the built-in proxy.
 * Toxic names are `sw-<id>` so `cleanupAll()` / the watchdog can remove leftovers.
 * A proxy this injector created (`create`) is deleted again by `close()`; until then a ledger entry
 * (`DELETE /proxies/<name>`) lets `sw reliability cleanup` remove it after a crash.
 * Note: with Toxiproxy in a container, `create.listen` must be "0.0.0.0:<published port>" and the upstream
 * an address reachable from the container (a container name on a shared network, or
 * host.docker.internal:<port> for a service on the host — Docker Desktop forwards it to host loopback).
 */
import { ledgerAdd, ledgerRemove } from "./cleanup.js";
import { type Action, ExternalInjectorBase, type ExternalInjectorOptions } from "./external.js";
import type { Fault, InjectorCapabilities } from "./types.js";

export interface ToxiproxyOptions extends ExternalInjectorOptions {
  /** Default http://127.0.0.1:8474 (or TOXIPROXY_URL). */
  apiUrl?: string;
  /** Proxy name inside Toxiproxy (the dependency). */
  proxy: string;
  /** If set, the proxy is created when missing: `listen` ("127.0.0.1:0") and `upstream` ("host:port"). */
  create?: { listen: string; upstream: string };
  /** Direction of toxics. Default "downstream". */
  stream?: "upstream" | "downstream";
  /** Capability probe timeout (ms). Default 1500. */
  probeTimeoutMs?: number;
  /** Delete a proxy this injector created on `close()`. Default true. */
  removeCreatedProxy?: boolean;
}

export interface ToxiproxyProxyInfo {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics?: { name: string; type: string }[];
}

export class ToxiproxyInjector extends ExternalInjectorBase {
  readonly name = "toxiproxy";
  readonly apiUrl: string;
  private readonly t: ToxiproxyOptions;
  private ensured = false;
  private created = false;

  constructor(opts: ToxiproxyOptions) {
    super(opts);
    this.t = opts;
    this.apiUrl = (opts.apiUrl ?? process.env.TOXIPROXY_URL ?? "http://127.0.0.1:8474").replace(/\/+$/, "");
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 5000,
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
        : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.req("GET", "/version", undefined, this.t.probeTimeoutMs ?? 1500);
      if (r.status !== 200) return null;
      return typeof r.json === "string" ? r.json : JSON.stringify(r.json);
    } catch {
      return null;
    }
  }

  async capabilities(): Promise<InjectorCapabilities> {
    const v = await this.version();
    return {
      injector: this.name,
      available: v !== null,
      ...(v === null ? { reason: `Toxiproxy API not reachable at ${this.apiUrl}` } : {}),
      faults: ["latency", "bandwidth", "reset", "blackhole", "slow-body"],
      partial: true,
      flapping: false,
      countsRequests: false,
    };
  }

  /** Returns the proxy (creating it if `create` was given). */
  async ensureProxy(): Promise<ToxiproxyProxyInfo> {
    const name = encodeURIComponent(this.t.proxy);
    let r = await this.req("GET", `/proxies/${name}`);
    if (r.status === 404 && this.t.create) {
      r = await this.req("POST", "/proxies", { name: this.t.proxy, ...this.t.create, enabled: true });
      if (r.status !== 201 && r.status !== 200 && r.status !== 409)
        throw new Error(
          `Toxiproxy: cannot create proxy (HTTP ${r.status}): ${typeof r.json === "string" ? r.json : JSON.stringify(r.json)}`,
        );
      if (r.status !== 409 && this.t.removeCreatedProxy !== false) {
        this.created = true;
        ledgerAdd(
          {
            id: this.proxyLedgerId(),
            injector: this.name,
            description: `toxiproxy proxy ${this.t.proxy} created by sw`,
            createdAt: new Date().toISOString(),
            expiresAt: Date.now(),
            pid: process.pid,
            actions: [{ kind: "http", method: "DELETE", url: this.proxyUrl() }],
          },
          this.opts.ledgerPath,
        );
      }
      r = await this.req("GET", `/proxies/${name}`);
    }
    if (r.status !== 200) throw new Error(`Toxiproxy: proxy "${this.t.proxy}" not found (HTTP ${r.status})`);
    this.ensured = true;
    return r.json as ToxiproxyProxyInfo;
  }

  toxicFor(
    fault: Fault,
    id: string,
  ): { name: string; type: string; stream: string; toxicity: number; attributes: Record<string, number> } {
    const base = {
      name: toxicName(id),
      stream: this.t.stream ?? "downstream",
      toxicity: fault.percent / 100,
    };
    switch (fault.type) {
      case "latency":
        return {
          ...base,
          type: "latency",
          attributes: { latency: Math.round(fault.latencyMs), jitter: Math.round(fault.jitterMs) },
        };
      case "bandwidth":
        return {
          ...base,
          type: "bandwidth",
          attributes: { rate: Math.max(1, Math.round(fault.bytesPerSecond / 1024)) },
        };
      case "reset":
        if (fault.when === "after-response")
          throw new Error(
            'toxiproxy cannot reset after the upstream responded (reset_peer acts on the connection, not per response); use the built-in proxy for when: "after-response"',
          );
        return { ...base, type: "reset_peer", attributes: { timeout: 0 } };
      case "blackhole":
        return { ...base, type: "timeout", attributes: { timeout: 0 } };
      case "slow-body":
        return {
          ...base,
          type: "slicer",
          attributes: {
            average_size: fault.chunkBytes,
            size_variation: 0,
            delay: Math.round(fault.delayMs * 1000),
          },
        };
      default:
        throw new Error(`toxiproxy does not support fault "${fault.type}"`);
    }
  }

  protected async applyActions(fault: Fault, id: string): Promise<Action[]> {
    if (!this.ensured) await this.ensureProxy();
    const toxic = this.toxicFor(fault, id);
    return [
      {
        kind: "http",
        method: "POST",
        url: `${this.apiUrl}/proxies/${encodeURIComponent(this.t.proxy)}/toxics`,
        body: toxic,
      },
    ];
  }

  protected revertActions(_fault: Fault, id: string): Action[] {
    return [
      {
        kind: "http",
        method: "DELETE",
        url: `${this.apiUrl}/proxies/${encodeURIComponent(this.t.proxy)}/toxics/${encodeURIComponent(toxicName(id))}`,
      },
    ];
  }

  private proxyUrl(): string {
    return `${this.apiUrl}/proxies/${encodeURIComponent(this.t.proxy)}`;
  }

  private proxyLedgerId(): string {
    return `sw-proxy-${process.pid}-${this.t.proxy}`;
  }

  /** Reverts every active fault, then deletes the proxy if this injector created it. */
  override async close(): Promise<void> {
    await super.close();
    if (!this.created) return;
    const res = await fetch(this.proxyUrl(), { method: "DELETE", signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    if (!res.ok && res.status !== 404) throw new Error(`Toxiproxy: cannot delete proxy (HTTP ${res.status})`);
    this.created = false;
    this.ensured = false;
    ledgerRemove(this.proxyLedgerId(), this.opts.ledgerPath);
  }

  /** Removes every `sw-` toxic from the proxy (leftovers of crashed runs). Returns the count removed. */
  async removeLeftovers(): Promise<number> {
    const r = await this.req("GET", `/proxies/${encodeURIComponent(this.t.proxy)}/toxics`);
    if (r.status !== 200 || !Array.isArray(r.json)) return 0;
    let n = 0;
    for (const t of r.json as { name?: string }[]) {
      if (typeof t.name === "string" && t.name.startsWith("sw-")) {
        await this.req(
          "DELETE",
          `/proxies/${encodeURIComponent(this.t.proxy)}/toxics/${encodeURIComponent(t.name)}`,
        );
        n++;
      }
    }
    return n;
  }
}

function toxicName(id: string): string {
  return id.startsWith("sw-") ? id : `sw-${id}`;
}

export function createToxiproxyInjector(opts: ToxiproxyOptions): ToxiproxyInjector {
  return new ToxiproxyInjector(opts);
}
