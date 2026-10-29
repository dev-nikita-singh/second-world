import { describe, expect, it } from "vitest";
import { byRule, inspectFiles } from "./helpers.js";

/** Express app skeleton: one handler that calls `work()` from ./work.ts. */
const app = (handlerBody = "await work(); res.end();") => ({
  "src/app.ts": `
import express from "express";
import { work } from "./work.js";
const app = express();
app.get("/x", async (req, res) => { ${handlerBody} });
`,
});

describe("ARCH001 outbound HTTP without timeout", () => {
  it("positive / negative / suppression", async () => {
    const { result } = await inspectFiles({
      ...app(),
      "src/work.ts": `
export async function work() {
  await fetch("https://a.example.com/x");
  await fetch("https://a.example.com/y", { signal: AbortSignal.timeout(500) });
  // sw-ignore ARCH001 provider enforces its own deadline
  await fetch("https://a.example.com/z");
  await fetch("https://a.example.com/w"); // sw-ignore ARCH001 trailing form
}
`,
    });
    const f = byRule(result, "ARCH001");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "high",
      classification: "suspected-risk",
      engine: "architecture",
    });
    expect(f[0]?.locations[0]).toMatchObject({ file: "src/work.ts", line: 3, symbol: "work" });
    expect(f[0]?.evidence[0]).toMatchObject({ kind: "code", ruleId: "ARCH001" });
    expect(f[0]?.description).toContain("GET /x");
    expect(result.data?.suppressed.map((s) => s.line).sort()).toEqual([6, 7]);
    expect(result.data?.suppressed[0]?.reason).toMatch(/deadline|trailing/);
  });
});

describe("ARCH002 retry", () => {
  it("unbounded while(true) retry, no-backoff bounded retry, fixed delay, Infinity config; negative with capped + jittered backoff", async () => {
    const { result } = await inspectFiles({
      "src/r.ts": `
export async function unbounded() {
  while (true) {
    try { return await fetch("https://p.io", { signal: AbortSignal.timeout(1) }); } catch {}
  }
}
export async function noBackoff() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch("https://p.io", { signal: AbortSignal.timeout(1) }); } catch {}
  }
}
export async function fixed() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch("https://p.io", { signal: AbortSignal.timeout(1) }); } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
}
export async function good() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch("https://p.io", { signal: AbortSignal.timeout(1) }); } catch {}
    await new Promise((r) => setTimeout(r, Math.random() * 100 * 2 ** attempt));
  }
}
export async function boundedByIf() {
  let attempts = 0;
  while (true) {
    try { return await fetch("https://p.io", { signal: AbortSignal.timeout(1) }); } catch { if (++attempts >= 5) throw new Error("x"); }
    await sleep(2 ** attempts * 10 * Math.random());
  }
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
export const cfg = { retries: Infinity };
export const ok = { retries: 3 };
`,
    });
    const f = byRule(result, "ARCH002")
      .map((x) => `${x.locations[0]?.symbol}:${x.severity}`)
      .sort();
    expect(f).toEqual(["<module>:high", "fixed:medium", "noBackoff:high", "unbounded:high"]);
  });
});

describe("ARCH003 module cycle", () => {
  it("reports the SCC with a shortest example cycle; type-only imports do not count", async () => {
    const { result, data } = await inspectFiles({
      "src/a.ts": `import { b } from "./b.js";\nexport const a = () => b();`,
      "src/b.ts": `import { c } from "./c.js";\nexport const b = () => c();`,
      "src/c.ts": `import { a } from "./a.js";\nexport const c = () => a();`,
      "src/d.ts": `import type { E } from "./e.js";\nexport type D = number;`,
      "src/e.ts": `import type { D } from "./d.js";\nexport type E = D;`,
    });
    expect(data.cycles).toEqual([
      { members: ["src/a.ts", "src/b.ts", "src/c.ts"], example: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    ]);
    const f = byRule(result, "ARCH003");
    expect(f).toHaveLength(1);
    expect(f[0]?.locations[0]).toMatchObject({ file: "src/a.ts", line: 1 });
    expect(f[0]?.affected).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("file-level suppression", async () => {
    const { result } = await inspectFiles({
      "src/a.ts": `// sw-ignore-file ARCH003 known legacy cycle\nimport { b } from "./b.js";\nexport const a = () => b();`,
      "src/b.ts": `import { a } from "./a.js";\nexport const b = () => a();`,
    });
    expect(byRule(result, "ARCH003")).toHaveLength(0);
  });
});

describe("ARCH004 sync heavy work in handler", () => {
  it("flags *Sync reached from a handler, not at startup; supports namespace imports", async () => {
    const { result } = await inspectFiles({
      ...app(),
      "src/work.ts": `
import { pbkdf2Sync } from "node:crypto";
import * as fs from "fs";
export const config = fs.readFileSync("config.json", "utf8"); // startup: fine
export function work() {
  return pbkdf2Sync("p", "s", 1000, 32, "sha256");
}
export function unused() { return fs.readFileSync("x"); }
`,
    });
    const f = byRule(result, "ARCH004");
    expect(f.map((x) => x.locations[0]?.line)).toEqual([6]);
    expect(f[0]?.description).toContain("pbkdf2Sync");
  });

  it("suppression", async () => {
    const { result } = await inspectFiles({
      ...app(),
      "src/work.ts": `import { readFileSync } from "fs";\nexport function work() {\n  // sw-ignore ARCH004 tiny file, cached by OS\n  return readFileSync("x");\n}`,
    });
    expect(byRule(result, "ARCH004")).toHaveLength(0);
  });
});

describe("ARCH005 query in loop", () => {
  it("for-of / map callbacks with queries are flagged; batched query is not", async () => {
    const { result } = await inspectFiles({
      "src/q.ts": `
import { Pool } from "pg";
const pool = new Pool({ max: 5 });
export async function n1(ids: number[]) {
  for (const id of ids) await pool.query("SELECT * FROM t WHERE id = $1", [id]);
  await Promise.all(ids.map((id) => pool.query("SELECT 1")));
  for (const id of ids) {
    // sw-ignore ARCH005 bounded to 3 ids
    await pool.query("SELECT 2");
  }
}
export async function batched(ids: number[]) {
  const rows = await pool.query("SELECT * FROM t WHERE id = ANY($1)", [ids]);
  for (const r of rows.rows) console.log(r);
}
`,
    });
    expect(byRule(result, "ARCH005").map((f) => f.locations[0]?.line)).toEqual([5, 6]);
  });
});

describe("ARCH006 pool size", () => {
  it("pg Pool without max is flagged; with max is not", async () => {
    const { result } = await inspectFiles({
      "src/db.ts": `import { Pool } from "pg";\nexport const a = new Pool({ connectionString: "x" });\nexport const b = new Pool({ max: 20 });\nexport const c = new Pool();`,
    });
    expect(byRule(result, "ARCH006").map((f) => f.locations[0]?.line)).toEqual([2, 4]);
  });
});

describe("ARCH007 route missing auth", () => {
  it("flags the odd one out among authenticated siblings; respects router-level use and suppression", async () => {
    const { result } = await inspectFiles({
      "src/app.ts": `
import express from "express";
import { requireAuth } from "./auth.js";
const app = express();
app.get("/orders", requireAuth, (q, s) => s.end());
app.post("/orders", requireAuth, (q, s) => s.end());
app.delete("/orders/:id", (q, s) => s.end());
// sw-ignore ARCH007 public status endpoint
app.get("/orders/status", (q, s) => s.end());
app.get("/public", (q, s) => s.end());
app.get("/public/2", (q, s) => s.end());
`,
      "src/auth.ts": `export function requireAuth(q: any, s: any, n: any) { n(); }`,
    });
    const f = byRule(result, "ARCH007");
    expect(f.map((x) => x.locations[0]?.symbol)).toEqual(["DELETE /orders/:id"]);
    expect(f[0]?.severity).toBe("high");
  });

  it("handler-level auth call (fastify style) counts as auth", async () => {
    const { result } = await inspectFiles({
      "src/app.ts": `
import Fastify from "fastify";
const app = Fastify();
function authUser(req: unknown) { return req; }
app.get("/a/1", async (req) => { authUser(req); return 1; });
app.get("/a/2", async (req) => { authUser(req); return 1; });
app.get("/a/3", async (req) => 1);
`,
    });
    expect(byRule(result, "ARCH007").map((x) => x.locations[0]?.symbol)).toEqual(["GET /a/3"]);
  });
});

describe("ARCH008 fan-out", () => {
  it("handler reaching >= max external systems", async () => {
    const files = {
      "src/app.ts": `
import express from "express";
import Redis from "ioredis";
import { Pool } from "pg";
const app = express();
const redis = new Redis();
const pool = new Pool({ max: 1 });
app.get("/big", async (q, s) => {
  await redis.get("k");
  await pool.query("SELECT 1");
  await fetch("https://a.io", { signal: AbortSignal.timeout(1) });
  s.end();
});
app.get("/small", async (q, s) => { await redis.get("k"); s.end(); });
`,
    };
    const { result } = await inspectFiles(files); // default max = 4
    expect(byRule(result, "ARCH008")).toHaveLength(0);
    const { result: r2 } = await inspectFiles(files, { rules: { ARCH008: ["warn", { max: 3 }] } });
    expect(byRule(r2, "ARCH008").map((f) => f.locations[0]?.symbol)).toEqual(["GET /big"]);
  });
});

describe("ARCH009 unbounded module-level cache", () => {
  it("Map that only grows is flagged; evicting/size-checked ones are not", async () => {
    const { result } = await inspectFiles({
      "src/c.ts": `
const cache = new Map<string, string>();
const bounded = new Map<string, string>();
const seen: string[] = [];
export function put(k: string, v: string) {
  cache.set(k, v);
  if (bounded.size > 100) bounded.clear();
  bounded.set(k, v);
  seen.push(k);
  if (seen.length > 10) seen.shift();
}
`,
    });
    expect(byRule(result, "ARCH009").map((f) => f.locations[0]?.line)).toEqual([2]);
  });
});

describe("ARCH010 hard-coded secrets", () => {
  it("provider patterns and high-entropy secret-like names; placeholders and env are ignored; secret never leaks", async () => {
    const aws = ["AKIA", "IOSFODNN7EXAMPLQ"].join("");
    const { result } = await inspectFiles({
      "src/s.ts": `
export const awsKey = "${aws}";
export const config = { apiKey: "q8Zr3xK9vLm2Wp7Tn4Ys6Bd1Fh5Jc0Ge" };
const password = "changeme";
const token = process.env.TOKEN ?? "";
const tokenHeader = "authorization-header-name-x";
export const db = "postgres://admin:S3cretPassw0rd@db.internal:5432/app";
`,
    });
    const f = byRule(result, "ARCH010");
    expect(f.map((x) => x.locations[0]?.line)).toEqual([2, 3, 7]);
    const json = JSON.stringify(result.findings);
    expect(json).not.toContain(aws);
    expect(json).not.toContain("q8Zr3xK9vLm2Wp7Tn4Ys6Bd1Fh5Jc0Ge");
    expect(json).not.toContain("S3cretPassw0rd");
  });
});

describe("ARCH011 floating promise in handler", () => {
  it("unawaited async call in a handler is flagged; awaited/void/caught/returned are not", async () => {
    const { result } = await inspectFiles({
      "src/app.ts": `
import express from "express";
const app = express();
async function audit(x: string): Promise<void> {}
function sync(): number { return 1; }
app.post("/x", async (req, res) => {
  audit("a");
  await audit("b");
  void audit("c");
  audit("d").catch(() => {});
  sync();
  res.end();
});
async function background() { audit("not in handler"); }
`,
    });
    expect(byRule(result, "ARCH011").map((f) => f.locations[0]?.line)).toEqual([7]);
  });
});

describe("ARCH012 layer violations", () => {
  it("only active with a layer map", async () => {
    const files = {
      "src/routes/a.ts": `import { find } from "../repo/r.js";\nexport const a = () => find();`,
      "src/services/s.ts": `import { find } from "../repo/r.js";\nexport const s = () => find();`,
      "src/repo/r.ts": `export const find = () => 1;`,
    };
    const { result } = await inspectFiles(files);
    expect(byRule(result, "ARCH012")).toHaveLength(0);
    expect(result.limitations.some((l) => l.code === "ARCH012_NO_LAYERS")).toBe(true);
    const { result: r2 } = await inspectFiles(files, {
      rules: {
        ARCH012: [
          "warn",
          {
            layers: {
              controller: ["src/routes/**"],
              service: ["src/services/**"],
              repository: ["src/repo/**"],
            },
            allow: { controller: ["service"], service: ["repository"] },
          },
        ],
      },
    });
    expect(byRule(r2, "ARCH012").map((f) => f.locations[0]?.file)).toEqual(["src/routes/a.ts"]);
  });
});

describe("rule configuration", () => {
  it("off disables, error/warn set level tags and status, severity override", async () => {
    const files = { "src/w.ts": `export const f = () => fetch("https://x.io");` };
    const { result: off } = await inspectFiles(files, { rules: { ARCH001: "off" } });
    expect(byRule(off, "ARCH001")).toHaveLength(0);
    expect(off.status).toBe("passed");
    expect(off.data?.rules.ARCH001).toBe("off");
    const { result: err } = await inspectFiles(files);
    expect(err.status).toBe("failed");
    expect(byRule(err, "ARCH001")[0]?.tags).toContain("level:error");
    const { result: warn } = await inspectFiles(files, { rules: { ARCH001: ["warn", { severity: "low" }] } });
    expect(warn.status).toBe("passed");
    expect(byRule(warn, "ARCH001")[0]).toMatchObject({ severity: "low" });
    expect(byRule(warn, "ARCH001")[0]?.tags).toContain("level:warn");
  });
});
