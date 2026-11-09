/** App shell: sidebar navigation, top bar (project + target health + running test), page routing. */
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { RunJob, SessionInfo, TargetInfo } from "../shared/api-types.js";
import { api } from "./api.js";
import { Banner, Icon, type IconName, Spinner } from "./components.js";
import { useAsync, useInterval, useRoute } from "./hooks.js";
import { engineTitle } from "./lib/format.js";
import { href, type Route } from "./lib/route.js";
import { Dashboard } from "./pages/dashboard.js";
import { Findings } from "./pages/findings.js";
import { JobPage } from "./pages/job.js";
import { NewTest } from "./pages/new-test.js";
import { Compare, RunDetailPage } from "./pages/run-detail.js";
import { Runs } from "./pages/runs.js";
import { Settings } from "./pages/settings.js";

export interface AppState {
  session: SessionInfo;
  targets: TargetInfo[] | null;
  running: RunJob | null;
  refreshSession(): void;
  refreshTargets(): void;
  setRunning(j: RunJob | null): void;
}

export const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error("AppCtx missing");
  return v;
}

const NAV: Array<{ page: Route["page"]; label: string; icon: IconName; to: string }> = [
  { page: "dashboard", label: "Dashboard", icon: "dashboard", to: "#/" },
  { page: "new", label: "New test", icon: "play", to: "#/new" },
  { page: "runs", label: "Runs", icon: "runs", to: "#/runs" },
  { page: "findings", label: "Findings", icon: "findings", to: "#/findings" },
  { page: "settings", label: "Settings", icon: "settings", to: "#/settings" },
];

function activeNav(r: Route): Route["page"] {
  if (r.page === "run" || r.page === "compare") return "runs";
  if (r.page === "job") return "new";
  return r.page;
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "dashboard":
      return <Dashboard />;
    case "runs":
      return <Runs />;
    case "run":
      return <RunDetailPage id={route.id} {...(route.finding ? { finding: route.finding } : {})} />;
    case "compare":
      return <Compare baseline={route.baseline} current={route.current} />;
    case "findings":
      return <Findings />;
    case "new":
      return <NewTest {...(route.engine ? { engine: route.engine } : {})} />;
    case "job":
      return <JobPage id={route.id} />;
    case "settings":
      return <Settings />;
  }
}

function Brand() {
  return (
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <circle cx="12" cy="16" r="6" fill="none" stroke="var(--surface)" stroke-width="2.5" />
        <circle cx="20" cy="16" r="6" fill="none" stroke="var(--surface)" stroke-width="2.5" opacity=".7" />
      </svg>
      <div>
        <div class="brand-name">SECOND WORLD</div>
        <div class="brand-sub">testing lab</div>
      </div>
    </div>
  );
}

function TargetPills({ targets }: { targets: TargetInfo[] | null }) {
  if (!targets) return <Spinner label="Checking targets" />;
  if (targets.length === 0) return <span class="muted small">No targets in the config</span>;
  return (
    <ul class="row wrap plain-list" aria-label="Target health">
      {targets.map((t) => {
        const tone = !t.health.checked ? "" : t.health.ok ? "dot-ok" : "dot-bad";
        const words = !t.health.checked
          ? (t.health.error ?? "not checked")
          : t.health.ok
            ? `up · ${t.health.ms ?? "?"} ms`
            : (t.health.error ?? `HTTP ${t.health.status}`);
        return (
          <li key={t.name} class="badge badge-neutral" title={`${t.url} — ${words}`}>
            <span class={`dot ${tone}`} aria-hidden="true" />
            {t.name}
            <span class="sr-only"> {words}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function App() {
  const route = useRoute();
  const session = useAsync(() => api.session(), []);
  const targets = useAsync(() => api.targets(), []);
  const [running, setRunning] = useState<RunJob | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (session.data) setRunning(session.data.running);
  }, [session.data]);

  // Health of the targets and of the UI server itself, every 10 s.
  useInterval(() => {
    targets.reload();
    api.currentJob().then(
      (r) => {
        setOffline(false);
        setRunning(r.job && r.job.state !== "finished" ? r.job : null);
      },
      () => setOffline(true),
    );
  }, 10_000);

  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem("sw-ui-theme") ?? "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("sw-ui-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  if (session.loading && !session.data)
    return (
      <div class="empty" style={{ minHeight: "100vh", justifyContent: "center" }}>
        <Spinner />
        <span>Connecting to SECOND WORLD…</span>
      </div>
    );
  if (session.error || !session.data) {
    const unauth = session.error?.status === 401;
    return (
      <div class="content" style={{ maxWidth: "640px", margin: "64px auto" }}>
        <Banner tone="bad" title={unauth ? "This link has expired" : "Cannot reach SECOND WORLD"}>
          {unauth
            ? "Open the link that `sw ui` printed in your terminal (it contains a private key that changes every time `sw ui` starts)."
            : (session.error?.message ?? "Unknown error")}
        </Banner>
      </div>
    );
  }

  const state: AppState = {
    session: session.data,
    targets: targets.data?.targets ?? null,
    running,
    refreshSession: session.reload,
    refreshTargets: targets.reload,
    setRunning,
  };
  const active = activeNav(route);

  return (
    <AppCtx.Provider value={state}>
      <div class="shell">
        <nav class="sidebar" aria-label="Main">
          <Brand />
          {NAV.map((n) => (
            <a
              key={n.page}
              class="nav-link"
              href={n.to}
              aria-current={active === n.page ? "page" : undefined}
            >
              <Icon name={n.icon} />
              {n.label}
              {n.page === "new" && running && (
                <span class="nav-badge">
                  <Spinner label="A test is running" />
                </span>
              )}
            </a>
          ))}
          <div class="sidebar-foot">
            <fieldset class="group stack-sm" style={{ gap: "6px", marginBottom: "12px" }}>
              <legend style={{ marginBottom: "6px" }}>Theme</legend>
              <div class="segmented">
                {(["system", "light", "dark"] as const).map((t) => (
                  <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
                    {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
                  </button>
                ))}
              </div>
            </fieldset>
            v{session.data.version} · local only
          </div>
        </nav>
        <div class="main">
          <header class="topbar">
            <div class="grow row" style={{ minWidth: 0 }}>
              <span class="project-name">{session.data.project.name}</span>
              <span class="muted small nowrap" title={session.data.project.configPath ?? "no config file"}>
                {session.data.project.configPath ? "" : "· no sw.config found"}
              </span>
            </div>
            <TargetPills targets={state.targets} />
            {running && (
              <a class="btn btn-sm" href={href({ page: "job", id: running.id })}>
                <Spinner label="" />
                {engineTitle(running.engine)} running
              </a>
            )}
          </header>
          <main class="content" id="main">
            <div class="stack">
              {offline && (
                <Banner tone="bad" title="SECOND WORLD UI stopped">
                  The server is not answering. Start it again with <code>sw ui</code> and open the new link.
                </Banner>
              )}
              {session.data.warnings.length > 0 && <ConfigNotes notes={session.data.warnings} />}
              <Page route={route} />
            </div>
          </main>
        </div>
      </div>
    </AppCtx.Provider>
  );
}

/** Config warnings: one compact, expandable note instead of a banner each. */
function ConfigNotes({ notes }: { notes: string[] }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div class="banner banner-warn" role="status">
      <Icon name="alert" />
      <details class="grow">
        <summary style={{ cursor: "pointer" }}>
          <strong>{notes.length === 1 ? "1 note" : `${notes.length} notes`} about your config</strong>
          <span class="muted small"> · not errors; tests still run</span>
        </summary>
        <ul class="small" style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => setHidden(true)}>
        Hide
      </button>
    </div>
  );
}

export function PageHead({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
  back?: { to: string; label: string };
}) {
  return (
    <div class="page-head">
      <div class="grow stack-sm" style={{ gap: "4px" }}>
        {back && (
          <a href={back.to} class="small row" style={{ gap: "4px" }}>
            <span style={{ width: "14px", height: "14px", display: "inline-flex" }}>
              <Icon name="arrow-left" />
            </span>
            {back.label}
          </a>
        )}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div class="row wrap">{actions}</div>}
    </div>
  );
}
