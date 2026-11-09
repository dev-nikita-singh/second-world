/** One run: verdict, findings (+ drawer), engine numbers, limitations, downloads, replay; and Compare. */
import { Fragment } from "preact";
import { useMemo, useState } from "preact/hooks";
import { ApiFailure, api, downloadReport } from "../api.js";
import { PageHead, useApp } from "../app.js";
import {
  Badge,
  Banner,
  Card,
  ClassBadge,
  CopyButton,
  Drawer,
  Empty,
  ExitBadge,
  Icon,
  LineChart,
  SeverityBadge,
  Skeleton,
  Stat,
  StatusBadge,
  Toast,
} from "../components.js";
import { navigate, useAsync } from "../hooks.js";
import {
  classificationHelp,
  engineTitle,
  fmtDateTime,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPct,
  isCustomLabel,
  plural,
  SEVERITIES,
} from "../lib/format.js";
import {
  countBySeverity,
  metricRows,
  parseReport,
  perfView,
  scalarFacts,
  stressView,
  type UiFinding,
  type UiResult,
} from "../lib/report.js";
import { href } from "../lib/route.js";

const FORMATS: Array<[string, string]> = [
  ["html", "HTML"],
  ["md", "Markdown"],
  ["json", "JSON"],
  ["sarif", "SARIF"],
  ["junit", "JUnit"],
];

function FindingDrawer({ f, runId, onClose }: { f: UiFinding; runId: string; onClose: () => void }) {
  const { running, setRunning } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const replay = async () => {
    try {
      const r = await api.replay(runId, f.fingerprint);
      setRunning(r.job);
      navigate(href({ page: "job", id: r.job.id }));
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : String(e));
    }
  };
  const notes = f.evidence.filter((e) => e.kind === "note").map((e) => String(e.text ?? ""));
  const measures = f.evidence.filter(
    (e) => e.kind === "measurement" || e.kind === "threshold" || e.kind === "comparison",
  );
  return (
    <Drawer
      title={f.title}
      onClose={onClose}
      subtitle={
        <div class="row wrap">
          <SeverityBadge severity={f.severity} />
          <ClassBadge classification={f.classification} />
          <Badge tone="neutral">{engineTitle(f.engine)}</Badge>
          {f.ruleId && <code class="muted">{f.ruleId}</code>}
        </div>
      }
    >
      {classificationHelp(f.classification) && (
        <p class="muted small">{classificationHelp(f.classification)}</p>
      )}
      {f.description && (
        <div>
          <div class="section-title">What happened</div>
          <p style={{ whiteSpace: "pre-wrap" }}>{f.description}</p>
        </div>
      )}
      {f.impact && (
        <div>
          <div class="section-title">Why it matters</div>
          <p>{f.impact}</p>
        </div>
      )}
      {f.recommendation && (
        <div>
          <div class="section-title">How to fix</div>
          <p style={{ whiteSpace: "pre-wrap" }}>{f.recommendation}</p>
        </div>
      )}
      {(f.locations.length > 0 || f.affected.length > 0) && (
        <div>
          <div class="section-title">Where</div>
          <ul class="stack-sm" style={{ margin: 0, paddingLeft: "18px" }}>
            {f.locations.map((l) => (
              <li key={`${l.file}:${l.line}`}>
                <code>
                  {l.file}:{l.line}
                </code>
                {l.symbol && <span class="muted"> · {l.symbol}</span>}
              </li>
            ))}
            {f.affected.map((a) => (
              <li key={a}>
                <code>{a}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {f.curl.length > 0 && (
        <div class="stack-sm">
          <div class="row">
            <div class="section-title grow" style={{ margin: 0 }}>
              Reproduce it yourself
            </div>
            <CopyButton text={f.curl.join("\n")} label="Copy all" />
          </div>
          <p class="muted small">
            Bash commands. Set <code>SW_AUTH_&lt;ROLE&gt;</code> to the full header value first (e.g.{" "}
            <code>export SW_AUTH_USER='Bearer …'</code>); credentials are never written into reports.
          </p>
          {f.curl.map((c) => (
            <pre key={c} class="code">
              {c}
            </pre>
          ))}
        </div>
      )}
      {f.reproduction && f.reproduction.steps.length > 0 && f.curl.length === 0 && (
        <div>
          <div class="section-title">Steps</div>
          <ol style={{ margin: 0, paddingLeft: "18px" }}>
            {f.reproduction.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {f.reproduction.command && <pre class="code">{f.reproduction.command}</pre>}
        </div>
      )}
      {measures.length > 0 && (
        <div>
          <div class="section-title">Evidence</div>
          <dl class="kv">
            {measures.map((e, i) => (
              <Fragment key={`m${i}`}>
                <dt>{String(e.metric ?? e.expression ?? e.kind)}</dt>
                <dd>
                  {e.kind === "measurement"
                    ? `${fmtNumber(e.value as number)} ${String(e.unit ?? "")}`
                    : e.kind === "threshold"
                      ? `${fmtNumber(e.actual as number)} (${e.passed ? "passed" : "failed"})`
                      : `${fmtPct(e.change as number)} change`}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <div class="section-title">Notes</div>
          {notes.map((n) => (
            <p key={n} class="small" style={{ whiteSpace: "pre-wrap" }}>
              {n}
            </p>
          ))}
        </div>
      )}
      <div>
        <div class="section-title">Identity</div>
        <dl class="kv small">
          <dt>Fingerprint</dt>
          <dd>
            <code>{f.fingerprint}</code>
          </dd>
          {f.confidence !== undefined && (
            <>
              <dt>Confidence</dt>
              <dd>{fmtPct(f.confidence)}</dd>
            </>
          )}
          {f.occurrences !== undefined && f.occurrences > 1 && (
            <>
              <dt>Occurrences</dt>
              <dd>{f.occurrences}</dd>
            </>
          )}
        </dl>
      </div>
      {f.engine === "bugs" && (
        <div class="stack-sm">
          <div class="section-title" style={{ margin: 0 }}>
            Check a fix
          </div>
          <p class="muted small">
            Replays this exact bug against the app. "Still reproduces" = not fixed yet.
          </p>
          <div>
            <button type="button" class="btn" disabled={running !== null} onClick={replay}>
              <Icon name="refresh" />
              {running ? "A test is running" : "Replay this bug"}
            </button>
          </div>
          {err && <Banner tone="bad">{err}</Banner>}
        </div>
      )}
    </Drawer>
  );
}

function PerfSection({ r }: { r: UiResult }) {
  const p = perfView(r.data);
  if (!p) return null;
  return (
    <>
      <div class="grid grid-4">
        <Stat label="Requests" value={fmtNumber(p.requests)} sub={`${fmtNumber(p.failed ?? 0)} failed`} />
        <Stat label="Throughput" value={`${fmtNumber(p.rps)}/s`} sub="requests per second" />
        <Stat label="p50 · p95" value={`${fmtMs(p.p50)}`} sub={`p95 ${fmtMs(p.p95)} · p99 ${fmtMs(p.p99)}`} />
        <Stat label="Error rate" value={fmtPct(p.errorRate)} sub={`max latency ${fmtMs(p.max)}`} />
      </div>
      {p.series.length > 1 && (
        <Card title="Response time over the run">
          <LineChart
            points={p.series.map((s) => ({ t: s.t, p50: s.p50, p95: s.p95 }))}
            series={[
              { key: "p50", label: "p50 (typical)", color: "var(--accent)" },
              { key: "p95", label: "p95 (slow end)", color: "var(--sev-medium)" },
            ]}
            unit="ms"
          />
        </Card>
      )}
      {p.thresholds.length > 0 && (
        <Card title="Pass rules (thresholds)" pad={false}>
          <table class="table table-compact">
            <tbody>
              {p.thresholds.map((t) => (
                <tr key={t.expression}>
                  <td style={{ width: "40px" }}>
                    <Badge tone={t.passed ? "ok" : "bad"}>{t.passed ? "pass" : "fail"}</Badge>
                  </td>
                  <td>
                    <code>{t.expression}</code>
                  </td>
                  <td class="num">
                    {t.actual === null
                      ? "no data"
                      : t.unit === "ms"
                        ? fmtMs(t.actual)
                        : t.unit === "ratio"
                          ? fmtPct(t.actual)
                          : fmtNumber(t.actual)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {p.endpoints.length > 0 && (
        <Card title="Per endpoint" pad={false}>
          <div class="table-wrap">
            <table class="table table-compact">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th class="num">Requests</th>
                  <th class="num">Req/s</th>
                  <th class="num">Errors</th>
                  <th class="num">p50</th>
                  <th class="num">p95</th>
                  <th class="num">p99</th>
                </tr>
              </thead>
              <tbody>
                {p.endpoints.map((e) => (
                  <tr key={e.key}>
                    <td>
                      <code>{e.key}</code>
                    </td>
                    <td class="num">{fmtNumber(e.requests)}</td>
                    <td class="num">{fmtNumber(e.rps)}</td>
                    <td class="num">{fmtPct(e.errorRate)}</td>
                    <td class="num">{fmtMs(e.p50)}</td>
                    <td class="num">{fmtMs(e.p95)}</td>
                    <td class="num">{fmtMs(e.p99)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function StressSection({ r }: { r: UiResult }) {
  const s = stressView(r.data);
  if (!s) return null;
  return (
    <>
      <Banner
        tone="info"
        title={
          s.testedCapacity !== null
            ? `Tested capacity: ${fmtNumber(s.testedCapacity)} ${s.loadType === "rate" ? "requests/s" : "users"}`
            : "No level met all requirements"
        }
      >
        {s.statement}
        {s.firstBreach && <div>First breach: {s.firstBreach}</div>}
      </Banner>
      <Card title="Levels" pad={false}>
        <div class="table-wrap">
          <table class="table table-compact">
            <thead>
              <tr>
                <th>Level</th>
                <th>Result</th>
                <th class="num">Throughput</th>
                <th class="num">Errors</th>
                <th class="num">p95</th>
                <th>Why it breached</th>
              </tr>
            </thead>
            <tbody>
              {s.stages.map((st) => (
                <tr key={st.label}>
                  <td class="nowrap">{st.label}</td>
                  <td>
                    <Badge
                      tone={
                        st.status === "ok" || st.status === "passed"
                          ? "ok"
                          : st.status === "breached"
                            ? "bad"
                            : "neutral"
                      }
                    >
                      {st.status}
                    </Badge>
                  </td>
                  <td class="num">{st.throughput !== undefined ? `${fmtNumber(st.throughput)}/s` : "–"}</td>
                  <td class="num">{fmtPct(st.errorRate)}</td>
                  <td class="num">{fmtMs(st.p95)}</td>
                  <td class="small muted">{st.breach.join("; ") || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function FactsSection({ r }: { r: UiResult }) {
  const facts = scalarFacts(r.data);
  if (facts.length === 0) return null;
  return (
    <Card title={`${engineTitle(r.engine)} details`}>
      <dl class="kv">
        {facts.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </Card>
  );
}

export function RunDetailPage({ id, finding }: { id: string; finding?: string }) {
  const { running } = useApp();
  const detail = useAsync(() => api.run(id), [id]);
  const [sev, setSev] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const report = useMemo(() => (detail.data ? parseReport(detail.data.report) : null), [detail.data]);

  if (detail.loading && !detail.data) return <Skeleton lines={8} />;
  if (detail.error || !detail.data || !report)
    return (
      <>
        <PageHead title="Run" back={{ to: "#/runs", label: "All runs" }} />
        <Banner tone="bad" title="Could not open this run">
          {detail.error?.message}
        </Banner>
      </>
    );

  const run = detail.data.run;
  const counts = countBySeverity(report.findings);
  const shown = sev ? report.findings.filter((f) => f.severity === sev) : report.findings;
  const open = finding
    ? report.findings.find((f) => f.fingerprint === finding || f.id === finding)
    : undefined;
  const invalidating = report.limitations.filter((l) => l.impact === "invalidates");
  const engines = run.engines.map(engineTitle).join(" + ");
  const again =
    run.engines[0] === "architecture"
      ? "inspect"
      : run.engines[0] === "performance"
        ? "perf"
        : run.engines[0];

  return (
    <>
      <PageHead
        back={{ to: "#/runs", label: "All runs" }}
        title={engines}
        subtitle={
          <span class="row wrap" style={{ gap: "8px" }}>
            <StatusBadge status={run.status} />
            <ExitBadge code={detail.data.exitCode} meaning={detail.data.exitMeaning} />
            <span>{detail.data.exitMeaning}</span>
            <span class="muted">· {fmtDateTime(run.createdAt)}</span>
            {report.durationMs !== undefined && (
              <span class="muted">· took {fmtDuration(report.durationMs)}</span>
            )}
            {isCustomLabel(run.label) && <Badge tone="accent">{run.label}</Badge>}
          </span>
        }
        actions={
          <>
            <a class={`btn${running ? " disabled" : ""}`} href={again ? `#/new/${again}` : "#/new"}>
              <Icon name="play" />
              Run again
            </a>
            <details class="advanced" style={{ position: "relative" }}>
              <summary class="btn" style={{ listStyle: "none" }}>
                <Icon name="download" />
                Download
              </summary>
              <div
                class="card"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "40px",
                  zIndex: 4,
                  padding: "6px",
                  minWidth: "160px",
                }}
              >
                {FORMATS.map(([fmt, label]) => (
                  <button
                    key={fmt}
                    type="button"
                    class="btn btn-ghost"
                    style={{ width: "100%", justifyContent: "flex-start" }}
                    onClick={() =>
                      downloadReport(id, fmt).then(
                        () => setToast(`${label} report downloaded`),
                        (e: unknown) => setToast((e as Error).message),
                      )
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </details>
            <CopyButton text={id} label="Copy run id" />
          </>
        }
      />

      {invalidating.length > 0 && (
        <Banner tone="warn" title="These results may not be valid">
          {invalidating.map((l) => (
            <div key={l.code}>
              {l.message} <code class="muted">{l.code}</code>
            </div>
          ))}
        </Banner>
      )}
      {report.verdict.reasons.length > 0 && (
        <Banner tone={report.verdict.passed ? "ok" : "warn"}>{report.verdict.reasons.join(" · ")}</Banner>
      )}

      {report.results.map((r) =>
        r.engine === "performance" ? (
          <PerfSection key={r.engine} r={r} />
        ) : r.engine === "stress" ? (
          <StressSection key={r.engine} r={r} />
        ) : null,
      )}

      <Card
        title={`Findings (${report.findings.length})`}
        pad={false}
        actions={
          report.findings.length > 0 && (
            <fieldset class="group chips">
              <legend class="sr-only">Filter by severity</legend>
              <button type="button" class="chip" aria-pressed={sev === ""} onClick={() => setSev("")}>
                All
              </button>
              {SEVERITIES.filter((s) => counts[s]).map((s) => (
                <button
                  key={s}
                  type="button"
                  class="chip"
                  aria-pressed={sev === s}
                  onClick={() => setSev(sev === s ? "" : s)}
                >
                  {s} · {counts[s]}
                </button>
              ))}
            </fieldset>
          )
        }
      >
        {report.findings.length === 0 ? (
          <Empty icon="check" title="No findings">
            {run.status === "passed"
              ? "Nothing at or above the reporting threshold was found."
              : "This run produced no findings."}
          </Empty>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Finding</th>
                  <th>How sure</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr
                    key={f.id}
                    class="clickable"
                    onClick={() => navigate(href({ page: "run", id, finding: f.fingerprint }))}
                  >
                    <td>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td class="title-cell">
                      <a
                        href={href({ page: "run", id, finding: f.fingerprint })}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.title}
                      </a>
                    </td>
                    <td>
                      <ClassBadge classification={f.classification} />
                    </td>
                    <td class="small">
                      <code>{f.where ?? "–"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {report.results
        .filter((r) => r.engine !== "performance" && r.engine !== "stress")
        .map((r) => (
          <FactsSection key={r.engine} r={r} />
        ))}

      {report.limitations.length > 0 && (
        <Card title={`What this run could not check (${report.limitations.length})`} pad={false}>
          <table class="table table-compact">
            <tbody>
              {report.limitations.map((l) => (
                <tr key={`${l.engine}-${l.code}-${l.message}`}>
                  <td style={{ width: "130px" }}>
                    <Badge
                      tone={
                        l.impact === "invalidates"
                          ? "bad"
                          : l.impact === "reduces-confidence"
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {l.impact === "invalidates"
                        ? "invalidates"
                        : l.impact === "reduces-confidence"
                          ? "less certain"
                          : "note"}
                    </Badge>
                  </td>
                  <td>{l.message}</td>
                  <td class="small muted nowrap">
                    <code>{l.code}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {open && <FindingDrawer f={open} runId={id} onClose={() => navigate(href({ page: "run", id }))} />}
      {finding && !open && <Banner tone="warn">That finding is not part of this run.</Banner>}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

export function Compare({ baseline, current }: { baseline: string; current: string }) {
  const cmp = useAsync(() => api.compare(baseline, current), [baseline, current]);
  const c = (cmp.data ?? {}) as {
    summary?: string;
    method?: string;
    regressions?: string[];
    findings?: Record<
      string,
      Array<{ fingerprint: string; title: string; severity: string; engine: string }>
    >;
  };
  const rows = metricRows(cmp.data);
  return (
    <>
      <PageHead
        back={{ to: "#/runs", label: "All runs" }}
        title="Compare two runs"
        subtitle={
          <>
            <a href={href({ page: "run", id: baseline })}>
              <code>{baseline.slice(0, 10)}…</code>
            </a>{" "}
            (before) →{" "}
            <a href={href({ page: "run", id: current })}>
              <code>{current.slice(0, 10)}…</code>
            </a>{" "}
            (after)
          </>
        }
      />
      {cmp.loading && !cmp.data && <Skeleton lines={5} />}
      {cmp.error && (
        <Banner tone="bad" title="Could not compare">
          {cmp.error.message}
        </Banner>
      )}
      {cmp.data !== null && (
        <>
          {c.summary && (
            <Banner
              tone={(c.regressions?.length ?? 0) > 0 ? "warn" : "info"}
              title={
                (c.regressions?.length ?? 0) > 0
                  ? `${plural(c.regressions?.length ?? 0, "regression")}`
                  : "No regressions"
              }
            >
              {c.summary}
              {c.method === "single-run" &&
                " One run per side: differences are shown, but no statistical claim is made (repeat runs for that)."}
            </Banner>
          )}
          {rows.length > 0 && (
            <Card title="Metrics" pad={false}>
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th class="num">Before</th>
                    <th class="num">After</th>
                    <th class="num">Change</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.metric}>
                      <td>
                        <code>{r.metric}</code>
                      </td>
                      <td class="num">{fmtNumber(r.baseline)}</td>
                      <td class="num">{fmtNumber(r.current)}</td>
                      <td class="num">
                        {r.change !== undefined ? `${r.change > 0 ? "+" : ""}${fmtPct(r.change)}` : "–"}
                      </td>
                      <td>
                        <Badge
                          tone={
                            r.verdict === "regressed" ? "bad" : r.verdict === "improved" ? "ok" : "neutral"
                          }
                        >
                          {r.verdict ?? "–"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <div class="grid grid-2">
            {(["new", "fixed", "regressed", "unchanged"] as const).map((k) => {
              const list = c.findings?.[k] ?? [];
              return (
                <Card
                  key={k}
                  title={`${k === "new" ? "New" : k === "fixed" ? "Fixed (gone)" : k === "regressed" ? "Got worse" : "Still there"} (${list.length})`}
                >
                  {list.length === 0 ? (
                    <p class="muted">None</p>
                  ) : (
                    <ul class="stack-sm" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                      {list.map((f) => (
                        <li key={f.fingerprint} class="row">
                          <SeverityBadge severity={f.severity} />
                          <span class="grow">{f.title}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
