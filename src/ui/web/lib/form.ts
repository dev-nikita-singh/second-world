/**
 * "New test" form logic (no DOM): initial values from the option specs, client-side checks that mirror the
 * server's (the server re-checks everything), and the request body. Tested in tests/unit/ui/web/form.test.ts.
 */
import type { EngineInfo, JobRequest, OptionSpec } from "../../shared/api-types.js";

export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;

const DURATION_RE = /^\d{1,6}(\.\d{1,3})?(ms|s|m|h)$/;
const TEXT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:,/<>=%@+-]{0,127}$/;
export const LABEL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

export function initialValues(engine: EngineInfo): FormValues {
  const v: FormValues = {};
  for (const o of engine.options) {
    if (o.kind === "boolean") v[o.name] = o.default === true;
    else if (o.kind === "multi") v[o.name] = Array.isArray(o.default) ? [...o.default] : [];
    else if (o.default !== undefined && !Array.isArray(o.default)) v[o.name] = String(o.default);
    else if (o.kind === "enum" && o.required && o.choices?.length === 1) v[o.name] = o.choices[0] as string;
    else v[o.name] = "";
  }
  return v;
}

/** Problem with one value, in words; null when fine (empty = "use the config's default"). */
export function checkOption(o: OptionSpec, value: FormValue | undefined): string | null {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || value === false)
    return o.required ? "Required" : null;
  switch (o.kind) {
    case "number": {
      if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) return "Enter a number";
      const n = Number(value);
      if (o.min !== undefined && n < o.min) return `At least ${o.min}`;
      if (o.max !== undefined && n > o.max) return `At most ${o.max}`;
      return null;
    }
    case "duration":
      return typeof value === "string" && DURATION_RE.test(value.trim()) ? null : "Like 500ms, 20s or 2m";
    case "enum":
      return typeof value === "string" && (o.choices ?? []).includes(value)
        ? null
        : "Pick one of the options";
    case "text":
      return typeof value === "string" && TEXT_RE.test(value.trim())
        ? null
        : "Letters, digits and . , : / < > = % @ + - _ only, no spaces";
    default:
      return null;
  }
}

export function formErrors(engine: EngineInfo, values: FormValues, label = ""): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const o of engine.options) {
    const e = checkOption(o, values[o.name]);
    if (e) errors[o.name] = e;
  }
  if (label && !LABEL_RE.test(label)) errors.__label = "Letters, digits and . _ : - only";
  return errors;
}

/** Confirmations this request needs (engine-wide + options turned on). */
export function neededConfirmations(
  engine: EngineInfo,
  values: FormValues,
): Array<"mutations" | "disruptive"> {
  const s = new Set(engine.needs);
  for (const o of engine.options) if (o.confirms && values[o.name] === true) s.add(o.confirms);
  return [...s];
}

export function toRequest(
  engine: EngineInfo,
  values: FormValues,
  extra: { dryRun?: boolean; label?: string; confirm?: JobRequest["confirm"] } = {},
): JobRequest {
  const options: Record<string, unknown> = {};
  for (const o of engine.options) {
    const v = values[o.name];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (o.kind === "boolean") {
      if (v === true) options[o.name] = true;
    } else if (o.kind === "number") options[o.name] = Number(v);
    else if (o.kind === "multi") options[o.name] = v;
    else options[o.name] = typeof v === "string" ? v.trim() : v;
  }
  return {
    engine: engine.id,
    options,
    ...(extra.dryRun ? { dryRun: true } : {}),
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.confirm ? { confirm: extra.confirm } : {}),
  };
}

export function confirmationText(need: "mutations" | "disruptive", target: string | undefined): string {
  const where = target ? ` at ${target}` : "";
  return need === "disruptive"
    ? `This test breaks dependencies of the app${where} on purpose (errors, slowness, timeouts) for a few seconds. Only run it against an app you own, never production.`
    : `This test creates, changes and possibly deletes data in the app${where}. Use a test or local copy of the app.`;
}
