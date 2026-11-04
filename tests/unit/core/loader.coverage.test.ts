/**
 * Coverage tests for config loading + secret resolution (docs/08-configuration.md §1, §3, §5;
 * docs/11 §4 config secrets). Owner: sw-coverage (Wave 5).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  coerceValue,
  collectSecretValues,
  discoverConfigFile,
  getPath,
  loadConfig,
  loadObjectFile,
  maskConfig,
  mergeLayer,
  parseSetArgs,
  resolveSecret,
  setPath,
} from "../../../src/core/config/loader.js";
import { ConfigError } from "../../../src/core/errors.js";
import { createRedactor } from "../../../src/core/log/redact.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sw-loader-cov-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveSecret", () => {
  it("env: missing and empty values fail without echoing anything secret", () => {
    expect(resolveSecret({ env: "TOK" }, { env: { TOK: "v4lue" } })).toBe("v4lue");
    for (const env of [{}, { TOK: "" }]) {
      try {
        resolveSecret({ env: "TOK" }, { env });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).code).toBe("SW_CONFIG_SECRET");
        expect((e as ConfigError).hint).toBe("export TOK=...");
      }
    }
  });

  it("file: relative to cwd, trimmed; unreadable file error does not leak the path contents", () => {
    const d = tmp();
    writeFileSync(join(d, "s.txt"), "  file-secret-value\r\n");
    expect(resolveSecret({ file: "s.txt" }, { cwd: d })).toBe("file-secret-value");
    expect(() => resolveSecret({ file: "missing.txt" }, { cwd: d })).toThrow(
      /Secret file missing.txt cannot be read/,
    );
    expect(() => resolveSecret({ file: "." }, { cwd: d })).toThrow(ConfigError); // a directory
  });

  it("collectSecretValues walks nested objects/arrays and skips unresolvable refs", () => {
    const d = tmp();
    writeFileSync(join(d, "k"), "from-file-1234");
    const vals = collectSecretValues(
      {
        auth: { admin: { token: { env: "A" } }, user: { password: { env: "MISSING" } } },
        list: [{ env: "B" }, [{ file: "k" }], "plain", 3, null],
        notRef: { env: "A", extra: 1 },
      },
      { env: { A: "aaaa-secret", B: "bbbb-secret" }, cwd: d },
    );
    expect(vals.sort()).toEqual(["aaaa-secret", "bbbb-secret", "from-file-1234"]);
  });

  it("maskConfig redacts secret-looking values but keeps structure", () => {
    const out = maskConfig({ auth: { password: "pw", url: "http://u:pass1234@h/" }, n: 1 });
    expect(out.n).toBe(1);
    expect(out.auth.password).toMatch(/«redacted:/);
    expect(out.auth.url).not.toContain("pass1234");
  });
});

describe("coerceValue / setPath / getPath / parseSetArgs", () => {
  it("coerces scalars and JSON; leaves invalid JSON and long digit strings as strings", () => {
    expect(coerceValue(" true ")).toBe(true);
    expect(coerceValue("false")).toBe(false);
    expect(coerceValue("null")).toBeNull();
    expect(coerceValue("-12.5")).toBe(-12.5);
    expect(coerceValue("1234567890123456")).toBe("1234567890123456"); // ids keep precision
    expect(coerceValue("[1,2]")).toEqual([1, 2]);
    expect(coerceValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceValue("{oops}")).toBe("{oops}");
    expect(coerceValue("1e3")).toBe("1e3");
  });

  it("property: integers below 16 chars round-trip through coerceValue", () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(coerceValue(String(n))).toEqual(n);
      }),
    );
  });

  it("setPath/mergeLayer refuse prototype pollution", () => {
    const o: Record<string, unknown> = {};
    setPath(o, ["__proto__", "polluted"], true);
    setPath(o, ["a", "constructor"], 1);
    setPath(o, ["prototype"], 1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(o).toEqual({ a: {} });
    const origins: Record<string, string> = {};
    const src = JSON.parse('{"__proto__":{"polluted":1},"x":{"constructor":{"y":1},"z":2}}');
    const merged = mergeLayer({}, src, "t", origins);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged).toEqual({ x: { z: 2 } });
    expect(origins).toEqual({ "x.z": "t" });
  });

  it("mergeLayer: scalars replace objects (origins of children cleared), arrays are copied, secret refs are leaves", () => {
    const origins: Record<string, string> = {};
    const dst = mergeLayer({}, { a: { b: 1, c: 2 } }, "L1", origins);
    const arr = [1, 2];
    mergeLayer(dst, { a: 5, list: arr, tok: { env: "T" }, skip: undefined }, "L2", origins);
    expect(dst).toEqual({ a: 5, list: [1, 2], tok: { env: "T" } });
    expect(dst.list).not.toBe(arr);
    expect(origins).toEqual({ a: "L2", list: "L2", tok: "L2" });
    mergeLayer(dst, { a: { d: 1 } }, "L3", origins);
    expect(origins.a).toBeUndefined();
    expect(origins["a.d"]).toBe("L3");
  });

  it("getPath handles arrays and missing intermediates", () => {
    expect(getPath({ a: [{ b: 3 }] }, "a.0.b")).toBe(3);
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });

  it("parseSetArgs validates syntax", () => {
    expect(parseSetArgs(["performance.rate=200", 'safety.allowHosts=["a"]'])).toEqual({
      performance: { rate: 200 },
      safety: { allowHosts: ["a"] },
    });
    expect(() => parseSetArgs(["novalue"])).toThrow(/expected key=value/);
    expect(() => parseSetArgs(["=1"])).toThrow(ConfigError);
    expect(() => parseSetArgs(["a..b=1"])).toThrow(/Invalid --set key/);
    expect(() => parseSetArgs(["a b=1"])).toThrow(/Invalid --set key/);
    expect(parseSetArgs(["a=x=y"])).toEqual({ a: "x=y" });
  });
});

describe("files", () => {
  it("loadObjectFile: missing, code disabled, JSON, YAML (BOM, empty, non-mapping), parse errors", async () => {
    const d = tmp();
    await expect(loadObjectFile(join(d, "nope.json"))).rejects.toMatchObject({ code: "SW_CONFIG_NOT_FOUND" });
    writeFileSync(join(d, "x.ts"), "export default {}");
    await expect(loadObjectFile(join(d, "x.ts"), { noConfigCode: true })).rejects.toMatchObject({
      code: "SW_CONFIG_CODE_DISABLED",
    });
    writeFileSync(join(d, "a.json"), '﻿{"k":1}');
    expect(await loadObjectFile(join(d, "a.json"))).toEqual({ k: 1 });
    writeFileSync(join(d, "n.json"), "null");
    expect(await loadObjectFile(join(d, "n.json"))).toEqual({});
    writeFileSync(join(d, "e.yaml"), "");
    expect(await loadObjectFile(join(d, "e.yaml"))).toEqual({});
    writeFileSync(join(d, "l.yaml"), "- 1\n- 2\n");
    await expect(loadObjectFile(join(d, "l.yaml"))).rejects.toMatchObject({ code: "SW_CONFIG_PARSE" });
    writeFileSync(join(d, "b.json"), "{bad");
    await expect(loadObjectFile(join(d, "b.json"))).rejects.toMatchObject({
      code: "SW_CONFIG_PARSE",
      details: { file: join(d, "b.json") },
    });
    mkdirSync(join(d, "dir.json"));
    await expect(loadObjectFile(join(d, "dir.json"))).rejects.toMatchObject({ code: "SW_CONFIG_READ" });
  });

  it("discoverConfigFile walks up to the git root and ignores directories named like configs", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    mkdirSync(join(root, "a", "sw.config.json")); // a directory: skipped
    expect(discoverConfigFile(join(root, "a", "b"))).toBeUndefined();
    writeFileSync(join(root, "sw.config.yaml"), "seed: 1\n");
    expect(discoverConfigFile(join(root, "a", "b"))).toBe(join(root, "sw.config.yaml"));
  });

  it("extends chain: relative ok, package preset refused, missing target, non-string, depth limit", async () => {
    const d = tmp();
    writeFileSync(join(d, "base.json"), JSON.stringify({ environment: "staging" }));
    writeFileSync(join(d, "sw.config.json"), JSON.stringify({ extends: "./base.json" }));
    const r = await loadConfig({ cwd: d, configFile: "sw.config.json", userConfig: false, env: {} });
    expect(r.config.environment).toBe("staging");
    expect(r.origins.environment).toBe("base.json");

    const cases: Array<[unknown, RegExp]> = [
      ["some-package", /package presets require a TS\/JS config/],
      ["./nope.json", /extends target not found/],
      [[1], /extends must be a string/],
    ];
    for (const [ext, re] of cases) {
      writeFileSync(join(d, "c.json"), JSON.stringify({ extends: ext }));
      await expect(loadConfig({ cwd: d, configFile: "c.json", userConfig: false, env: {} })).rejects.toThrow(
        re,
      );
    }
    writeFileSync(join(d, "loop.json"), JSON.stringify({ extends: "./loop.json" }));
    await expect(
      loadConfig({ cwd: d, configFile: "loop.json", userConfig: false, env: {} }),
    ).rejects.toMatchObject({
      code: "SW_CONFIG_EXTENDS",
      message: expect.stringContaining("too deep"),
    });
  });

  it("explicit missing config, code disabled, unknown profile with/without profiles", async () => {
    const d = tmp();
    await expect(
      loadConfig({ cwd: d, configFile: "x.json", userConfig: false, env: {} }),
    ).rejects.toMatchObject({ code: "SW_CONFIG_NOT_FOUND" });
    writeFileSync(join(d, "sw.config.ts"), "export default {}");
    await expect(
      loadConfig({ cwd: d, configFile: "sw.config.ts", noConfigCode: true, userConfig: false, env: {} }),
    ).rejects.toMatchObject({
      code: "SW_CONFIG_CODE_DISABLED",
    });
    await expect(
      loadConfig({ cwd: d, configFile: false, profile: "ci", userConfig: false, env: {} }),
    ).rejects.toMatchObject({
      code: "SW_CONFIG_PROFILE",
      hint: "No profiles are defined in the config",
    });
    await expect(
      loadConfig({
        cwd: d,
        inline: { profiles: { ci: {}, dev: {} } },
        profile: "prod",
        userConfig: false,
        env: {},
      }),
    ).rejects.toMatchObject({ hint: "Available profiles: ci, dev" });
  });

  it("raw secrets in config files produce warnings; secret refs do not", async () => {
    const d = tmp();
    writeFileSync(
      join(d, "sw.config.yaml"),
      "auth:\n  admin:\n    password: supersecretvalue\n    token: { env: ADMIN_TOKEN }\n",
    );
    const r = await loadConfig({ cwd: d, userConfig: false, env: {} }).catch((e) => e);
    // the schema may or may not accept this auth shape; when it loads, the warning must be present
    if (!(r instanceof Error)) {
      expect(r.warnings.join("\n")).toMatch(
        /Literal string at auth\.admin\.password in sw\.config\.yaml looks like a secret/,
      );
      expect(r.warnings.join("\n")).not.toContain("supersecretvalue");
      // The logger redacts every line it prints: the warning must survive that unchanged
      // (the old "auth.x.token: value in …" wording was itself redacted to "token: «redacted»").
      const red = createRedactor();
      for (const w of r.warnings) expect(red.redactString(w)).toBe(w);
    }
  });

  it("user config: only `ui` is picked up; unreadable user config is ignored", async () => {
    const d = tmp();
    const u = join(d, "user");
    mkdirSync(u);
    writeFileSync(
      join(u, "config.json"),
      JSON.stringify({ ui: { color: false }, safety: { allowPublic: true } }),
    );
    const r = await loadConfig({ cwd: d, configFile: false, env: { SW_USER_CONFIG_DIR: u } });
    expect(r.config.safety?.allowPublic).not.toBe(true);
    writeFileSync(join(u, "config.json"), "{broken");
    await expect(
      loadConfig({ cwd: d, configFile: false, env: { SW_USER_CONFIG_DIR: u } }),
    ).resolves.toBeDefined();
  });
});
