/**
 * `sw ui` as a user starts it (docs/09 §1 "sw ui"): prints the link with its token, serves the built app,
 * answers the API; and the browser bundle stays small and offline (no external URLs, CSP-safe).
 */
import { readFileSync, statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUiAssets } from "../../../src/ui/web/build.js";
import { REPO_ROOT, spawnCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let out: TmpDir;
beforeAll(async () => {
  out = await makeTmpDir("sw-ui-assets-");
  await buildUiAssets(out.path);
}, 120_000);
afterAll(async () => {
  await out?.cleanup();
});

describe("UI bundle", () => {
  it("is small, self-contained and loads only its own files", () => {
    const js = readFileSync(out.join("app.js"), "utf8");
    expect(statSync(out.join("app.js")).size).toBeLessThan(150 * 1024);
    expect(js).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)/);
    expect(js).not.toMatch(/\beval\(|new Function\(/);
    const html = readFileSync(out.join("index.html"), "utf8");
    expect(html).toContain('<script type="module" src="app.js"></script>');
    expect(html).toContain('href="app.css"');
    // CSP forbids inline scripts and styles: none in the page.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|style="/);
    expect(statSync(out.join("app.css")).size).toBeGreaterThan(1000);
  });
});

describe("sw ui (CLI)", () => {
  it("prints a tokenised loopback link and serves the app and the API", async () => {
    const child = spawnCli(
      ["--config", "examples/shop-express/sw.config.ts", "ui", "--no-open", "--port", "0"],
      {
        cwd: REPO_ROOT,
        env: { SECOND_WORLD_UI_ASSETS: out.path },
        timeoutMs: 60_000,
      },
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const t = setTimeout(() => reject(new Error(`no link printed:\n${buf}`)), 45_000);
        child.stdout?.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = /SECOND WORLD UI → (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})/.exec(buf);
          if (m?.[1]) {
            clearTimeout(t);
            resolve(m[1]);
          }
        });
      });
      const [base, token] = url.split("#t=") as [string, string];
      const page = await fetch(base);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("app.js");
      expect((await fetch(`${base}app.js`)).status).toBe(200);
      const s = await fetch(`${base}api/session`, { headers: { Authorization: `Bearer ${token}` } });
      expect(s.status).toBe(200);
      expect(((await s.json()) as { project: { name: string } }).project.name).toBe("shop-express");
      expect((await fetch(`${base}api/session`)).status).toBe(401);
    } finally {
      child.kill();
      await child.catch(() => {});
    }
  }, 90_000);

  it("rejects a bad --port", async () => {
    const r = await spawnCli(["ui", "--no-open", "--port", "99999"], { cwd: REPO_ROOT, timeoutMs: 30_000 });
    expect(r.exitCode).toBe(2);
    expect(String(r.stderr)).toMatch(/--port/);
  }, 60_000);
});
