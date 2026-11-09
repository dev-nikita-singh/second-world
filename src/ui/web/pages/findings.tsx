/** Findings across runs, grouped by fingerprint: open vs gone, first/last seen. */
import { useState } from "preact/hooks";
import { api } from "../api.js";
import { PageHead, useApp } from "../app.js";
import { Badge, Banner, ClassBadge, Empty, SeverityBadge, Skeleton } from "../components.js";
import { navigate, useAsync } from "../hooks.js";
import { engineTitle, fmtRelative, SEVERITIES } from "../lib/format.js";
import { href } from "../lib/route.js";

export function Findings() {
  const { running } = useApp();
  const data = useAsync(() => api.findings(), [running?.id]);
  const [show, setShow] = useState<"open" | "all">("open");
  const [sev, setSev] = useState("");
  const [engine, setEngine] = useState("");
  const [q, setQ] = useState("");

  const all = data.data?.findings ?? [];
  const engines = [...new Set(all.map((f) => f.engine))];
  const rows = all.filter(
    (f) =>
      (show === "all" || f.open) &&
      (!sev || f.severity === sev) &&
      (!engine || f.engine === engine) &&
      (!q ||
        f.title.toLowerCase().includes(q.toLowerCase()) ||
        (f.where ?? "").toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <>
      <PageHead
        title="Findings"
        subtitle={
          data.data
            ? `Problems found across your last ${data.data.scannedRuns} runs. "Open" = still reported by the latest run of that test type.`
            : "Problems found across your runs."
        }
      />
      <div class="row wrap">
        <fieldset class="group segmented">
          <legend class="sr-only">Which findings</legend>
          <button type="button" aria-pressed={show === "open"} onClick={() => setShow("open")}>
            Open
          </button>
          <button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")}>
            All
          </button>
        </fieldset>
        <label class="sr-only" for="f-search">
          Search findings
        </label>
        <input
          id="f-search"
          class="input search"
          type="search"
          placeholder="Search title or location"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <label class="sr-only" for="f-sev">
          Severity
        </label>
        <select
          id="f-sev"
          class="select"
          style={{ width: "auto" }}
          value={sev}
          onChange={(e) => setSev((e.target as HTMLSelectElement).value)}
        >
          <option value="">Any severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label class="sr-only" for="f-engine">
          Test type
        </label>
        <select
          id="f-engine"
          class="select"
          style={{ width: "auto" }}
          value={engine}
          onChange={(e) => setEngine((e.target as HTMLSelectElement).value)}
        >
          <option value="">All test types</option>
          {engines.map((e) => (
            <option key={e} value={e}>
              {engineTitle(e)}
            </option>
          ))}
        </select>
      </div>
      {data.error && (
        <Banner tone="bad" title="Could not load findings">
          {data.error.message}
        </Banner>
      )}
      <section class="card">
        {data.loading && !data.data ? (
          <div class="card-body">
            <Skeleton lines={6} />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon="check"
            title={
              all.length === 0
                ? "No findings yet"
                : show === "open"
                  ? "No open findings match"
                  : "No findings match"
            }
          >
            {all.length === 0 ? "Run a test; anything it finds shows up here." : null}
          </Empty>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Finding</th>
                  <th>State</th>
                  <th>Test</th>
                  <th class="num">Seen in</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr
                    key={f.fingerprint}
                    class="clickable"
                    onClick={() => navigate(href({ page: "run", id: f.lastRunId, finding: f.fingerprint }))}
                  >
                    <td>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td class="title-cell">
                      <div class="stack-sm" style={{ gap: "2px" }}>
                        <a
                          href={href({ page: "run", id: f.lastRunId, finding: f.fingerprint })}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {f.title}
                        </a>
                        {f.where && <code class="muted small">{f.where}</code>}
                      </div>
                    </td>
                    <td>
                      <span class="row">
                        <Badge tone={f.open ? "warn" : "ok"}>{f.open ? "open" : "gone"}</Badge>
                        <ClassBadge classification={f.classification} />
                      </span>
                    </td>
                    <td class="nowrap">{engineTitle(f.engine)}</td>
                    <td class="num">{f.runs}</td>
                    <td class="nowrap muted">{fmtRelative(f.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
