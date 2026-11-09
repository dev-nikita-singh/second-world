/** Shared UI building blocks. Icons are inline SVG (no icon font, no network). */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { classificationHelp, classificationLabel, exitTone, statusTone } from "./lib/format.js";

type IconName =
  | "dashboard"
  | "runs"
  | "findings"
  | "play"
  | "settings"
  | "search"
  | "check"
  | "x"
  | "alert"
  | "info"
  | "copy"
  | "download"
  | "stop"
  | "refresh"
  | "code"
  | "bug"
  | "gauge"
  | "trending"
  | "zap"
  | "target"
  | "flask"
  | "map"
  | "arrow-left"
  | "external"
  | "compare"
  | "sun"
  | "moon";

const PATHS: Record<IconName, string> = {
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  runs: "M4 6h16M4 12h16M4 18h10",
  findings: "M12 2 3 6v6c0 5 3.8 9.3 9 10 5.2-.7 9-5 9-10V6z M9 12l2 2 4-4",
  play: "M7 4v16l13-8z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4M12 8h.01",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  stop: "M6 6h12v12H6z",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  bug: "M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1 M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z M12 20v-9M6.5 13H3M21 13h-3.5M6 9 3.5 7M18 9l2.5-2M6 17l-2.5 2M18 17l2.5 2",
  gauge: "M12 14l4-4 M3.3 19a10 10 0 1 1 17.4 0",
  trending: "M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6",
  zap: "M13 2 3 14h9l-1 8 10-12h-9z",
  target:
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  flask: "M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3 M7 15h10",
  map: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4z M8 2v16M16 6v16",
  "arrow-left": "M19 12H5M12 19l-7-7 7-7",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  compare: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
};

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export const ENGINE_ICONS: Record<string, IconName> = {
  inspect: "code",
  architecture: "code",
  bugs: "bug",
  perf: "gauge",
  performance: "gauge",
  stress: "trending",
  reliability: "zap",
  agent: "target",
  whatif: "flask",
  model: "map",
  replay: "refresh",
};

export function Badge({ tone, children }: { tone: string; children: ComponentChildren }) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}

const SEV_ICON: Record<string, IconName> = {
  critical: "alert",
  high: "alert",
  medium: "info",
  low: "info",
  info: "info",
};

/** Severity: colour + icon + word (never colour alone). */
export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span class={`badge sev-${severity}`} title={`Severity: ${severity}`}>
      <Icon name={SEV_ICON[severity] ?? "info"} />
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const t = statusTone(status);
  return (
    <span class={`badge badge-${t.tone}`}>
      <Icon name={t.tone === "ok" ? "check" : t.tone === "bad" ? "alert" : "info"} />
      {t.label}
    </span>
  );
}

export function ExitBadge({ code, meaning }: { code: number | undefined; meaning?: string }) {
  const tone = exitTone(code);
  return (
    <span class={`badge badge-${tone}`} title={meaning}>
      exit {code ?? "?"}
    </span>
  );
}

export function ClassBadge({ classification }: { classification: string }) {
  return (
    <span class="badge badge-neutral" title={classificationHelp(classification)}>
      {classificationLabel(classification)}
    </span>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span class="spinner" role="status" aria-label={label} />;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div class="stack-sm" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} class="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Empty({
  icon = "info",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: "bad" | "warn" | "info" | "ok";
  title?: string;
  children?: ComponentChildren;
}) {
  const icon: IconName = tone === "ok" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div class={`banner banner-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon name={icon} />
      <div class="grow">
        {title && <strong>{title}</strong>}
        {children && <div class={title ? "small" : ""}>{children}</div>}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text stays selectable */
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} />
      {done ? "Copied" : label}
    </button>
  );
}

/** Focus-trapping overlay helper: Escape closes, focus returns to the opener. */
function useModal(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      el
        ? Array.from(
            el.querySelectorAll<HTMLElement>(
              "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
            ),
          ).filter((x) => !x.hasAttribute("disabled"))
        : [];
    (focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (f.length === 0) return;
        const first = f[0] as HTMLElement;
        const last = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);
  return ref;
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useModal(onClose);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse shortcut; keyboard users close with Escape (useModal) */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by useModal for the whole dialog */}
      <div class="overlay" onClick={onClose} />
      <div
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        ref={ref}
        tabIndex={-1}
      >
        <div class="drawer-head">
          <div class="grow stack-sm">
            <h2 id="drawer-title">{title}</h2>
            {subtitle}
          </div>
          <button type="button" class="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div class="drawer-body">{children}</div>
      </div>
    </>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  actions: ComponentChildren;
}) {
  const ref = useModal(onClose);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse shortcut; keyboard users close with Escape (useModal) */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by useModal for the whole dialog */}
      <div class="overlay" onClick={onClose} />
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={ref}
        tabIndex={-1}
      >
        <h2 id="dialog-title">{title}</h2>
        <div class="stack-sm">{children}</div>
        <div class="row" style={{ justifyContent: "flex-end" }}>
          {actions}
        </div>
      </div>
    </>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: ComponentChildren;
  sub?: ComponentChildren;
}) {
  return (
    <div class="card stat">
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value}</div>
      {sub && <div class="stat-sub">{sub}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  pad = true,
}: {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  pad?: boolean;
}) {
  return (
    <section class="card">
      {(title || actions) && (
        <div class="card-head">
          <h2 class="grow">{title}</h2>
          {actions}
        </div>
      )}
      {pad ? <div class="card-body">{children}</div> : children}
    </section>
  );
}

/** Small multi-series line chart (SVG, no library). Values must be ≥ 0. */
export function LineChart({
  points,
  series,
  unit,
}: {
  points: Array<Record<string, number | undefined>>;
  series: Array<{ key: string; label: string; color: string }>;
  unit: string;
}) {
  const W = 640;
  const H = 180;
  const P = { l: 44, r: 8, t: 10, b: 22 };
  const xs = points.map((p) => p.t ?? 0);
  const xMin = Math.min(...xs, 0);
  const xMax = Math.max(...xs, 1);
  let yMax = 0;
  for (const p of points) for (const s of series) yMax = Math.max(yMax, p[s.key] ?? 0);
  yMax = yMax <= 0 ? 1 : yMax * 1.1;
  const x = (v: number) => P.l + ((v - xMin) / (xMax - xMin || 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / yMax) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);
  const label = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(v >= 10 ? 0 : 1));
  return (
    <div class="stack-sm">
      <svg
        class="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Chart of ${series.map((s) => s.label).join(", ")} over time`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line class="grid-line" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} />
            <text class="axis-text" x={P.l - 6} y={y(t) + 4} text-anchor="end">
              {label(t)}
            </text>
          </g>
        ))}
        <text class="axis-text" x={P.l} y={H - 4}>
          {Math.round(xMin)} s
        </text>
        <text class="axis-text" x={W - P.r} y={H - 4} text-anchor="end">
          {Math.round(xMax)} s
        </text>
        {series.map((s) => {
          const pts = points
            .filter((p) => typeof p[s.key] === "number")
            .map((p) => `${x(p.t ?? 0).toFixed(1)},${y(p[s.key] as number).toFixed(1)}`);
          return pts.length > 1 ? (
            <polyline
              key={s.key}
              points={pts.join(" ")}
              fill="none"
              stroke={s.color}
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
          ) : null;
        })}
      </svg>
      <div class="legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span class="muted">({unit})</span>
      </div>
    </div>
  );
}

export function SeverityBar({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const order = ["critical", "high", "medium", "low", "info"];
  return (
    <div class="sev-bar" role="img" aria-label={order.map((s) => `${counts[s] ?? 0} ${s}`).join(", ")}>
      {order.map((s) =>
        counts[s] ? (
          <span
            key={s}
            style={{ width: `${((counts[s] ?? 0) / total) * 100}%`, background: `var(--sev-${s})` }}
          />
        ) : null,
      )}
    </div>
  );
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div class="toast" role="status" aria-live="polite">
      {text}
    </div>
  );
}

export type { IconName, JSX };
