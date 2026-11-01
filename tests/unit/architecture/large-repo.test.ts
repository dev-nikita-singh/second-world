/**
 * Large, densely cross-importing project (found by sw-robust-w8, wave 8): TypeScript's createProgram
 * resolves imports recursively and overflowed the stack on ~2000 files that each import two others —
 * `sw inspect` exited 70 (RangeError). Now the program is rebuilt without module resolution and the
 * run reports ARCH_NO_RESOLVE (reduces-confidence). docs/03-engines/architecture-inspector.md §5.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const N = 2000;

function generate(dir: string): void {
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "big", version: "1.0.0", type: "module" }),
  );
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", strict: true },
      include: ["src"],
    }),
  );
  mkdirSync(path.join(dir, ".git"));
  const imp = (j: number) => `../mod${Math.floor(j / 50)}/f${j}.js`;
  for (let i = 0; i < N; i++) {
    const m = Math.floor(i / 50);
    const d = path.join(dir, "src", `mod${m}`);
    if (i % 50 === 0) mkdirSync(d, { recursive: true });
    const a = (i * 7 + 3) % N;
    const b = (i * 13 + 5) % N;
    const route =
      i % 10 === 0
        ? `import type { IncomingMessage, ServerResponse } from "node:http";\nexport async function h${i}(req: IncomingMessage, res: ServerResponse) { if (req.method === "GET" && req.url === "/items${i}") res.end(String(v${a}(1))); }\n`
        : "";
    writeFileSync(
      path.join(d, `f${i}.ts`),
      `import { v${a} } from "${imp(a)}";\nimport { v${b} } from "${imp(b)}";\n${route}export function v${i}(x: number): number { return x + ${i}; }\nexport const c${i} = () => v${a}(1) + v${b}(2);\n`,
    );
  }
}

describe("inspect on a large cross-importing project", () => {
  let tmp: TmpDir;
  let ucfg: TmpDir;
  beforeAll(async () => {
    tmp = await makeTmpDir("sw-arch-big-");
    ucfg = await makeTmpDir("sw-arch-big-ucfg-");
    generate(tmp.path);
  });
  afterAll(async () => {
    await tmp?.cleanup();
    await ucfg?.cleanup();
  });

  it(`${N} files: no crash (exit 0), every route found; a stack overflow degrades to ARCH_NO_RESOLVE`, async () => {
    const r = await runCli(["inspect", "--no-cache", "--no-history", "-f", "json", "-o", "out"], {
      cwd: tmp.path,
      env: { SW_USER_CONFIG_DIR: ucfg.path },
      timeoutMs: 180_000,
    });
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const rep = JSON.parse(readFileSync(path.join(tmp.path, "out", "report.json"), "utf8")) as {
      results: { data: { routes: unknown[] }; limitations: { code: string; impact: string }[] }[];
    };
    const res = rep.results[0];
    expect(res?.data.routes.length).toBe(N / 10);
    const nr = res?.limitations.find((l) => l.code === "ARCH_NO_RESOLVE");
    // Whether TypeScript overflows depends on the platform's stack size; when it does, it is reported.
    if (nr) expect(nr.impact).toBe("reduces-confidence");
    process.stderr.write(`[large-repo] ARCH_NO_RESOLVE: ${nr ? "yes" : "no"}\n`);
  }, 200_000);
});
