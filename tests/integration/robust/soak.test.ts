/**
 * Soak of the tool itself (PLAN-wave8 §sw-robust-w8 task 2, DoD item 5): a long `sw perf` at a
 * moderate rate against an in-test server, the sw process's RSS and heap sampled every 5 s.
 * Asserts memory stays bounded: no steady growth between the first and the last minute of the run.
 *
 * Opt-in (slow): SW_SOAK=1 npx vitest run tests/integration/robust/soak.test.ts
 *   SW_SOAK_DURATION  run length in seconds (default 300)
 *   SW_SOAK_RATE      requests/s (default 200)
 * Measured (Windows, Node 24, 300 s @ 200 rps): RSS 225 MB at 60 s → 227 MB at 300 s (peak 231 MB),
 * heap oscillating 22–81 MB. Details in .agents/progress/sw-robust-w8.md.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CalibratedServer, startCalibratedServer } from "../../fixtures/servers/calibrated.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";
import { TSX_LOADER } from "../concurrency/helpers.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "soak-entry.ts");
const ENABLED = process.env.SW_SOAK === "1";
const DURATION_S = Number(process.env.SW_SOAK_DURATION ?? "300");
const RATE = Number(process.env.SW_SOAK_RATE ?? "200");

interface Sample {
  t: number;
  rss: number;
  heap: number;
  ext: number;
}

let srv: CalibratedServer;
let tmp: TmpDir;
beforeAll(async () => {
  if (!ENABLED) return;
  srv = await startCalibratedServer({ precise: false });
  tmp = await makeTmpDir("sw-soak-");
});
afterAll(async () => {
  await srv?.close();
  await tmp?.cleanup();
});

const MB = 1024 * 1024;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe.skipIf(!ENABLED)("soak: long sw perf keeps memory bounded", () => {
  it(
    `sw perf ${DURATION_S}s at ${RATE} rps`,
    async () => {
      const r = await execa(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          FIXTURE,
          "perf",
          `${srv.url}/fixed/2`,
          "--rate",
          String(RATE),
          "--duration",
          `${DURATION_S}s`,
          "--warmup",
          "5s",
          "-f",
          "json",
          "-o",
          "out",
          "--quiet",
        ],
        {
          cwd: tmp.path,
          reject: false,
          timeout: (DURATION_S + 120) * 1000,
          env: { NO_COLOR: "1", CI: "1", SW_USER_CONFIG_DIR: tmp.join("ucfg") },
          stdin: "ignore",
          windowsHide: true,
        },
      );
      const samples = String(r.stderr)
        .split("\n")
        .filter((l) => l.startsWith("soak-sample "))
        .map((l) => JSON.parse(l.slice(12)) as Sample);
      expect(r.exitCode, String(r.stderr).slice(-2000)).toBe(0);
      // RSS ramps up during the first ~30 s (pools, JIT, histogram buckets), then plateaus: compare the
      // second minute with the last one (windows shrink to a quarter of the run for short runs)
      const minute = Math.min(60, Math.floor(DURATION_S / 4));
      const first = samples.filter((s) => s.t >= minute && s.t < 2 * minute);
      const last = samples.filter((s) => s.t >= DURATION_S - minute && s.t < DURATION_S);
      const rssFirst = median(first.map((s) => s.rss));
      const rssLast = median(last.map((s) => s.rss));
      const heapFirst = median(first.map((s) => s.heap));
      const heapLast = median(last.map((s) => s.heap));
      const peak = Math.max(...samples.map((s) => s.rss));
      console.info(
        `[soak] ${DURATION_S}s @${RATE}rps samples=${samples.length} rss first=${(rssFirst / MB).toFixed(1)}MB last=${(rssLast / MB).toFixed(1)}MB peak=${(peak / MB).toFixed(1)}MB heap first=${(heapFirst / MB).toFixed(1)}MB last=${(heapLast / MB).toFixed(1)}MB`,
      );
      console.info(
        `[soak] series t:rss/heap/ext MB ${samples.map((s) => `${s.t}:${(s.rss / MB).toFixed(0)}/${(s.heap / MB).toFixed(0)}/${(s.ext / MB).toFixed(0)}`).join(" ")}`,
      );
      expect(first.length).toBeGreaterThan(2);
      expect(last.length).toBeGreaterThan(2);
      // bounded: the last minute is within 25% (+16 MB slack for GC timing) of the first
      expect(rssLast).toBeLessThan(rssFirst * 1.25 + 16 * MB);
      expect(heapLast).toBeLessThan(heapFirst * 1.25 + 16 * MB);
    },
    (DURATION_S + 180) * 1000,
  );
});
