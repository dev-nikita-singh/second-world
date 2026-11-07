/**
 * Executes the curl reproduction lines emitted by the Bug Hunter, without a shell:
 * POSIX-style word splitting (single/double quotes, `$VAR` expansion outside single quotes,
 * `VAR=$(… | node -e …)` captures are not supported here — reproductions with recorded values
 * never need them). Runs the real `curl` binary when it is on PATH, else replays via undici.
 */
import { execFile, execFileSync } from "node:child_process";
import { request } from "undici";

export function shellWords(line: string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  const expand = (): void => {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
    if (!m) {
      cur += "$";
      i++;
      return;
    }
    const name = m[1] as string;
    if (env[name] === undefined) throw new Error(`unset variable $${name}`);
    cur += env[name];
    i += m[0].length;
  };
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end);
      i = end + 1;
      has = true;
    } else if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          cur += line[i + 1];
          i += 2;
        } else if (line[i] === "$") expand();
        else cur += line[i++];
      }
      i++;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (ch === "$") {
      expand();
      has = true;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function curlOnPath(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["curl"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Parsed {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function parseCurl(argv: string[]): Parsed {
  if (argv[0] !== "curl") throw new Error(`not a curl command: ${argv.join(" ")}`);
  const p: Parsed = { method: "GET", url: "", headers: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-X") p.method = argv[++i] as string;
    else if (a === "-H") {
      const h = argv[++i] as string;
      const idx = h.indexOf(":");
      p.headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
    } else if (a === "--data-raw" || a === "--data" || a === "-d") p.body = argv[++i] as string;
    else if (a.startsWith("-")) continue;
    else p.url = a;
  }
  return p;
}

/** Runs one reproduction line; returns the HTTP status. */
export async function runCurlLine(
  line: string,
  env: Record<string, string | undefined>,
  useCurl: boolean,
): Promise<number> {
  const argv = shellWords(line, env);
  if (useCurl) {
    // Async: the server under test lives in this process (a sync spawn would deadlock it).
    const args = [
      ...argv.slice(1),
      "-o",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "-w",
      "%{http_code}",
    ];
    // One retry: on a busy Windows CI runner a curl process once hung long enough to time the test out.
    // The point of the test is that the reproduction line is correct, which one more attempt does not change.
    const once = () =>
      new Promise<string>((resolve, reject) => {
        execFile("curl", args, { shell: false, timeout: 10_000, encoding: "utf8" }, (err, out, errOut) =>
          err ? reject(new Error(`curl failed: ${err.message} ${errOut}`)) : resolve(out),
        );
      });
    const stdout = await once().catch(() => once());
    return Number(stdout.trim());
  }
  const p = parseCurl(argv);
  const res = await request(p.url, {
    method: p.method as "GET",
    headers: p.headers,
    ...(p.body === undefined ? {} : { body: p.body }),
  });
  await res.body.dump();
  return res.statusCode;
}
