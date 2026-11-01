/**
 * Malformed inputs never crash the tool (PLAN-wave8 §sw-robust-w8 task 3, DoD item 5): broken OpenAPI
 * documents, config files (yaml/json/ts), agent context reports and history files must end with a
 * usage/config exit code (2, or 5 when the target is the problem) and a message on stderr — never
 * 70 (internal error). Property-based (fast-check): random JSON/YAML/text, truncations and random
 * subtree replacements of valid documents. Runs `main()` in-process (no network: the target is a
 * closed loopback port and only --dry-run / offline commands are used).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { main } from "../../../src/cli/main.js";
import { REPO_ROOT } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
let ucfg: TmpDir;
let seq = 0;
const cwd0 = process.cwd();
beforeAll(async () => {
  ucfg = await makeTmpDir("sw-malformed-ucfg-");
  process.env.SW_USER_CONFIG_DIR = ucfg.path;
});
afterAll(async () => {
  await ucfg.cleanup();
});
beforeEach(async () => {
  tmp = await makeTmpDir("sw-malformed-");
  process.chdir(tmp.path);
});
afterEach(async () => {
  process.chdir(cwd0);
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await tmp.cleanup();
});

interface Outcome {
  code: number;
  stderr: string;
}

/** Runs `sw <args>` in-process with stdout/stderr captured. */
async function sw(args: readonly string[]): Promise<Outcome> {
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    stderr += String(c);
    return true;
  });
  process.exitCode = undefined;
  try {
    const code = await main(["node", "sw", "--no-color", ...args]);
    return { code, stderr };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
}

const CLOSED = "http://127.0.0.1:9"; // nothing listens; dry runs send nothing anyway
const OK = new Set([2, 5]);

function expectHandled(o: Outcome, input: string): void {
  if (!OK.has(o.code) || o.stderr.trim() === "")
    throw new Error(
      `exit ${o.code} for input ${JSON.stringify(input.slice(0, 300))}\nstderr: ${o.stderr.slice(0, 1500)}`,
    );
}

const VALID_SPEC = readFileSync(path.join(REPO_ROOT, "examples", "shop-express", "openapi.yaml"), "utf8");
const validDoc = parseYaml(VALID_SPEC) as unknown;

/** Replace the subtree at a pseudo-random path of `doc` with `value` (bounded, iterative). */
function mutate(doc: unknown, pick: number[], value: unknown): unknown {
  const root = structuredClone(doc) as Record<string, unknown>;
  let cur: unknown = root;
  for (let i = 0; i < pick.length; i++) {
    if (cur === null || typeof cur !== "object") break;
    const keys = Object.keys(cur as object);
    if (keys.length === 0) break;
    const k = keys[(pick[i] as number) % keys.length] as string;
    const next = (cur as Record<string, unknown>)[k];
    if (i === pick.length - 1 || next === null || typeof next !== "object") {
      (cur as Record<string, unknown>)[k] = value;
      break;
    }
    cur = next;
  }
  return root;
}

const brokenDocText = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.jsonValue({ maxDepth: 4 }).map((v) => JSON.stringify(v)),
  fc.nat({ max: VALID_SPEC.length }).map((n) => VALID_SPEC.slice(0, n)),
  fc
    .tuple(fc.array(fc.nat(50), { minLength: 1, maxLength: 6 }), fc.jsonValue({ maxDepth: 2 }))
    .map(([p, v]) => toYaml(mutate(validDoc, p, v))),
);

const file = (name: string): string => tmp.join(`${++seq}-${name}`);

describe("malformed OpenAPI → ConfigError (exit 2) from the contract loaders", () => {
  // The loaders behind `sw bugs`, `sw agent` (both also run them on --dry-run, via checkBugsSession)
  // and `sw model build --openapi`. They are tolerant: a bundle-able but odd document loads with fewer
  // operations; anything else must be a ConfigError.
  for (const [name, load] of [
    [
      "bugs loadContract",
      async (f: string) => (await import("../../../src/engines/bugs/contract.js")).loadContract(f),
    ],
    [
      "model fromOpenApi",
      async (f: string) =>
        (await import("../../../src/engines/model/sources/openapi.js")).fromOpenApi(f, tmp.path),
    ],
  ] as const) {
    it(`${name}(<broken>) throws a SecondWorldError with exit 2, never a raw error`, async () => {
      const { isSecondWorldError } = await import("../../../src/core/errors.js");
      await fc.assert(
        fc.asyncProperty(brokenDocText, async (text) => {
          const f = file("spec.yaml");
          writeFileSync(f, text);
          try {
            await load(f);
          } catch (e) {
            if (!isSecondWorldError(e) || e.exitCode !== 2)
              throw new Error(
                `${name}: raw ${(e as Error)?.name}: ${(e as Error)?.message} for ${JSON.stringify(text.slice(0, 300))}`,
              );
          }
        }),
        { numRuns: 150 },
      );
    }, 180_000);
  }
});

describe("malformed OpenAPI → exit 2 with a message", () => {
  for (const cmd of ["agent", "bugs"]) {
    it(`sw --dry-run ${cmd} --openapi <broken>`, async () => {
      await fc.assert(
        fc.asyncProperty(brokenDocText, async (text) => {
          const f = file("spec.yaml");
          writeFileSync(f, text);
          const o = await sw(["--dry-run", cmd, "-t", CLOSED, "--openapi", f]);
          if (o.code === 0) return; // a truncation/mutation may still be a valid contract
          expectHandled(o, text);
        }),
        { numRuns: 60 },
      );
    }, 180_000);
  }
});

const configValue = fc.oneof(
  fc.jsonValue({ maxDepth: 4 }),
  fc.record({
    target: fc.oneof(fc.string(), fc.jsonValue({ maxDepth: 2 })),
    safety: fc.jsonValue({ maxDepth: 2 }),
    report: fc.jsonValue({ maxDepth: 2 }),
    history: fc.jsonValue({ maxDepth: 2 }),
    performance: fc.jsonValue({ maxDepth: 2 }),
  }),
);

describe("malformed config → exit 2 with a message", () => {
  it("json / yaml configs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          configValue.map((v) => ({ ext: "json", text: JSON.stringify(v) })),
          configValue.map((v) => ({ ext: "yaml", text: toYaml(v) })),
          fc.string({ maxLength: 200 }).map((t) => ({ ext: "yaml", text: t })),
          fc.string({ maxLength: 200 }).map((t) => ({ ext: "json", text: t })),
        ),
        async ({ ext, text }) => {
          const f = file(`sw.config.${ext}`);
          writeFileSync(f, text);
          const o = await sw(["-c", f, "config", "validate"]);
          if (o.code === 0) return; // a random document may happen to be a valid config
          expectHandled(o, text);
        },
      ),
      { numRuns: 80 },
    );
  }, 180_000);

  it("ts configs: syntax errors, throwing code, non-object exports", async () => {
    const bodies = [
      "export default {",
      "export default 42;",
      "export default null;",
      'throw new Error("boom");',
      "export default { target: 1, safety: 'x' };",
      'import x from "./does-not-exist.js"; export default x;',
      "export default (() => { throw new TypeError('t'); })();",
      "export default Promise.reject(new Error('async boom'));",
      "export const nope = 1;",
      "export default { history: { dir: 5 }, report: { formats: 'json' } };",
    ];
    const bad: string[] = [];
    for (const b of bodies) {
      const f = file("sw.config.ts");
      writeFileSync(f, b);
      const o = await sw(["-c", f, "config", "validate"]);
      if (o.code === 0) continue;
      if (!OK.has(o.code) || o.stderr.trim() === "")
        bad.push(`exit ${o.code}: ${b}\n${o.stderr.slice(0, 400)}`);
    }
    expect(bad).toEqual([]);
  }, 180_000);
});

describe("malformed agent context report → exit 2 with a message", () => {
  it("sw --dry-run agent --context <broken>", async () => {
    const spec = file("ok.yaml");
    writeFileSync(spec, VALID_SPEC);
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 200 }),
          fc.jsonValue({ maxDepth: 4 }).map((v) => JSON.stringify(v)),
        ),
        async (text) => {
          const f = file("ctx.json");
          writeFileSync(f, text);
          const o = await sw(["--dry-run", "agent", "-t", CLOSED, "--openapi", spec, "--context", f]);
          if (o.code === 0) return; // any JSON is an accepted context
          expectHandled(o, text);
        },
      ),
      { numRuns: 40 },
    );
  }, 180_000);
});

describe("malformed history files → never exit 70", () => {
  const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
  function writeHistory(index: string, body: Uint8Array | undefined): void {
    const dir = path.join(tmp.path, ".second-world", "history");
    mkdirSync(path.join(dir, "runs"), { recursive: true });
    writeFileSync(path.join(dir, "runs.jsonl"), index);
    if (body !== undefined) writeFileSync(path.join(dir, "runs", `${ID}.json.gz`), body);
  }
  const entry = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id: ID,
      file: `runs/${ID}.json.gz`,
      v: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      tags: [],
      engines: ["performance"],
      status: "passed",
      metrics: { "performance.http.p95": 12 },
      findings: { count: 0, maxSeverity: null, fingerprints: [] },
      sha256: "0".repeat(64),
      bytes: 10,
      ...extra,
    });

  it("broken index lines, broken run bodies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 200 }),
          fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.stringify(v)),
          fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 })).map((d) => entry(d)),
        ),
        fc.oneof(
          fc.constant(undefined),
          fc.uint8Array({ maxLength: 64 }),
          fc.jsonValue({ maxDepth: 4 }).map((v) => new Uint8Array(gzipSync(JSON.stringify(v)))),
          fc.string({ maxLength: 100 }).map((s) => new Uint8Array(gzipSync(s))),
        ),
        fc.constantFrom(
          ["history", "list"],
          ["history", "show", ID],
          ["history", "diff", ID, ID],
          ["history", "verify"],
          ["history", "trend"],
          ["history", "baseline", "list"],
        ),
        async (index, body, args) => {
          writeHistory(`${entry()}\n${index}\n`, body);
          const o = await sw(args);
          if (o.code === 70 || o.code < 0)
            throw new Error(
              `exit ${o.code} for ${args.join(" ")} index=${JSON.stringify(index.slice(0, 200))} body=${body === undefined ? "none" : Buffer.from(body).toString("base64").slice(0, 120)}\nstderr: ${o.stderr.slice(0, 1500)}`,
            );
          if (o.code !== 0 && o.code !== 1) expect(o.stderr.trim()).not.toBe("");
        },
      ),
      { numRuns: 120 },
    );
  }, 240_000);
});
