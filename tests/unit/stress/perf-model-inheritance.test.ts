/**
 * Gap 1 (sw-gaps-w8, found by sw-real2-w8 on orders-jobs-api): `sw stress` must infer the load
 * dimension from `performance.model` / `performance.rate` when `stress.loadType` is omitted
 * (docs/03-engines/stress-capacity-lab.md "Load dimension"). Before the fix the world mapping
 * dropped `model`/`rate`, so stages always ran as VUs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import { buildStressInput } from "../../../src/core/world.js";
import { parseStressInput } from "../../../src/engines/stress/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function stressOf(inline: Record<string, unknown>) {
  const d = mkdtempSync(join(tmpdir(), "sw-stress-inherit-"));
  dirs.push(d);
  const cfg = await loadConfig({ cwd: d, inline, userConfig: false, env: {} });
  return parseStressInput(buildStressInput(cfg, {}, { env: {} }));
}

const T = { targets: { api: { url: "http://127.0.0.1:3000" } } };

describe("stress load dimension inherited from performance", () => {
  it('performance.model "open" + rate → stages are arrival rates', async () => {
    const s = await stressOf({
      ...T,
      performance: { model: "open", rate: 10 },
      stress: { mode: "step", stages: [4, 12, 48] },
    });
    expect(s.loadType).toBe("rate");
  });

  it("performance.rate without model (inferred open) → rate", async () => {
    const s = await stressOf({ ...T, performance: { rate: "10/s" }, stress: { stages: [4, 12] } });
    expect(s.loadType).toBe("rate");
  });

  it('explicit performance.model "closed" wins over a rate; no perf model → VUs', async () => {
    const closed = await stressOf({
      ...T,
      performance: { model: "closed", vus: 5, rate: 10 },
      stress: { stages: [4, 12] },
    });
    expect(closed.loadType).toBe("vus");
    const none = await stressOf({ ...T, performance: { vus: 5 }, stress: { stages: [4, 12] } });
    expect(none.loadType).toBe("vus");
  });

  it("stress.loadType and stress.model override the performance section", async () => {
    const a = await stressOf({
      ...T,
      performance: { model: "open", rate: 10 },
      stress: { stages: [4], loadType: "vus" },
    });
    expect(a.loadType).toBe("vus");
    const b = await stressOf({
      ...T,
      performance: { model: "open", rate: 10 },
      stress: { stages: [4], model: "closed" },
    });
    expect(b.loadType).toBe("vus");
  });
});

describe("call input decides the load dimension over inherited performance keys", () => {
  it('a CLI --rate beats performance.model "closed"; --steps without rate keep perf open', async () => {
    const d = mkdtempSync(join(tmpdir(), "sw-stress-inherit-"));
    dirs.push(d);
    const cfg = await loadConfig({
      cwd: d,
      inline: { ...T, performance: { model: "closed", vus: 5 } },
      userConfig: false,
      env: {},
    });
    const soak = parseStressInput(
      buildStressInput(cfg, { mode: "soak", rate: 100, soak: { level: 100, duration: 60_000 } }, { env: {} }),
    );
    expect(soak.loadType).toBe("rate");
    const cfg2 = await loadConfig({
      cwd: d,
      inline: { ...T, performance: { model: "open", rate: 10 } },
      userConfig: false,
      env: {},
    });
    const step = parseStressInput(buildStressInput(cfg2, { stages: [4, 12] }, { env: {} }));
    expect(step.loadType).toBe("rate");
  });
});
