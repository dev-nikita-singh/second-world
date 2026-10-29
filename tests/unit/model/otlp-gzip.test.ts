/**
 * Gzipped OTLP trace files (sw-fixes, wave 5): `.json.gz`, `.pb.gz` and gzip content under any name are
 * detected by the 1f 8b magic, decompressed with a size + ratio cap, then routed through the existing
 * JSON / protobuf detection. A zip bomb is rejected as a clean MODEL_OTLP_UNREADABLE limitation.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GzipLimitError, maybeGunzip } from "../../../src/adapters/telemetry/gzip.js";
import { createFakeClock } from "../../../src/core/clock.js";
import { buildModel, type ModelData, toCanonicalJson } from "../../../src/engines/model/index.js";
import { withTmpDir } from "../../helpers/tmp.js";
import { encodeTraceRequest } from "./otlp-pb-encoder.js";

const FIX = path.resolve(__dirname, "../../fixtures/model");
const shop = JSON.parse(readFileSync(path.join(FIX, "shop-traces.json"), "utf8"));

async function build(project: string, file: string) {
  const r = await buildModel(
    {
      project,
      serviceName: "shop-express",
      architecture: false,
      config: { files: [], discover: false },
      traces: [file],
    },
    { clock: createFakeClock(Date.parse("2026-10-29T12:00:00Z")) },
  );
  return { status: r.status, data: r.data as ModelData, limitations: r.limitations };
}

describe("maybeGunzip", () => {
  it("passes non-gzip bytes through untouched", () => {
    const b = Buffer.from('{"resourceSpans":[]}');
    expect(maybeGunzip(b)).toEqual({ bytes: b, gzipped: false });
  });

  it("decompresses gzip (magic 1f 8b)", () => {
    const b = Buffer.from("hello ".repeat(100));
    const r = maybeGunzip(gzipSync(b));
    expect(r.gzipped).toBe(true);
    expect(Buffer.from(r.bytes).equals(b)).toBe(true);
  });

  it("rejects output above maxBytes and above the compression ratio", () => {
    const zeros = gzipSync(Buffer.alloc(1024 * 1024));
    expect(() => maybeGunzip(zeros, { maxBytes: 64 * 1024 })).toThrow(GzipLimitError);
    expect(() => maybeGunzip(zeros, { maxRatio: 10, minLimit: 0 })).toThrow(/ratio/);
  });

  it("reports corrupt gzip as an error, not a crash", () => {
    const g = gzipSync(Buffer.from("x".repeat(1000)));
    expect(() => maybeGunzip(g.subarray(0, 12))).toThrow(/gzip/);
  });
});

describe("buildModel with gzipped trace files", () => {
  it("gz JSON (.json.gz) and gz protobuf (.pb.gz, extension-less) give the same model as plain JSON", async () => {
    await withTmpDir(async (tmp) => {
      const json = JSON.stringify(shop);
      await writeFile(path.join(tmp.path, "plain.json"), json);
      await writeFile(path.join(tmp.path, "traces.json.gz"), gzipSync(json));
      await writeFile(path.join(tmp.path, "traces.pb.gz"), gzipSync(encodeTraceRequest(shop)));
      await writeFile(path.join(tmp.path, "traces-pb-noext"), gzipSync(encodeTraceRequest(shop)));
      await writeFile(path.join(tmp.path, "traces-json-noext"), gzipSync(json));
      const plain = await build(tmp.path, "plain.json");
      expect(plain.data.traces?.spans).toBeGreaterThan(0);
      for (const f of ["traces.json.gz", "traces.pb.gz", "traces-pb-noext", "traces-json-noext"]) {
        const r = await build(tmp.path, f);
        expect(
          r.limitations.find((l) => l.code === "MODEL_OTLP_UNREADABLE"),
          f,
        ).toBeUndefined();
        expect(r.status, f).toBe("passed");
        expect(toCanonicalJson(r.data), f).toBe(toCanonicalJson(plain.data));
      }
    }, "sw-model-gz-");
  });

  it("a gzip bomb is rejected cleanly (MODEL_OTLP_UNREADABLE, nothing ingested)", async () => {
    await withTmpDir(async (tmp) => {
      // 64 MiB of spaces compresses ~1000:1 → over the 200:1 ratio cap.
      await writeFile(
        path.join(tmp.path, "bomb.json.gz"),
        gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 }),
      );
      const r = await build(tmp.path, "bomb.json.gz");
      const l = r.limitations.find((x) => x.code === "MODEL_OTLP_UNREADABLE");
      expect(l?.message).toMatch(/^bomb\.json\.gz: gzip: decompressed size exceeds/);
      expect(r.data.traces?.spans ?? 0).toBe(0);
    }, "sw-model-gz-");
  }, 30_000);
});
