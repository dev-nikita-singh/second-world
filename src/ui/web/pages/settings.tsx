/** Settings: project, config (masked, read-only), environment checks, about. */
import { api } from "../api.js";
import { PageHead, useApp } from "../app.js";
import { Badge, Banner, Card, CopyButton, Icon, Skeleton } from "../components.js";
import { useAsync } from "../hooks.js";

export function Settings() {
  const { session } = useApp();
  const config = useAsync(() => api.config(), []);
  const doctor = useAsync(() => api.doctor(), []);
  const json = config.data ? JSON.stringify(config.data.config, null, 2) : "";
  return (
    <>
      <PageHead
        title="Settings"
        subtitle="Your project and this computer. Change the config in your editor; the UI picks up edits automatically."
      />
      <div class="grid grid-2">
        <Card title="Project">
          <dl class="kv">
            <dt>Name</dt>
            <dd>{session.project.name}</dd>
            <dt>Folder</dt>
            <dd>
              <code>{session.project.root}</code>
            </dd>
            <dt>Config</dt>
            <dd>
              {session.project.configPath ? (
                <code>{session.project.configPath}</code>
              ) : (
                <span class="muted">none (defaults)</span>
              )}
            </dd>
            <dt>History</dt>
            <dd>
              {session.history.enabled ? "on" : "off"} · {session.history.backend} ·{" "}
              <code>{session.history.dir}</code>
            </dd>
            <dt>Version</dt>
            <dd>SECOND WORLD {session.version}</dd>
          </dl>
        </Card>
        <Card
          title="This computer"
          actions={
            <button type="button" class="btn btn-sm" onClick={doctor.reload}>
              <Icon name="refresh" />
              Re-check
            </button>
          }
          pad={false}
        >
          {doctor.loading && !doctor.data ? (
            <div class="card-body">
              <Skeleton lines={5} />
            </div>
          ) : doctor.error ? (
            <div class="card-body">
              <Banner tone="bad">{doctor.error.message}</Banner>
            </div>
          ) : (
            <table class="table table-compact">
              <tbody>
                {(doctor.data?.checks ?? []).map((c) => (
                  <tr key={c.label}>
                    <td style={{ width: "70px" }}>
                      <Badge
                        tone={
                          c.status === "ok"
                            ? "ok"
                            : c.status === "warn"
                              ? "warn"
                              : c.status === "fail"
                                ? "bad"
                                : "neutral"
                        }
                      >
                        {c.status}
                      </Badge>
                    </td>
                    <td>
                      {c.label}
                      {c.fix && <div class="muted small">{c.fix}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="Config (secrets masked)" actions={json && <CopyButton text={json} />}>
        {config.loading && !config.data ? (
          <Skeleton lines={8} />
        ) : config.error ? (
          <Banner tone="bad">{config.error.message}</Banner>
        ) : (
          <pre class="code" style={{ maxHeight: "480px" }}>
            {json}
          </pre>
        )}
      </Card>
      <Card title="About">
        <p>
          SECOND WORLD is a deterministic testing lab: no AI, no cloud. This UI runs only on your computer
          (127.0.0.1); each test is the same <code>sw</code> command you could type, with the same safety
          rules.
        </p>
      </Card>
    </>
  );
}
