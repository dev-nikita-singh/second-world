/** A running (or just finished) test: live output, elapsed time, Stop, then a link to the run. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { JobLine, RunJob } from "../../shared/api-types.js";
import { api, streamJob } from "../api.js";
import { PageHead, useApp } from "../app.js";
import { Banner, ENGINE_ICONS, ExitBadge, Icon, Spinner } from "../components.js";
import { engineTitle, exitTone, fmtDuration } from "../lib/format.js";
import { href } from "../lib/route.js";

const MAX_RENDERED = 3000;

export function JobPage({ id }: { id: string }) {
  const { setRunning, refreshTargets } = useApp();
  const [job, setJob] = useState<RunJob | null>(null);
  const [lines, setLines] = useState<JobLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines([]);
    setJob(null);
    setError(null);
    const s = streamJob(id, {
      reset: () => setLines([]),
      line: (l) =>
        setLines((prev) =>
          prev.length >= MAX_RENDERED ? [...prev.slice(-MAX_RENDERED + 1), l] : [...prev, l],
        ),
      status: (j) => {
        setJob(j);
        if (j.state !== "finished") setRunning(j);
      },
      end: (j) => {
        setJob(j);
        setRunning(null);
        refreshTargets();
      },
      error: (m) => setError(m),
    });
    return () => s.close();
  }, [id]);

  useEffect(() => {
    if (!job || job.state === "finished") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job?.state]);

  useEffect(() => {
    const el = logRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const finished = job?.state === "finished";
  const elapsed = job
    ? (finished && job.endedAt ? Date.parse(job.endedAt) : now) - Date.parse(job.startedAt)
    : 0;
  const tone = finished ? exitTone(job?.exitCode) : "info";

  return (
    <>
      <PageHead
        back={{ to: "#/new", label: "New test" }}
        title={
          <span class="row">
            <span class="engine-icon">
              <Icon name={ENGINE_ICONS[job?.engine ?? ""] ?? "play"} />
            </span>
            {job ? `${engineTitle(job.engine)}${job.dryRun ? " (dry run)" : ""}` : "Test"}
          </span>
        }
        subtitle={job ? <code>{job.command}</code> : undefined}
        actions={
          job && !finished ? (
            <button
              type="button"
              class="btn btn-danger"
              onClick={() =>
                api.stopJob(job.id).then(
                  (r) => setJob(r.job),
                  () => {},
                )
              }
            >
              <Icon name="stop" />
              {job.state === "stopping" ? "Force stop" : "Stop"}
            </button>
          ) : job?.runId ? (
            <a class="btn btn-primary" href={href({ page: "run", id: job.runId })}>
              See the results
            </a>
          ) : (
            <a class="btn" href="#/new">
              New test
            </a>
          )
        }
      />
      {error && <Banner tone="bad">{error}</Banner>}
      <div aria-live="polite">
        {!job ? (
          <Banner tone="info">
            <span class="row">
              <Spinner /> Connecting…
            </span>
          </Banner>
        ) : !finished ? (
          <Banner tone="info" title={job.state === "stopping" ? "Stopping…" : "Running"}>
            {fmtDuration(elapsed)} elapsed.{" "}
            {job.state === "stopping"
              ? "Finishing gracefully (the partial result is kept). Press Force stop to end it now."
              : "You can leave this page; the test keeps running."}
          </Banner>
        ) : (
          <Banner tone={tone === "neutral" ? "info" : tone} title={job.exitMeaning ?? "Finished"}>
            <span class="row wrap">
              <ExitBadge code={job.exitCode} meaning={job.exitMeaning} />
              <span>took {fmtDuration(elapsed)}</span>
              {job.runId ? (
                <a href={href({ page: "run", id: job.runId })}>Open the findings and report →</a>
              ) : (
                <span class="muted">
                  {job.dryRun
                    ? "Dry run: nothing was sent and nothing was saved."
                    : job.engine === "replay"
                      ? "Replays are quick checks; they are not saved as runs."
                      : "No run was saved to history (see the output for why)."}
                </span>
              )}
            </span>
          </Banner>
        )}
      </div>
      <section class="card">
        <div class="card-head">
          <h2 class="grow">Output</h2>
          <label class="check small">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow((e.target as HTMLInputElement).checked)}
            />
            Follow
          </label>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1) */}
        <pre class="log" ref={logRef} role="log" tabIndex={0} aria-label="Test output">
          {lines.length === 0 ? (
            <span class="muted">{finished ? "(no output)" : "Waiting for output…"}</span>
          ) : (
            lines.map((l, i) => (
              <div key={i} class={l.stream === "stderr" ? "err" : undefined}>
                {l.text || " "}
              </div>
            ))
          )}
        </pre>
      </section>
    </>
  );
}
