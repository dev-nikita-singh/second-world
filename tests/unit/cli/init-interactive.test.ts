/**
 * `sw init` interactive path (docs/09-cli-and-api.md §1 `sw init`) without a real TTY: the real
 * @clack/prompts prompts read keystrokes from an injected stream (initCommand's InitIo seam).
 * Answers → generated sw.config.ts; Ctrl+C at any prompt → exit 130 and nothing written;
 * "No" at the final confirmation → exit 0, nothing written.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../../../src/cli/commands/init.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

const CTRL_C = "\x03";
const ENTER = "\r";
const ERASE = "\x7f".repeat(60);

/** Drives the prompts: waits until `prompt` is rendered (after the previous step), then types `keys`. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = "";
  let seen = 0;
  output.on("data", (c: Buffer) => {
    screen += c.toString("utf8");
  });
  const waitFor = async (text: string): Promise<void> => {
    const t0 = Date.now();
    for (;;) {
      const at = screen.indexOf(text, seen);
      if (at >= 0) {
        seen = at + text.length;
        return;
      }
      if (Date.now() - t0 > 10_000) throw new Error(`prompt "${text}" never rendered:\n${screen}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const script = async (steps: Array<[prompt: string, keys: string]>): Promise<void> => {
    for (const [prompt, keys] of steps) {
      await waitFor(prompt);
      await new Promise((r) => setTimeout(r, 20));
      input.write(keys);
    }
  };
  return { input, output, script, screen: () => screen };
}

describe("sw init: interactive prompts", () => {
  let dir: TmpDir;
  beforeEach(async () => {
    dir = await makeTmpDir("sw-init-tty-");
    writeFileSync(dir.join("package.json"), JSON.stringify({ name: "shop", scripts: { start: "node ." } }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await dir.cleanup();
  });

  const run = (t: ReturnType<typeof terminal>) =>
    initCommand({}, {}, { cwd: dir.path, interactive: true, input: t.input, output: t.output });

  it("answers are written into sw.config.ts (and .gitignore gets .second-world/)", async () => {
    const t = terminal();
    const done = run(t);
    await t.script([
      ["Target URL", `${ERASE}not a url${ENTER}`],
      ["Enter a full URL", `${ERASE}http://127.0.0.1:4321${ENTER}`],
      ["Health check path", `${ERASE}/ready${ENTER}`],
      ["Write sw.config.ts", ENTER],
    ]);
    await done;
    expect(process.exitCode).toBe(0);
    const cfg = readFileSync(dir.join("sw.config.ts"), "utf8");
    expect(cfg).toContain('"http://127.0.0.1:4321"');
    expect(cfg).toContain('"/ready"');
    expect(cfg).not.toContain("3000");
    expect(readFileSync(dir.join(".gitignore"), "utf8")).toContain(".second-world/");
    expect(t.screen()).toContain("Detected");
  }, 30_000);

  it("Enter at every prompt keeps the detected defaults", async () => {
    const t = terminal();
    const done = run(t);
    await t.script([
      ["Target URL", ENTER],
      ["Health check path", ENTER],
      ["Write sw.config.ts", ENTER],
    ]);
    await done;
    expect(process.exitCode).toBe(0);
    const cfg = readFileSync(dir.join("sw.config.ts"), "utf8");
    expect(cfg).toContain('"http://127.0.0.1:3000"');
    expect(cfg).toContain('"/healthz"');
  }, 30_000);

  it.each([
    ["the target URL prompt", [["Target URL", CTRL_C]]],
    [
      "the health path prompt",
      [
        ["Target URL", ENTER],
        ["Health check path", CTRL_C],
      ],
    ],
    [
      "the final confirmation",
      [
        ["Target URL", ENTER],
        ["Health check path", ENTER],
        ["Write sw.config.ts", CTRL_C],
      ],
    ],
  ] as Array<[string, Array<[string, string]>]>)(
    "Ctrl+C at %s → exit 130, nothing written",
    async (_n, steps) => {
      const t = terminal();
      const done = run(t);
      await t.script(steps);
      await done;
      expect(process.exitCode).toBe(130);
      expect(existsSync(dir.join("sw.config.ts"))).toBe(false);
      expect(existsSync(dir.join(".gitignore"))).toBe(false);
    },
    30_000,
  );

  it('"No" at the confirmation → exit 0, nothing written', async () => {
    const t = terminal();
    const done = run(t);
    await t.script([
      ["Target URL", ENTER],
      ["Health check path", ENTER],
      ["Write sw.config.ts", `n${ENTER}`],
    ]);
    await done;
    expect(process.exitCode).toBe(0);
    expect(existsSync(dir.join("sw.config.ts"))).toBe(false);
  }, 30_000);
});
