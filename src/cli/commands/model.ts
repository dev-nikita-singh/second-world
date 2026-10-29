/**
 * `sw model build|show|diff` — System Model. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/system-model.md; wiring per CONTRACTS.md "sw-model".
 * Snapshots: <cwd>/.second-world/model/model-<builtAt>-<hash>.json + latest.json (sw-model's
 * saveModelSnapshot). JSON output is always toCanonicalJson (the graph is non-enumerable).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError } from "../../core/errors.js";
import type { EngineResult } from "../../core/evidence/schemas.js";
import type { World } from "../../core/world.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, err, out, style, unicodeEnabled } from "../output.js";
import { installSignals, worldFromGlobals } from "../run-common.js";

type Obj = Record<string, unknown>;

/** Maps `sw model build` flags to a loose model input (history-derived inputs are added later). */
export function modelInputFromFlags(path: string | undefined, o: Obj, cwd: string): Obj {
  const input: Obj = {};
  if (path) input.project = path;
  if (o.openapi) input.openapi = resolve(cwd, String(o.openapi));
  const cfgFiles = o.configFile as string[] | undefined;
  if (cfgFiles?.length || o.discover === false) {
    input.config = {
      ...(cfgFiles?.length ? { files: cfgFiles.map((f) => resolve(cwd, f)) } : {}),
      ...(o.discover === false ? { discover: false } : {}),
    };
  }
  const traces = o.traces as string[] | undefined;
  if (traces?.length) input.traces = traces.map((t) => resolve(cwd, t));
  const prom = o.prometheus as string[] | undefined;
  if (prom?.length)
    input.prometheus = prom.map((p) => (/^https?:\/\//i.test(p) ? { url: p } : resolve(cwd, p)));
  if (o.serviceName) input.serviceName = o.serviceName;
  if (o.detail) input.detail = o.detail;
  if (o.cacheDir) input.cacheDir = resolve(cwd, String(o.cacheDir));
  if (o.architecture === false) input.architecture = false;
  else {
    const arch: Obj = {};
    if (o.cache === false) arch.noCache = true;
    if (o.cacheDir) arch.cacheDir = resolve(cwd, String(o.cacheDir));
    input.architecture = Object.keys(arch).length ? arch : true;
  }
  return input;
}

interface HistoryLike {
  list(o: {
    limit?: number;
    engine?: string;
  }): Promise<Array<{ id: string; engines: string[]; status: string }>>;
  get(id: string): Promise<{ results: EngineResult[] } | null>;
}

/** Latest non-cancelled result per engine from history (best effort). */
async function latestFromHistory(world: World, engines: string[]): Promise<Record<string, EngineResult>> {
  const out: Record<string, EngineResult> = {};
  try {
    const store = (await world.history.store()) as unknown as HistoryLike;
    for (const e of await store.list({ limit: 100 })) {
      if (e.status === "cancelled") continue;
      const want = e.engines.filter((x) => engines.includes(x) && !out[x]);
      if (want.length === 0) continue;
      const run = await store.get(e.id);
      for (const r of run?.results ?? []) if (want.includes(r.engine) && !out[r.engine]) out[r.engine] = r;
      if (engines.every((x) => out[x])) break;
    }
  } catch {
    // no history
  }
  return out;
}

function snapshotPath(world: World, ref: string): string {
  const p =
    ref === "latest"
      ? join(world.config.cwd, ".second-world", "model", "latest.json")
      : resolve(world.config.invocationCwd ?? world.config.cwd, ref);
  if (!existsSync(p)) {
    throw new ConfigError("SW_CONFIG_MODEL", `Model snapshot not found: ${p}`, {
      hint: "Run `sw model build` first, or pass a snapshot path",
    });
  }
  return p;
}

interface ModelDataLike {
  nodes: Array<{
    id: string;
    kind: string;
    confidence: number;
    evidence: Array<{ source: string }>;
    observed?: { p95Ms?: number; rps?: number; errorRate?: number };
    proposedMerge?: unknown;
  }>;
  edges: Array<{
    from: string;
    to: string;
    kind: string;
    confidence: number;
    observed?: { callsPerRequest?: number; p95Ms?: number };
  }>;
  coverage: { banner: string; bannerAscii?: string };
  traces?: { dominant?: Array<{ route: string; node: string; share: number }> };
  merges?: Array<{ node: string; proposed?: boolean; detail?: string }>;
}

function printModel(d: ModelDataLike, g: GlobalOptions): void {
  const s = style(colorEnabled(g));
  out(unicodeEnabled() ? d.coverage.banner : (d.coverage.bannerAscii ?? d.coverage.banner));
  out(s.bold(`\n${d.nodes.length} nodes, ${d.edges.length} edges`));
  for (const n of d.nodes.slice(0, 60)) {
    const sources = [...new Set(n.evidence.map((e) => e.source))].join(",");
    const obs = n.observed
      ? `  p95=${n.observed.p95Ms?.toFixed(1) ?? "-"}ms rps=${n.observed.rps?.toFixed(1) ?? "-"}`
      : "";
    out(
      `  ${n.id.padEnd(48)} ${n.kind.padEnd(10)} ${(n.confidence * 100).toFixed(0).padStart(3)}%  ${sources}${obs}${n.proposedMerge ? " ?" : ""}`,
    );
  }
  if (d.nodes.length > 60) out(s.dim(`  … ${d.nodes.length - 60} more (use --json)`));
  for (const dom of d.traces?.dominant ?? [])
    out(`${s.info} ${dom.route}: ${(dom.share * 100).toFixed(0)}% of latency in ${dom.node}`);
  for (const m of (d.merges ?? []).filter((x) => x.proposed))
    out(`${s.warn} to verify: merge ${m.node}${m.detail ? ` (${m.detail})` : ""}`);
}

export async function modelBuild(path: string | undefined, o: Obj, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  const removeSignals = installSignals(world, g, { reports: false });
  try {
    const m = await import("../../engines/model/index.js");
    const input = modelInputFromFlags(path, o, world.config.invocationCwd ?? world.config.cwd);
    const hist = await latestFromHistory(world, ["architecture", "performance", "reliability", "bugs"]);
    if (o.fromHistory === true && hist.architecture?.data && o.architecture !== false)
      input.architectureData = hist.architecture.data;
    if (o.fromHistory === true && hist.architecture?.data) delete input.architecture;
    if (hist.performance) input.performance = [hist.performance];
    if (hist.reliability) input.reliability = [hist.reliability];
    if (hist.bugs) input.findings = [hist.bugs];
    let receiver:
      | { url: string; spans(): unknown[]; metrics(): unknown[]; close(): Promise<void> }
      | undefined;
    const receiveS = o.receive !== undefined ? Number(o.receive) : undefined;
    if (receiveS !== undefined) {
      if (!(receiveS > 0))
        throw new ConfigError("SW_CONFIG_FLAG", "--receive needs a positive number of seconds");
      receiver = (await m.startOtlpReceiver({})) as unknown as typeof receiver;
      err(`OTEL_EXPORTER_OTLP_ENDPOINT=${receiver?.url}`);
      err(s.dim("accepts OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf (SDK default) or http/json"));
      err(s.dim(`receiving telemetry for ${receiveS}s (Ctrl+C to stop early)…`));
      await new Promise<void>((res) => {
        const t = setTimeout(res, receiveS * 1000);
        world.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            res();
          },
          { once: true },
        );
      });
      input.telemetry = { spans: receiver?.spans(), metrics: receiver?.metrics() };
      await receiver?.close();
    }
    if (g.dryRun) {
      out(
        JSON.stringify(
          world.redactor.redactObject({
            dryRun: true,
            input: m.parseModelInput(
              world.buildInput("model", {
                ...input,
                performance: undefined,
                reliability: undefined,
                findings: undefined,
              }),
            ),
          }),
          null,
          2,
        ),
      );
      process.exitCode = 0;
      return;
    }
    const result = await world.model.build(input);
    const data = result.data as Parameters<typeof m.saveModelSnapshot>[0];
    const snap = await m.saveModelSnapshot(data, { cwd: world.config.cwd });
    const fmt = o.graph as string | undefined;
    if (o.json || fmt === "json") out(m.toCanonicalJson(data));
    else if (fmt === "dot") out(m.modelToDot(data));
    else if (fmt === "mermaid") out(m.modelToMermaid(data));
    else printModel(data as unknown as ModelDataLike, g);
    if (!g.quiet) err(s.dim(`snapshot: ${snap.path}`));
    for (const l of result.limitations)
      if (l.impact !== "informational" && !g.quiet) err(s.dim(`limitation ${l.code}: ${l.message}`));
    if (o.history !== false) {
      try {
        const saved = await world.history.save([result], { label: g.label ?? "model" });
        if (saved && !g.quiet) err(s.dim(`history: saved run ${saved.id}`));
      } catch (e) {
        err(`${s.warn} history not saved: ${(e as Error).message}`);
      }
    }
    process.exitCode = result.status === "cancelled" ? 130 : 0;
  } finally {
    removeSignals();
    await world.close();
  }
}

export async function modelShow(ref: string | undefined, o: Obj, g: GlobalOptions): Promise<void> {
  const world = await worldFromGlobals(g);
  try {
    const m = await import("../../engines/model/index.js");
    const model = await m.loadModelSnapshot(snapshotPath(world, ref ?? "latest"));
    if (o.node) {
      const id = String(o.node);
      const k = o.k !== undefined ? Number(o.k) : 2;
      if (!model.graph.find(id))
        throw new ConfigError("SW_CONFIG_MODEL", `Unknown node "${id}"`, {
          hint: "Use an id like service:<name> or route:<svc>:GET /path (see `sw model show --json`)",
        });
      const view = {
        node: id,
        neighbourhood: model.graph.neighbourhood(id, k),
        impact: model.graph.impactOf(id),
        routesReaching: model.graph.routesReaching(id),
      };
      out(JSON.stringify(view, null, 2));
    } else if (o.graph === "dot") out(m.modelToDot(model));
    else if (o.graph === "mermaid") out(m.modelToMermaid(model));
    else if (o.graph === "json" || o.json) out(m.toCanonicalJson(model));
    else printModel(model as unknown as ModelDataLike, g);
    process.exitCode = 0;
  } finally {
    await world.close();
  }
}

export async function modelDiff(a: string, b: string, o: Obj, g: GlobalOptions): Promise<void> {
  const s = style(colorEnabled(g));
  const world = await worldFromGlobals(g);
  try {
    const m = await import("../../engines/model/index.js");
    const ma = await m.loadModelSnapshot(snapshotPath(world, a));
    const mb = await m.loadModelSnapshot(snapshotPath(world, b));
    const d = (await world.model.diff(ma, mb)) as ReturnType<typeof m.diffModels>;
    if (o.json) out(JSON.stringify(d, null, 2));
    else {
      out(
        `model diff: +${d.summary.added} −${d.summary.removed} ~${d.summary.changed} (=${d.summary.unchanged})`,
      );
      for (const n of d.addedNodes)
        out(`  ${s.green("+")} node ${typeof n === "string" ? n : (n as { id: string }).id}`);
      for (const n of d.removedNodes)
        out(`  ${s.red("-")} node ${typeof n === "string" ? n : (n as { id: string }).id}`);
      for (const e of d.addedEdges)
        out(`  ${s.green("+")} edge ${typeof e === "string" ? e : (e as { id: string }).id}`);
      for (const e of d.removedEdges)
        out(`  ${s.red("-")} edge ${typeof e === "string" ? e : (e as { id: string }).id}`);
      for (const c of d.changedConfidence)
        out(`  ~ ${c.id} confidence ${(c.before * 100).toFixed(0)}% → ${(c.after * 100).toFixed(0)}%`);
      for (const c of d.changedMetrics) out(`  ~ ${c.id} ${c.metric} ${c.before ?? "-"} → ${c.after ?? "-"}`);
    }
    process.exitCode = 0;
  } finally {
    await world.close();
  }
}
