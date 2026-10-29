/**
 * Mixed-operation linearizability (docs/04-data-structures-and-algorithms.md §7.5) against the
 * example apps: concurrent POST /orders (take) interleaved with GET /products/{id} (read stock).
 * shop-express has the planted stock-race (check-then-await-then-write in reserve());
 * shop-fastify decrements atomically and must not be reported.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import {
  type BugsData,
  type BugsInputLoose,
  replayFinding,
  runBugHunt,
} from "../../../src/engines/bugs/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { score } from "./ground-truth.js";
import { validateHar12 } from "./har-validate.js";

const roles = {
  user: { type: "bearer" as const, token: "alice-token" },
  other: { type: "bearer" as const, token: "bob-token" },
  admin: { type: "bearer" as const, token: "admin-token" },
};

const reads = (id: number) => {
  const r = { operation: "GET /products/{id}", pathParams: { id }, as: "read" as const, pointer: "/stock" };
  return [
    { ...r, phase: "before" as const },
    { ...r, count: 2 },
    { ...r, phase: "after" as const },
  ];
};

describe("mixed-operation race detection: shop-express (planted stock-race)", () => {
  let app: RunningExample;
  let input: BugsInputLoose;
  let result: EngineResult<BugsData>;
  const artifactsDir = mkdtempSync(join(tmpdir(), "sw-bugs-har-"));

  beforeAll(async () => {
    app = await startExample("shop-express");
    input = {
      artifactsDir,
      target: app.url,
      openapi: "examples/shop-express/openapi.yaml",
      seed: 42,
      techniques: ["concurrency"],
      allowMutations: true,
      auth: { roles },
      hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
      concurrency: [
        {
          // The planted scenario: product 20 has stock 1. Initial stock comes from the "before" read.
          name: "last item: orders vs stock reads",
          operation: "POST /orders",
          burst: 5,
          role: "user",
          body: { items: [{ productId: 20, qty: 1 }] },
          mix: reads(20),
          invariant: { kind: "linearizable", model: "stock" },
        },
        {
          // Plenty of stock: every order succeeds, so only the reads reveal the lost update.
          name: "lost update: orders vs stock reads",
          operation: "POST /orders",
          burst: 3,
          role: "user",
          body: { items: [{ productId: 1, qty: 1 }] },
          mix: reads(1),
          invariant: { kind: "linearizable", model: "stock" },
        },
        {
          // Control: the same burst without reads is linearizable (all takes can succeed).
          name: "takes only",
          operation: "POST /orders",
          burst: 3,
          role: "user",
          body: { items: [{ productId: 2, qty: 1 }] },
          invariant: { kind: "linearizable", model: "stock", initial: 100 },
        },
      ],
    };
    result = await runBugHunt(input, { seed: 42 });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("finds the planted stock race as a reproduced defect, with no false positives", () => {
    const races = result.findings.filter((f) => f.ruleId === "bugs/race-lost-update");
    for (const f of result.findings)
      process.stderr.write(`  ${f.classification} ${f.ruleId} ${f.affected[0]} :: ${f.title}\n`);
    expect(races.length).toBe(2);
    for (const f of races) {
      expect(f.classification).toBe("reproduced-defect");
      expect(f.affected[0]).toBe("POST /orders");
    }
    const s = score("shop-express", result.findings);
    expect(s.matched).toContain("stock-race");
    expect(s.falsePositives).toEqual([]);
    const summaries = result.data?.findings ?? [];
    expect(summaries.some((x) => /takes only/.test(x.title))).toBe(false);
  });

  it("the violation shows the impossible mixed history and the curl reproduction includes the reads", () => {
    const data = result.data as BugsData;
    const lost = Object.values(data.reproductions).find((r) => /lost update/.test(r.case.label));
    expect(lost).toBeDefined();
    expect(lost?.message).toMatch(/mixed operations/);
    expect(lost?.message).toMatch(/take→ok\(201\)/);
    expect(lost?.message).toMatch(/read→\d+/);
    const curl = lost?.curl ?? [];
    expect(curl[0]).toMatch(/GET .*\/products\/1'/);
    expect(curl[1]).toMatch(/for i in \$\(seq 1 3\).*POST.*for j in \$\(seq 1 2\).*GET.*wait$/);
    expect(curl[2]).toMatch(/GET .*\/products\/1'/);
    for (const c of curl) expect(c).not.toMatch(/alice-token|bob-token|admin-token/);
  });

  it("writes reproduction.har (HAR 1.2, placeholders, no secrets) next to each JSON artifact", () => {
    const data = result.data as BugsData;
    const fps = Object.keys(data.reproductions);
    expect(fps.length).toBeGreaterThan(0);
    for (const fp of fps) {
      expect(existsSync(join(artifactsDir, `bugs-${fp}.json`))).toBe(true);
      const p = join(artifactsDir, `bugs-${fp}`, "reproduction.har");
      expect(result.artifacts.map((a) => a.path)).toContain(p);
      const text = readFileSync(p, "utf8");
      const har = JSON.parse(text);
      expect(validateHar12(har)).toEqual([]);
      expect(text).not.toMatch(/alice-token|bob-token|admin-token|Bearer /);
      const entries = har.log.entries as {
        request: { method: string; url: string; headers: { name: string; value: string }[] };
      }[];
      // before read + 5 or 3 orders + 2 concurrent reads + after read
      expect(entries.length).toBeGreaterThanOrEqual(7);
      const post = entries.find((e) => e.request.method === "POST");
      expect(post?.request.headers.find((h) => h.name === "authorization")?.value).toBe("$SW_AUTH_USER");
      expect(entries.some((e) => e.request.method === "GET" && /\/products\/\d+$/.test(e.request.url))).toBe(
        true,
      );
    }
  });

  it("sw replay reproduces the mixed-operation finding from its artifact", async () => {
    const data = result.data as BugsData;
    const f = result.findings.find((x) => x.ruleId === "bugs/race-lost-update");
    const r = await replayFinding(
      input,
      { finding: f as NonNullable<typeof f>, data },
      { seed: 42 },
      { runs: 3 },
    );
    expect(r.classification).toBe("reproduced-defect");
  });
});

describe("mixed-operation race detection: shop-fastify (atomic decrement, precision)", () => {
  let app: RunningExample;
  afterAll(async () => {
    await app?.close();
  });

  it("does not report a race on a correct implementation", async () => {
    app = await startExample("shop-fastify");
    const result = await runBugHunt(
      {
        target: app.url,
        openapi: "examples/shop-fastify/openapi.yaml",
        seed: 42,
        techniques: ["concurrency"],
        allowMutations: true,
        auth: { roles },
        hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
        concurrency: [
          {
            name: "orders vs stock reads",
            operation: "POST /orders",
            burst: 5,
            role: "user",
            body: { productId: 3, qty: 1 },
            mix: reads(3),
            invariant: { kind: "linearizable", model: "stock" },
          },
          {
            name: "last item: orders vs stock reads",
            operation: "POST /orders",
            burst: 5,
            role: "user",
            body: { productId: 40, qty: 1 },
            mix: reads(40),
            invariant: { kind: "linearizable", model: "stock" },
          },
        ],
      },
      { seed: 42 },
    );
    expect(result.findings.filter((f) => f.ruleId === "bugs/race-lost-update")).toEqual([]);
  }, 60_000);
});
