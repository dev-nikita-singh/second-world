/**
 * `sw … | head`: the reader closes stdout early. Before wave 9 this was an unhandled EPIPE (exit 1 with a
 * stack trace) on Linux/macOS (verified in WSL: `sw inspect … --graph json | head -c 50` → "Error: write EPIPE",
 * exit 1). Now the closed pipe is a sink and the command exits with its normal code. Windows pipes did not
 * crash before the fix either, so this test guards the regression on the Linux/macOS CI legs.
 */
import { describe, expect, it } from "vitest";
import { spawnCli } from "../helpers/cli.js";

describe("closed stdout pipe", () => {
  it("reader closes after the first chunk of a large output: no EPIPE crash, normal exit code", async () => {
    // ~90 KB of JSON: larger than any OS pipe buffer, so the CLI is still writing when the pipe closes.
    const child = spawnCli(
      ["inspect", "examples/orders-jobs-api", "--graph", "json", "--no-history", "--fail-on", "never"],
      {
        timeoutMs: 60_000,
      },
    );
    let chunks = 0;
    child.stdout?.on("data", () => {
      chunks++;
      if (chunks === 1) child.stdout?.destroy();
    });
    const r = await child;
    const stderr = String(r.stderr ?? "");
    expect(chunks).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/EPIPE|Unhandled|internal error/i);
    expect(r.exitCode).toBe(0);
  }, 90_000);
});
