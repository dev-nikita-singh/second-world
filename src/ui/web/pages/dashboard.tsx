/** Dashboard: health of the targets, open findings, latest run per test type, quick start. */
import { api } from "../api.js";
import { PageHead, useApp } from "../app.js";
import {
  Banner,
  Card,
  Empty,
  ENGINE_ICONS,
  Icon,
  SeverityBadge,
  SeverityBar,
  Skeleton,
  Stat,
  StatusBadge,
} from "../components.js";
import { useAsync } from "../hooks.js";
import { engineTitle, fmtMs, fmtRelative, SEVERITIES } from "../lib/format.js";
import { href } from "../lib/route.js";

export function Dashboard() {
  const { session, targets, running } = useApp();
  const runs = useAsync(() => api.runs({ limit: 100 }), [running?.id]);
  const findings = useAsync(() => api.findings(), [running?.id]);

  const open = (findings.data?.findings ?? []).filter((f) => f.open);
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of open) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const all = runs.data?.runs ?? [];
  const latestByEngine = new Map<string, (typeof all)[number]>();
  for (const r of all) for (const e of r.engines) if (!latestByEngine.has(e)) latestByEngine.set(e, r);
  const down = (targets ?? []).filter((t) => t.health.checked && !t.health.ok);
  const serious = (counts.critical ?? 0) + (counts.high ?? 0);

  return (
    <>
      <PageHead
        title="Dashboard"
        subtitle={
          session.project.configPath ? (
            <>
              Project config: <code>{session.project.configPath}</code>
            </>
          ) : (
            "No sw.config file found: tests use defaults. Run `sw init` in your project to create one."
          )
        }
        actions={
          <a class="btn btn-primary" href="#/new">
            <Icon name="play" />
            Start a test
          </a>
        }
      />

      {down.length > 0 && (
        <Banner
          tone="warn"
          title={`${down.map((t) => t.name).join(", ")} ${down.length === 1 ? "is" : "are"} not reachable`}
        >
          Start the app before running tests against it.{" "}
          {down.map((t) => `${t.name}: ${t.health.error ?? `HTTP ${t.health.status}`}`).join(" · ")}
        </Banner>
      )}

      <div class="grid grid-4">
        <Stat
          label="Open findings"
          value={findings.loading && !findings.data ? "…" : open.length}
          sub={
            serious > 0
              ? `${serious} critical or high`
              : open.length
                ? "none critical or high"
                : "nothing open"
          }
        />
        <Stat
          label="Runs recorded"
          value={runs.loading && !runs.data ? "…" : all.length >= 100 ? "100+" : all.length}
          sub={all[0] ? `last ${fmtRelative(all[0].createdAt)}` : "no runs yet"}
        />
        <Stat
          label="Targets up"
          value={
            targets
              ? `${targets.filter((t) => t.health.ok).length}/${targets.filter((t) => t.health.checked).length}`
              : "…"
          }
          sub="checked every 10 s"
        />
        <Stat
          label="Latest p95"
          value={fmtMs(all.find((r) => r.p95Ms !== undefined)?.p95Ms)}
          sub="slow-end response time of the last load test"
        />
      </div>

      <div class="grid grid-2">
        <Card
          title="Open findings by severity"
          actions={
            <a class="btn btn-sm" href="#/findings">
              View all
            </a>
          }
        >
          {findings.loading && !findings.data ? (
            <Skeleton />
          ) : open.length === 0 ? (
            <Empty icon="check" title="No open findings">
              Findings from your latest runs appear here.
            </Empty>
          ) : (
            <div class="stack">
              <SeverityBar counts={counts} />
              <div class="row wrap">
                {SEVERITIES.filter((s) => counts[s]).map((s) => (
                  <span key={s} class="row" style={{ gap: "6px" }}>
                    <SeverityBadge severity={s} />
                    <strong class="num">{counts[s]}</strong>
                  </span>
                ))}
              </div>
              <ul class="stack-sm" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {open.slice(0, 5).map((f) => (
                  <li key={f.fingerprint} class="row">
                    <SeverityBadge severity={f.severity} />
                    <a
                      class="grow"
                      href={href({ page: "run", id: f.lastRunId, finding: f.fingerprint })}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {f.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Latest run per test type"
          actions={
            <a class="btn btn-sm" href="#/runs">
              All runs
            </a>
          }
          pad={false}
        >
          {runs.loading && !runs.data ? (
            <div class="card-body">
              <Skeleton />
            </div>
          ) : latestByEngine.size === 0 ? (
            <Empty icon="runs" title="No runs yet">
              <span>Start your first test. Good first picks:</span>
              <div class="row wrap" style={{ justifyContent: "center", marginTop: "8px" }}>
                {["inspect", "bugs", "perf"].map((e) => (
                  <a key={e} class="btn btn-sm" href={`#/new/${e}`}>
                    {engineTitle(e)}
                  </a>
                ))}
              </div>
            </Empty>
          ) : (
            <table class="table table-compact">
              <tbody>
                {[...latestByEngine.entries()].map(([engine, r]) => (
                  <tr
                    key={engine}
                    class="clickable"
                    onClick={() => (location.hash = href({ page: "run", id: r.id }))}
                  >
                    <td>
                      <span class="row">
                        <span
                          style={{
                            width: "16px",
                            height: "16px",
                            display: "inline-flex",
                            color: "var(--text-3)",
                          }}
                        >
                          <Icon name={ENGINE_ICONS[engine] ?? "runs"} />
                        </span>
                        <a href={href({ page: "run", id: r.id })}>{engineTitle(engine)}</a>
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td class="num">{r.findings.total ? `${r.findings.total} findings` : "–"}</td>
                    <td class="num muted">{fmtRelative(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
