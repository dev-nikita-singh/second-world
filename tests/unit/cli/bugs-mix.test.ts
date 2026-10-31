/**
 * `sw bugs --mix`: parsing into ConcurrencyTest.mix entries, flag errors (SW_CONFIG_FLAG, exit 2)
 * and the mix reaching the engine input (`--dry-run --json` prints the parsed Bug Hunter input).
 * docs/03-engines/api-bug-hunter.md §6.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bugsInputFromFlags, parseMix } from "../../../src/cli/commands/bugs.js";
import { ConfigError } from "../../../src/core/errors.js";
import { parseBugsInput } from "../../../src/engines/bugs/index.js";
import { runCli } from "../../helpers/cli.js";

const env = { SW_USER_CONFIG_DIR: join(tmpdir(), "sw-no-user-config") };

function flagError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("parseMix", () => {
  it("operation + count shorthand; GET defaults to as=read", () => {
    expect(parseMix("GET /products/{id}:3")).toEqual({
      operation: "GET /products/{id}",
      count: 3,
      as: "read",
    });
    expect(parseMix("  get /stock  ")).toEqual({ operation: "GET /stock", as: "read" });
  });

  it("key=value tokens: as, count, phase, pointer, value, role, path params, query., header., body", () => {
    expect(
      parseMix(
        'PUT /products/{id}/stock id=20 as=write count=2 phase=during pointer=/stock role=admin query.dry=false query.n=3 header.X-Trace=t1 body={"stock": 5, "note": "a b"}',
      ),
    ).toEqual({
      operation: "PUT /products/{id}/stock",
      as: "write",
      count: 2,
      phase: "during",
      pointer: "/stock",
      role: "admin",
      pathParams: { id: 20 },
      query: { dry: false, n: 3 },
      headers: { "X-Trace": "t1" },
      body: { stock: 5, note: "a b" },
    });
    expect(parseMix("POST /sets/{name}/items name=tags as=add value=x phase=after")).toEqual({
      operation: "POST /sets/{name}/items",
      as: "add",
      value: "x",
      phase: "after",
      pathParams: { name: "tags" },
    });
    // count= overrides the shorthand (last one wins)
    expect(parseMix("GET /a:2 count=4").count).toBe(4);
  });

  it("bad syntax → SW_CONFIG_FLAG with the expected form in the hint", () => {
    const cases: [string, RegExp][] = [
      ["", /METHOD \/path/],
      ["/products", /METHOD \/path/],
      ["GET products", /must start with "\/"/],
      ["POST /orders count=2", /as=<take\|read/],
      ["GET /a as=pop", /as must be/],
      ["GET /a count=0", /count must be an integer 1\.\.64/],
      ["GET /a count=65", /count must be/],
      ["GET /a count=x", /count must be/],
      ["GET /a phase=later", /phase must be before\|during\|after/],
      ["GET /a pointer=stock", /JSON pointer/],
      ["GET /a stock", /not key=value/],
      ["GET /a/{id} idd=1", /unknown key "idd".*id/],
      ['POST /a as=take body={"x":', /body= must be valid JSON/],
    ];
    for (const [spec, re] of cases) {
      const e = flagError(() => parseMix(spec));
      expect(e.code).toBe("SW_CONFIG_FLAG");
      expect(e.exitCode).toBe(2);
      expect(e.message).toMatch(re);
      expect(e.hint).toContain("<METHOD> <path>[:<count>]");
    }
  });
});

describe("bugsInputFromFlags with --mix", () => {
  it("attaches every --mix to each --concurrency-test; the result is a valid engine input", () => {
    const flags = bugsInputFromFlags(
      {
        target: "http://127.0.0.1:1",
        concurrencyTest: ["POST /orders"],
        burst: "3",
        role: "user",
        body: '{"items":[{"productId":1,"qty":1}]}',
        invariant: "linearizable:stock",
        mix: [
          "GET /products/{id} id=1 pointer=/stock phase=before",
          "GET /products/{id}:2 id=1 pointer=/stock",
        ],
      },
      "/w",
    );
    const mix = [
      {
        operation: "GET /products/{id}",
        as: "read",
        pointer: "/stock",
        phase: "before",
        pathParams: { id: 1 },
      },
      { operation: "GET /products/{id}", count: 2, as: "read", pointer: "/stock", pathParams: { id: 1 } },
    ];
    expect(flags.concurrency).toEqual([
      {
        operation: "POST /orders",
        burst: 3,
        role: "user",
        body: { items: [{ productId: 1, qty: 1 }] },
        invariant: { kind: "linearizable", model: "stock" },
        mix,
      },
    ]);
    const parsed = parseBugsInput(flags);
    const t = parsed.concurrency[0];
    expect(t?.mix).toHaveLength(2);
    expect(t?.mix[0]).toMatchObject({ ...mix[0], count: 1 });
    expect(t?.mix[1]).toMatchObject({ ...mix[1], phase: "during" });
  });

  it("a single (non-array) --mix value and bodies with commas are not split", () => {
    const flags = bugsInputFromFlags({
      concurrencyTest: "POST /orders",
      mix: 'POST /orders as=take body={"a":1,"b":2}',
    });
    expect((flags.concurrency as { mix: unknown[] }[])[0]?.mix).toEqual([
      { operation: "POST /orders", as: "take", body: { a: 1, b: 2 } },
    ]);
  });

  it("--mix without --concurrency-test → SW_CONFIG_FLAG", () => {
    const e = flagError(() => bugsInputFromFlags({ mix: ["GET /products/1"] }));
    expect(e.code).toBe("SW_CONFIG_FLAG");
    expect(e.message).toMatch(/--mix require --concurrency-test/);
  });

  it("the burst + concurrent mix cap (64) is enforced by the engine schema", () => {
    const flags = bugsInputFromFlags({ concurrencyTest: ["POST /o"], burst: "60", mix: ["GET /s:5"] });
    expect(() => parseBugsInput(flags)).toThrow(/64/);
  });
});

describe("sw bugs --mix (subprocess)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-bugs-mix-"));
  mkdirSync(join(dir, ".git"));

  it("--dry-run --json shows the mix in the engine input", async () => {
    const r = await runCli(
      [
        "--dry-run",
        "bugs",
        "--target",
        "http://127.0.0.1:9",
        "--concurrency-test",
        "POST /orders",
        "--invariant",
        "linearizable:stock",
        "--mix",
        "GET /products/{id} id=7 pointer=/stock phase=before",
        "--mix",
        'PUT /products/{id}/stock:2 id=7 as=inc body={"delta": 1}',
        "--json",
      ],
      { cwd: dir, env, timeoutMs: 60_000 },
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.input.concurrency[0].mix).toEqual([
      expect.objectContaining({
        operation: "GET /products/{id}",
        as: "read",
        phase: "before",
        pointer: "/stock",
        pathParams: { id: 7 },
        count: 1,
      }),
      expect.objectContaining({
        operation: "PUT /products/{id}/stock",
        as: "inc",
        count: 2,
        phase: "during",
        body: { delta: 1 },
      }),
    ]);
  }, 60_000);

  it("bad --mix syntax and --mix without --concurrency-test exit 2", async () => {
    const bad = await runCli(
      [
        "bugs",
        "--target",
        "http://127.0.0.1:9",
        "--concurrency-test",
        "POST /orders",
        "--mix",
        "POST /orders count=2",
      ],
      { cwd: dir, env, timeoutMs: 60_000 },
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toMatch(/--mix "POST \/orders count=2": as=<take/);
    expect(bad.stderr).toMatch(/<METHOD> <path>/);
    const lone = await runCli(["bugs", "--target", "http://127.0.0.1:9", "--mix", "GET /products/1"], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    expect(lone.exitCode).toBe(2);
    expect(lone.stderr).toMatch(/require --concurrency-test/);
  }, 60_000);
});
