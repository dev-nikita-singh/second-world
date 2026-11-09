/** New test: pick a test type, fill the form (prefilled from the config), dry run or start. */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { EngineInfo, OptionSpec } from "../../shared/api-types.js";
import { ApiFailure, api } from "../api.js";
import { PageHead, useApp } from "../app.js";
import { Banner, Dialog, ENGINE_ICONS, Icon } from "../components.js";
import { navigate } from "../hooks.js";
import {
  confirmationText,
  type FormValue,
  type FormValues,
  formErrors,
  initialValues,
  neededConfirmations,
  toRequest,
} from "../lib/form.js";
import { href } from "../lib/route.js";

function Field({
  o,
  value,
  error,
  onChange,
}: {
  o: OptionSpec;
  value: FormValue | undefined;
  error?: string;
  onChange: (v: FormValue) => void;
}) {
  const id = `opt-${o.name}`;
  const help = (
    <span id={`${id}-help`} class="field-help">
      {o.help}
    </span>
  );
  if (o.kind === "boolean")
    return (
      <div class="field">
        <label class="check" for={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
            aria-describedby={`${id}-help`}
          />
          <span class="stack-sm" style={{ gap: "2px" }}>
            <span class="field-label">
              {o.label}
              {o.confirms && (
                <span class="badge badge-warn" style={{ marginLeft: "8px" }}>
                  needs confirmation
                </span>
              )}
            </span>
            {help}
          </span>
        </label>
      </div>
    );
  if (o.kind === "multi") {
    const list = Array.isArray(value) ? value : [];
    return (
      <fieldset class="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend class="field-label" style={{ marginBottom: "6px" }}>
          {o.label}
        </legend>
        <div class="chips">
          {(o.choices ?? []).map((c) => (
            <button
              key={c}
              type="button"
              class="chip"
              aria-pressed={list.includes(c)}
              onClick={() => onChange(list.includes(c) ? list.filter((x) => x !== c) : [...list, c])}
            >
              {c}
            </button>
          ))}
        </div>
        {help}
      </fieldset>
    );
  }
  return (
    <div class="field">
      <label class="field-label" for={id}>
        {o.label}
        {o.required && <span aria-hidden="true"> *</span>}
      </label>
      {o.kind === "enum" ? (
        <select
          id={id}
          class="select"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={`${id}-help`}
        >
          <option value="">{o.required ? "Choose…" : "Default (from config)"}</option>
          {(o.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {o.choiceLabels?.[c] ?? c}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          class="input"
          inputMode={o.kind === "number" ? "numeric" : undefined}
          placeholder={
            o.kind === "duration" ? "e.g. 20s" : o.kind === "number" ? "default from config" : "default"
          }
          value={typeof value === "string" ? value : ""}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={`${id}-help`}
        />
      )}
      {error ? <span class="field-error">{error}</span> : help}
    </div>
  );
}

function EngineForm({ engine }: { engine: EngineInfo }) {
  const { running, setRunning, targets } = useApp();
  const [values, setValues] = useState<FormValues>(() => initialValues(engine));
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<{
    needs: Array<"mutations" | "disruptive">;
    dryRun: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValues(initialValues(engine));
    setFailure(null);
    setTouched(false);
  }, [engine.id]);

  const errors = formErrors(engine, values, label);
  const valid = Object.keys(errors).length === 0;
  const basic = engine.options.filter((o) => !o.advanced);
  const advanced = engine.options.filter((o) => o.advanced);
  const targetName = typeof values.target === "string" && values.target ? values.target : undefined;
  const targetUrl =
    targets?.find((t) => t.name === targetName)?.url ?? targets?.find((t) => t.role !== "dependency")?.url;
  const down = targets?.filter((t) => t.health.checked && !t.health.ok && t.role !== "dependency") ?? [];

  const start = async (dryRun: boolean, confirmed: Array<"mutations" | "disruptive"> = []) => {
    setTouched(true);
    if (!valid) return;
    const needs = neededConfirmations(engine, values);
    if (!dryRun && needs.some((n) => !confirmed.includes(n))) {
      setConfirm({ needs, dryRun });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const confirmObj = Object.fromEntries(confirmed.map((n) => [n, true]));
      const r = await api.startJob(
        toRequest(engine, values, {
          dryRun,
          ...(label ? { label } : {}),
          ...(confirmed.length ? { confirm: confirmObj } : {}),
        }),
      );
      setRunning(r.job);
      navigate(href({ page: "job", id: r.job.id }));
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "CONFIRM_REQUIRED") setConfirm({ needs: e.needs, dryRun });
      else setFailure(e instanceof ApiFailure ? e : new ApiFailure(0, "ERROR", String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card" aria-labelledby="form-title">
      <div class="card-head">
        <span class="engine-icon">
          <Icon name={ENGINE_ICONS[engine.id] ?? "play"} />
        </span>
        <div class="grow">
          <h2 id="form-title">{engine.title}</h2>
          <p class="muted small">{engine.summary}</p>
        </div>
        <span class="badge badge-neutral nowrap">{engine.typicalDuration}</span>
      </div>
      <form
        class="card-body stack"
        onSubmit={(e) => {
          e.preventDefault();
          start(false);
        }}
      >
        {down.length > 0 && (
          <Banner tone="warn" title="The app looks down">
            {down.map((t) => `${t.name} (${t.url})`).join(", ")} did not answer the health check. Start it
            first, or the test will end with "target down" (exit 5).
          </Banner>
        )}
        {engine.needs.includes("disruptive") && (
          <Banner tone="info">
            This test injects failures on purpose. You'll be asked to confirm before it starts.
          </Banner>
        )}
        {basic.length === 0 && advanced.length === 0 && (
          <p class="muted">No options: it uses your config as it is.</p>
        )}
        <div class="grid grid-2">
          {basic.map((o) => (
            <Field
              key={o.name}
              o={o}
              value={values[o.name]}
              {...(touched && errors[o.name] ? { error: errors[o.name] } : {})}
              onChange={(v) => setValues((s) => ({ ...s, [o.name]: v }))}
            />
          ))}
        </div>
        <details class="advanced">
          <summary>Advanced options</summary>
          <div class="grid grid-2" style={{ marginTop: "12px" }}>
            {advanced.map((o) => (
              <Field
                key={o.name}
                o={o}
                value={values[o.name]}
                {...(touched && errors[o.name] ? { error: errors[o.name] } : {})}
                onChange={(v) => setValues((s) => ({ ...s, [o.name]: v }))}
              />
            ))}
            <div class="field">
              <label class="field-label" for="opt-label">
                History label
              </label>
              <input
                id="opt-label"
                class="input"
                value={label}
                placeholder="e.g. before-fix"
                onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              />
              {touched && errors.__label ? (
                <span class="field-error">{errors.__label}</span>
              ) : (
                <span class="field-help">A name to find this run later.</span>
              )}
            </div>
          </div>
        </details>
        {failure && (
          <Banner tone="bad" title={failure.message}>
            {failure.issues.length > 0 && (
              <ul style={{ margin: "4px 0 0", paddingLeft: "18px" }}>
                {failure.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <hr class="sep" />
        <div class="row wrap">
          <button
            type="submit"
            class="btn btn-primary"
            disabled={busy || running !== null || !engine.configured}
          >
            <Icon name="play" />
            {running ? "A test is running" : "Start test"}
          </button>
          <button
            type="button"
            class="btn"
            disabled={busy || running !== null || !engine.configured}
            onClick={() => start(true)}
          >
            Dry run
          </button>
          <span class="muted small">
            Dry run checks the config and safety rules and shows the plan, without sending anything.
          </span>
        </div>
      </form>
      {confirm && (
        <Dialog
          title="Confirm this test"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button type="button" class="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  start(c.dryRun, c.needs);
                }}
              >
                Yes, run it
              </button>
            </>
          }
        >
          {confirm.needs.map((n) => (
            <p key={n}>{confirmationText(n, targetUrl)}</p>
          ))}
          <p class="muted small">
            Your confirmation is recorded in the project's audit log, like --yes on the command line.
          </p>
        </Dialog>
      )}
    </section>
  );
}

export function NewTest({ engine }: { engine?: string }) {
  const { session, running } = useApp();
  const engines = session.engines;
  const selected = useMemo(() => engines.find((e) => e.id === engine) ?? null, [engines, engine]);
  return (
    <>
      <PageHead
        title="New test"
        subtitle="Pick what to test. Everything runs on your computer against your local app, with the same safety rules as the command line."
      />
      {running && (
        <Banner tone="info" title="A test is running">
          One test runs at a time. <a href={href({ page: "job", id: running.id })}>Watch it</a>.
        </Banner>
      )}
      <fieldset class="group grid grid-auto">
        <legend class="sr-only">Test types</legend>
        {engines.map((e) => (
          <button
            key={e.id}
            type="button"
            class="card engine-card"
            aria-pressed={selected?.id === e.id}
            disabled={!e.configured}
            title={e.notConfiguredReason}
            onClick={() => navigate(href({ page: "new", engine: e.id }))}
          >
            <div class="row">
              <span class="engine-icon">
                <Icon name={ENGINE_ICONS[e.id] ?? "play"} />
              </span>
              <h3 class="grow">{e.title}</h3>
              {e.needs.includes("disruptive") && <span class="badge badge-warn">disruptive</span>}
            </div>
            <p>{e.configured ? e.summary : e.notConfiguredReason}</p>
            <span class="muted small">{e.typicalDuration}</span>
          </button>
        ))}
      </fieldset>
      {selected && <EngineForm engine={selected} />}
    </>
  );
}
