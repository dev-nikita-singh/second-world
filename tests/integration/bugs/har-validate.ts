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
    if (obj(e.timings, `${at}.timings`))
      for (const k of ["send", "wait", "receive"]) num(e.timings, k, `${at}.timings`);
  });
  return errs;
}
