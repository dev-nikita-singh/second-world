/**
 * `sw history list|show|diff|baseline|trend|verify|prune`. See docs/09-cli-and-api.md §1 and
 * docs/03-engines/evidence-and-history.md. Store: src/engines/history (JSONL, hash-checked reports).
 * Exit codes: 0 ok; 1 when `diff` finds regressions or `verify` finds corruption; 2 unknown run / bad args.
 */
import { ExitCode, SecondWorldError } from "../../core/errors.js";
import type { HistoryStore } from "../../engines/history/index.js";
import type { GlobalOptions } from "../main.js";
import { colorEnabled, out, style, unicodeEnabled } from "../output.js";
import { worldFromGlobals } from "../run-common.js";
import { int } from "./perf.js";

type Store = HistoryStore;

async function withStore<T>(g: GlobalOptions, fn: (store: Store) => Promise<T>): Promise<T> {
  const world = await worldFromGlobals(g);
  try {
    const store = (await world.history.store()) as unknown as Store;
    return await fn(store);
  } catch (e) {
    if (e instanceof Error && e.name === "HistoryError") {
      const code = (e as Error & { code: string }).code;
      throw new SecondWorldError(code, e.message, ExitCode.ConfigInvalid, {
        hint: "`sw history list` shows run ids; ids may be abbreviated to a unique prefix (≥ 6 chars) or written as baseline:<name>",
      });
    }
    throw e;
  } finally {
    await world.close();
  }
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4);
}

/** Pads to width `n`, always leaving at least one space so long values never run into the next column. */
function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(1, n - s.length));
}

export async function historyList(o: { limit?: string; engine?: string; json?: boolean }, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const limit = int("limit", o.limit) ?? 20;
    const entries = await store.list({ limit, ...(o.engine ? { engine: o.engine as never } : {}) });
    if (o.json) out(JSON.stringify(entries, null, 2));
    else if (entries.length === 0) out("no runs recorded yet");
    else {
      out(`${pad("ID", 28)}${pad("CREATED", 26)}${pad("LABEL", 10)}${pad("STATUS", 10)}${pad("FINDINGS", 10)}P95(ms)`);
      for (const e of entries) {
        out(
          `${pad(e.id, 28)}${pad(e.createdAt, 26)}${pad(e.label ?? "", 10)}${pad(e.status, 10)}${pad(String(e.findings.count), 10)}${fmtNum(e.metrics["performance.http.p95"])}${e.compacted ? " (compacted)" : ""}`,
        );
      }
    }
    process.exitCode = 0;
  });
}

export async function historyShow(id: string, o: { json?: boolean }, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const run = await store.get(id);
    if (!run) throw new SecondWorldError("SW_HISTORY_NOT_FOUND", `No run "${id}" in history`, ExitCode.ConfigInvalid);
    if (o.json) out(JSON.stringify(run, null, 2));
    else {
      out(`run ${run.id}  ${run.createdAt}  ${run.label ?? ""}  status=${run.status}`);
      if (run.git) out(`git ${run.git.branch ?? ""} ${run.git.commit ?? ""}${run.git.dirty ? " (dirty)" : ""}`);
      out(`engines: ${run.engines.join(", ")}`);
      for (const [k, v] of Object.entries(run.metrics).sort()) out(`  ${pad(k, 40)} ${fmtNum(v)}`);
      const findings = run.results.flatMap((r) => r.findings);
      out(`findings: ${findings.length}`);
      for (const f of findings.slice(0, 50)) out(`  [${f.severity}] ${f.title}`);
    }
    process.exitCode = 0;
  });
}

export type RunSelector =
  | { kind: "ids"; ids: string[] }
  | { kind: "last"; n: number }
  | { kind: "label"; label: string; n?: number }
  | { kind: "baseline"; name: string };

/**
 * Parses one side of `sw history diff`:
 * `id[,id…]` (ids or unique prefixes) · `last:N` · `label:<name>[:N]` · `baseline:<name>`.
 */
export function parseRunSelector(raw: string): RunSelector {
  const s = raw.trim();
  if (s === "") throw new SecondWorldError("SW_CONFIG_FLAG", "Empty run selector", ExitCode.ConfigInvalid);
  const pos = (v: string, what: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      throw new SecondWorldError("SW_CONFIG_FLAG", `${what}: expected a positive integer, got "${v}"`, ExitCode.ConfigInvalid);
    }
    return n;
  };
  if (s.startsWith("last:")) return { kind: "last", n: pos(s.slice(5), `"${s}"`) };
  if (s.startsWith("label:")) {
    const rest = s.slice(6);
    const m = /^(.+):(\d+)$/.exec(rest);
    const label = m ? (m[1] as string) : rest;
    if (!label) throw new SecondWorldError("SW_CONFIG_FLAG", `"${s}": missing label`, ExitCode.ConfigInvalid);
    return m ? { kind: "label", label, n: pos(m[2] as string, `"${s}"`) } : { kind: "label", label };
  }
  if (s.startsWith("baseline:")) {
    const name = s.slice(9);
    if (!name) throw new SecondWorldError("SW_CONFIG_FLAG", `"${s}": missing baseline name`, ExitCode.ConfigInvalid);
    return { kind: "baseline", name };
  }
  const ids = s.split(",").map((x) => x.trim()).filter(Boolean);
  return { kind: "ids", ids };
}

/** Resolves a selector to what `store.diff` accepts (id list, or "baseline:<name>"). */
export async function resolveRunSelector(
  store: Pick<Store, "list">,
  sel: RunSelector,
  filter: { label?: string; engine?: string } = {},
): Promise<string | string[]> {
  switch (sel.kind) {
    case "ids":
      return sel.ids.length === 1 ? (sel.ids[0] as string) : sel.ids;
    case "baseline":
      return `baseline:${sel.name}`;
    case "last":
    case "label": {
      const label = sel.kind === "label" ? sel.label : filter.label;
      const limit = sel.n ?? 1000;
      const entries = await store.list({
        limit,
        ...(label ? { label } : {}),
        ...(filter.engine ? { engine: filter.engine as never } : {}),
      });
      const ids = entries.filter((e) => !e.compacted).map((e) => e.id);
      if (ids.length === 0) {
        throw new SecondWorldError(
          "SW_HISTORY_NOT_FOUND",
          `No runs match ${sel.kind === "label" ? `label "${sel.label}"` : `last:${sel.n}`}${filter.engine ? ` (engine ${filter.engine})` : ""}`,
          ExitCode.ConfigInvalid,
          { hint: "Save runs with --label <name> (e.g. `sw --label fast perf …`) and check `sw history list`" },
        );
      }
      return ids.length === 1 ? (ids[0] as string) : ids;
    }
  }
}

export async function historyDiff(
  a: string,
  b: string,
  o: { json?: boolean; engine?: string },
  g: GlobalOptions,
): Promise<void> {
  // Uses the global -f/--format (single value) for the comparison view.
  const fmt = (o.json ? "json" : (g.format?.trim() ?? "tty")) as "tty" | "json" | "md" | "html";
  if (!["tty", "json", "md", "html"].includes(fmt)) {
    throw new SecondWorldError("SW_CONFIG_FLAG", `history diff supports -f tty|json|md|html (got "${fmt}")`, ExitCode.ConfigInvalid);
  }
  const selA = parseRunSelector(a);
  const selB = parseRunSelector(b);
  await withStore(g, async (store) => {
    const filter = { ...(g.label ? { label: g.label } : {}), ...(o.engine ? { engine: o.engine } : {}) };
    const base = await resolveRunSelector(store, selA, filter);
    const cur = await resolveRunSelector(store, selB, filter);
    const cmp = await store.diff(base, cur);
    const { renderComparison } = await import("../../engines/reporting/index.js");
    out(renderComparison(cmp, fmt, { color: colorEnabled(g), ascii: !unicodeEnabled() }));
    process.exitCode = cmp.regressions.length > 0 ? 1 : 0;
  });
}

export async function historyBaselineSet(name: string, run: string, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const ref = await store.setBaseline(name, run);
    out(`baseline "${ref.name}" → ${ref.runId}`);
    process.exitCode = 0;
  });
}

export async function historyBaselineList(o: { json?: boolean }, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const refs = await store.listBaselines();
    if (o.json) out(JSON.stringify(refs, null, 2));
    else if (refs.length === 0) out("no baselines");
    else for (const r of refs) out(`${pad(r.name, 20)}${pad(r.runId, 28)}${r.setAt}`);
    process.exitCode = 0;
  });
}

export async function historyTrend(o: { metric?: string; endpoint?: string; limit?: string; json?: boolean }, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const limit = int("limit", o.limit);
    const t = await store.trend(o.metric ?? "p95", {
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      ...(limit ? { limit } : {}),
    });
    if (o.json) out(JSON.stringify(t, null, 2));
    else {
      out(`trend ${t.metric} (${t.method}), ${t.points.length} point(s)`);
      for (const p of t.points) {
        const flag = p.anomaly ? " ← anomaly" : p.changePoint ? ` ← change ${p.changePoint}` : "";
        out(`  ${pad(p.createdAt, 26)}${pad(p.runId, 28)}${pad(fmtNum(p.value), 12)}${flag}`);
      }
    }
    process.exitCode = 0;
  });
}

export async function historyVerify(o: { json?: boolean }, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const r = await store.verify();
    const s = style(colorEnabled(g));
    if (o.json) out(JSON.stringify(r, null, 2));
    else {
      out(`${r.ok ? s.ok : s.fail} history ${r.ok ? "intact" : "CORRUPTED"}: ${r.checked} run(s) checked, ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
      for (const e of r.errors) out(`  ${s.fail} ${JSON.stringify(e)}`);
      for (const w of r.warnings) out(`  ${s.warn} ${JSON.stringify(w)}`);
    }
    process.exitCode = r.ok ? 0 : 1;
  });
}

export async function historyPrune(o: { keep?: string; compact?: boolean; dryRun?: boolean; json?: boolean }, g: GlobalOptions): Promise<void> {
  await withStore(g, async (store) => {
    const keep = int("keep", o.keep);
    const r = await store.prune({
      ...(keep ? { keepLast: keep } : {}),
      compact: o.compact !== false,
      dryRun: o.dryRun === true || g.dryRun === true,
    });
    if (o.json) out(JSON.stringify(r, null, 2));
    else {
      out(`${r.dryRun ? "(dry run) " : ""}kept ${r.kept}, compacted ${r.compacted.length}, removed ${r.removed.length}`);
    }
    process.exitCode = 0;
  });
}
