/**
 * Builds a throw-away git repository with a tiny HTTP app (no dependencies) and candidate branches,
 * for Evolution tests. Layout:
 *   server.mjs  — GET /healthz, GET /work (waits `delay.json`.delayMs), PORT from env
 *   test.mjs    — the "test suite": exits 1 when `broken.flag` exists
 *   delay.json  — { "delayMs": 40 } on main
 * Branches: fix/fast (delayMs 0), fix/broken (delayMs 0 + broken.flag → tests fail), fix/slower (delayMs 80).
 * The user's working tree is left dirty on purpose (modified README.md + untracked notes.txt).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

const SERVER = `import http from "node:http";
import { readFileSync } from "node:fs";
const { delayMs } = JSON.parse(readFileSync(new URL("./delay.json", import.meta.url), "utf8"));
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.end("ok"); return; }
  const done = () => res.end("work");
  if (delayMs > 0) setTimeout(done, delayMs); else setImmediate(done);
});
server.listen(Number(process.env.PORT ?? 0), process.env.HOST ?? "127.0.0.1");
`;

const TEST = `import { existsSync } from "node:fs";
if (existsSync(new URL("./broken.flag", import.meta.url))) { console.error("1 test failed: work() returns wrong total"); process.exit(1); }
console.log("all tests passed");
`;

export interface TempRepo {
  dir: string;
  git(...args: string[]): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTempRepo(opts: { dirty?: boolean } = {}): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sw-repo-"));
  const git = async (...args: string[]) => {
    const r = await execa(
      "git",
      [
        "-c",
        "user.name=SW Test",
        "-c",
        "user.email=sw@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        windowsHide: true,
      },
    );
    return String(r.stdout).trim();
  };
  await git("init", "-q", "-b", "main");
  await git("config", "core.autocrlf", "false");
  await writeFile(path.join(dir, "server.mjs"), SERVER);
  await writeFile(path.join(dir, "test.mjs"), TEST);
  await writeFile(path.join(dir, "delay.json"), JSON.stringify({ delayMs: 40 }));
  await writeFile(path.join(dir, "README.md"), "# tiny app\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "baseline");

  const branch = async (name: string, files: Record<string, string>) => {
    await git("checkout", "-q", "-b", name, "main");
    for (const [f, c] of Object.entries(files)) await writeFile(path.join(dir, f), c);
    await git("add", "-A");
    await git("commit", "-q", "-m", name);
    await git("checkout", "-q", "main");
  };
  await branch("fix/fast", { "delay.json": JSON.stringify({ delayMs: 0 }) });
  await branch("fix/broken", { "delay.json": JSON.stringify({ delayMs: 0 }), "broken.flag": "x" });
  await branch("fix/slower", { "delay.json": JSON.stringify({ delayMs: 80 }) });

  if (opts.dirty !== false) {
    await writeFile(path.join(dir, "README.md"), "# tiny app\n\nlocal uncommitted edit\n");
    await writeFile(path.join(dir, "notes.txt"), "untracked user notes\n");
  }
  return {
    dir,
    git,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
