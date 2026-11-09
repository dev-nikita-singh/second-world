/** Runs: the history list with filters, paging and "compare two runs". */
import { useState } from "preact/hooks";
import type { RunSummary } from "../../shared/api-types.js";
import { api } from "../api.js";
import { PageHead, useApp } from "../app.js";
import { Banner, Empty, Icon, SeverityBadge, Skeleton, StatusBadge } from "../components.js";
import { useAsync } from "../hooks.js";
import { engineTitle, fmtDateTime, fmtMs, fmtRelative, isCustomLabel } from "../lib/format.js";
import { href } from "../lib/route.js";

const ENGINES = ["architecture", "bugs", "performance", "stress", "reliability", "agent", "whatif", "model"];
const STATUSES = ["passed", "failed", "partial", "error", "cancelled"];

export function Runs() {
  const { running } = useApp();
  const [engine, setEngine] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<RunSummary[][]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const first = useAsync(async () => {
    const r = await api.runs({ engine, status, search, limit: 50 });
    setPages([r.runs]);
    setNext(r.next);
    return r;
  }, [engine, status, search, running?.id]);
  const rows = pages.flat();

  const more = async () => {
    if (!next) return;
    const r = await api.runs({ engine, status, search, before: next, limit: 50 });
    setPages((p) => [...p, r.runs]);
    setNext(r.next);
  };
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  const [a, b] = selected;
  const compareHref =
    a && b
      ? (() => {
          const ra = rows.find((r) => r.id === a);
          const rb = rows.find((r) => r.id === b);
          const older = ra && rb && ra.createdAt <= rb.createdAt ? a : b;
          const newer = older === a ? b : a;
          return href({ page: "compare", baseline: older, current: newer });
        })()
      : null;

  return (
    <>
      <PageHead
        title="Runs"
        subtitle="Every test you ran, newest first. Tick two runs to compare them."
        actions={
          compareHref ? (
            <a class="btn btn-primary" href={compareHref}>
              <Icon name="compare" />
              Compare 2 runs
            </a>
          ) : (
            <a class="btn btn-primary" href="#/new">
              <Icon name="play" />
              New test
            </a>
          )
        }
      />
      <div class="row wrap">
        <label class="sr-only" for="runs-search">
          Search runs
        </label>
        <input
          id="runs-search"
          class="input search"
          type="search"
          placeholder="Search id or label"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        <label class="sr-only" for="runs-engine">
          Test type
        </label>
        <select
          id="runs-engine"
          class="select"
          style={{ width: "auto" }}
          value={engine}
          onChange={(e) => setEngine((e.target as HTMLSelectElement).value)}
        >
          <option value="">All test types</option>
          {ENGINES.map((e) => (
            <option key={e} value={e}>
              {engineTitle(e)}
            </option>
          ))}
        </select>
        <label class="sr-only" for="runs-status">
          Status
        </label>
        <select
          id="runs-status"
          class="select"
          style={{ width: "auto" }}
          value={status}
          onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {selected.length > 0 && (
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setSelected([])}>
            Clear selection ({selected.length})
          </button>
        )}
      </div>

      {first.error && (
        <Banner tone="bad" title="Could not load the runs">
          {first.error.message}
        </Banner>
      )}

      <section class="card">
        {first.loading && rows.length === 0 ? (
          <div class="card-body">
            <Skeleton lines={6} />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon="runs"
            title={engine || status || search ? "No runs match these filters" : "No runs yet"}
          >
            {engine || status || search ? (
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => {
                  setEngine("");
                  setStatus("");
                  setSearch("");
                }}
              >
                Clear filters
              </button>
            ) : (
              <a class="btn btn-sm btn-primary" href="#/new">
                Start your first test
              </a>
            )}
          </Empty>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th style={{ width: "36px" }}>
                    <span class="sr-only">Compare</span>
                  </th>
                  <th>When</th>
                  <th>Test</th>
                  <th>Status</th>
                  <th class="num">Findings</th>
                  <th class="num">p95</th>
                  <th>Run id</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    class="clickable"
                    onClick={() => (location.hash = href({ page: "run", id: r.id }))}
                  >
                    <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select run ${r.id} to compare`}
                        checked={selected.includes(r.id)}
                        disabled={r.compacted}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td class="nowrap" title={fmtDateTime(r.createdAt)}>
                      {fmtRelative(r.createdAt)}
                    </td>
                    <td>
                      <a href={href({ page: "run", id: r.id })} onClick={(e) => e.stopPropagation()}>
                        {r.engines.map(engineTitle).join(" + ")}
                      </a>
                      {isCustomLabel(r.label) && (
                        <span class="badge badge-accent" style={{ marginLeft: "8px" }}>
                          {r.label}
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td class="num">
                      {r.findings.total > 0 ? (
                        <span class="row" style={{ justifyContent: "flex-end" }}>
                          {r.findings.maxSeverity && <SeverityBadge severity={r.findings.maxSeverity} />}
                          {r.findings.total}
                        </span>
                      ) : (
                        <span class="muted">0</span>
                      )}
                    </td>
                    <td class="num">
                      {r.p95Ms !== undefined ? fmtMs(r.p95Ms) : <span class="muted">–</span>}
                    </td>
                    <td class="mono muted small">{r.id.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {next && (
        <div class="row" style={{ justifyContent: "center" }}>
          <button type="button" class="btn" onClick={more}>
            Load more
          </button>
        </div>
      )}
    </>
  );
}
