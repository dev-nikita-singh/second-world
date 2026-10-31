/**
 * Minimal HAR 1.2 validator: checks every field the spec marks as required, with types.
 * http://www.softwareishard.com/blog/har-12-spec/
 */
type J = Record<string, unknown>;

export function validateHar12(doc: unknown): string[] {
  const errs: string[] = [];
  const obj = (v: unknown, at: string): v is J => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return true;
    errs.push(`${at}: object required`);
    return false;
  };
  const arr = (v: unknown, at: string): v is unknown[] => {
    if (Array.isArray(v)) return true;
    errs.push(`${at}: array required`);
    return false;
  };
  const str = (o: J, k: string, at: string): void => {
    if (typeof o[k] !== "string") errs.push(`${at}.${k}: string required`);
  };
  const num = (o: J, k: string, at: string): void => {
    if (typeof o[k] !== "number" || !Number.isFinite(o[k] as number))
      errs.push(`${at}.${k}: number required`);
  };
  const nameValues = (v: unknown, at: string): void => {
    if (!arr(v, at)) return;
    v.forEach((x, i) => {
      if (obj(x, `${at}[${i}]`)) {
        str(x, "name", `${at}[${i}]`);
        str(x, "value", `${at}[${i}]`);
      }
    });
  };
  /** send/wait/receive required ≥ 0; blocked/dns/connect/ssl optional, ≥ 0 or -1; ssl ⊂ connect; sum ≈ time. */
  const timings = (t: J, time: unknown, at: string): void => {
    for (const k of ["send", "wait", "receive"]) {
      num(t, k, at);
      if (typeof t[k] === "number" && (t[k] as number) < 0) errs.push(`${at}.${k}: must be ≥ 0`);
    }
    for (const k of ["blocked", "dns", "connect", "ssl"]) {
      if (t[k] === undefined) continue;
      num(t, k, at);
      const v = t[k] as number;
      if (typeof v === "number" && v < 0 && v !== -1) errs.push(`${at}.${k}: must be ≥ 0 or -1`);
    }
    const ssl = typeof t.ssl === "number" ? t.ssl : -1;
    const connect = typeof t.connect === "number" ? t.connect : -1;
    if (ssl >= 0 && (connect < 0 || ssl > connect + 1e-6))
      errs.push(`${at}.ssl: must be included in connect`);
    if (typeof time !== "number") return;
    let sum = 0;
    for (const k of ["blocked", "dns", "connect", "send", "wait", "receive"]) {
      const v = t[k];
      if (typeof v === "number" && v >= 0) sum += v;
    }
    if (Math.abs(sum - time) > 0.01 + time * 0.001)
      errs.push(`${at}: timings sum ${sum} ≠ entry time ${time}`);
  };
  if (!obj(doc, "$")) return errs;
  const log = doc.log;
  if (!obj(log, "log")) return errs;
  if (log.version !== "1.2") errs.push("log.version: must be 1.2");
  if (obj(log.creator, "log.creator")) {
    str(log.creator, "name", "log.creator");
    str(log.creator, "version", "log.creator");
  }
  if (!arr(log.entries, "log.entries")) return errs;
  log.entries.forEach((e, i) => {
    const at = `log.entries[${i}]`;
    if (!obj(e, at)) return;
    str(e, "startedDateTime", at);
    if (typeof e.startedDateTime === "string" && Number.isNaN(Date.parse(e.startedDateTime)))
      errs.push(`${at}.startedDateTime: ISO 8601 required`);
    num(e, "time", at);
    if (obj(e.request, `${at}.request`)) {
      const r = e.request;
      for (const k of ["method", "url", "httpVersion"]) str(r, k, `${at}.request`);
      nameValues(r.cookies, `${at}.request.cookies`);
      nameValues(r.headers, `${at}.request.headers`);
      nameValues(r.queryString, `${at}.request.queryString`);
      num(r, "headersSize", `${at}.request`);
      num(r, "bodySize", `${at}.request`);
      if (r.postData !== undefined && obj(r.postData, `${at}.request.postData`)) {
        str(r.postData, "mimeType", `${at}.request.postData`);
        if (r.postData.params === undefined && r.postData.text === undefined)
          errs.push(`${at}.request.postData: params or text required`);
      }
    }
    if (obj(e.response, `${at}.response`)) {
      const r = e.response;
      num(r, "status", `${at}.response`);
      for (const k of ["statusText", "httpVersion", "redirectURL"]) str(r, k, `${at}.response`);
      nameValues(r.cookies, `${at}.response.cookies`);
      nameValues(r.headers, `${at}.response.headers`);
      if (obj(r.content, `${at}.response.content`)) {
        num(r.content, "size", `${at}.response.content`);
        str(r.content, "mimeType", `${at}.response.content`);
      }
      num(r, "headersSize", `${at}.response`);
      num(r, "bodySize", `${at}.response`);
    }
    obj(e.cache, `${at}.cache`);
    if (obj(e.timings, `${at}.timings`)) timings(e.timings, e.time, `${at}.timings`);
  });
  return errs;
}
