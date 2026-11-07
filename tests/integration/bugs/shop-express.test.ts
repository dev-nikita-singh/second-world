import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/core/evidence/schemas.js";
import {
  type BugsData,
  type BugsInputLoose,
  replayFinding,
  runBugHunt,
} from "../../../src/engines/bugs/index.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { curlOnPath, runCurlLine } from "./curl-runner.js";
import { score } from "./ground-truth.js";

let app: RunningExample;
let result: EngineResult<BugsData>;
let input: BugsInputLoose;

beforeAll(async () => {
  app = await startExample("shop-express");
  input = {
    target: app.url,
    openapi: "examples/shop-express/openapi.yaml",
    seed: 42,
    allowMutations: true,
    auth: {
      roles: {
        user: { type: "bearer", token: "alice-token" },
        other: { type: "bearer", token: "bob-token" },
        admin: { type: "bearer", token: "admin-token" },
      },
    },
    hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
    concurrency: [
      {
        name: "last item sold once",
        operation: "POST /orders",
        burst: 5,
        role: "user",
        body: { items: [{ productId: 20, qty: 1 }] },
        invariant: { kind: "linearizable", model: "stock", initial: 1 },
      },
    ],
  };
  result = await runBugHunt(input, { seed: 42 });
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe("Bug Hunter vs shop-express (seeded defects)", () => {
  it("reproduces every seeded bugs defect with full precision", () => {
    const s = score("shop-express", result.findings);
    // eslint-disable-next-line no-console
    process.stderr.write(
      `[sw-bugs] shop-express recall=${s.recall.toFixed(2)} precision=${s.precision.toFixed(2)} matched=${s.matched.join(",")} missed=${s.missed.join(",")} fp=${JSON.stringify(s.falsePositives)} requests=${result.data?.requests.sent} ms=${result.data?.durationMs.toFixed(0)}\n`,
    );
    for (const f of result.findings)
      process.stderr.write(
        `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0]} :: ${f.title} x${f.occurrences}\n`,
      );
    expect(s.missed).toEqual([]);
    expect(s.falsePositives).toEqual([]);
    expect(result.status).toBe("failed");
  });

  it("replays recorded findings (sw replay) and reproduces them", async () => {
    const data = result.data as BugsData;
    for (const rule of ["bugs/bola", "bugs/race-lost-update"]) {
      const f = result.findings.find((x) => x.ruleId === rule);
      expect(f, rule).toBeDefined();
      const r = await replayFinding(
        input,
        { finding: f as NonNullable<typeof f>, data },
        { seed: 42 },
        { runs: 3 },
      );
      expect(r.classification, rule).toBe("reproduced-defect");
      expect(r.failures).toBe(r.runs);
    }
  });

  it("documented 404s are never reported and dedup counts occurrences", () => {
    const data = result.data as BugsData;
    const row = data.matrix.find((r) => r.operation === "GET /products/{id}");
    expect(row?.verdict).toBe("fail");
    const drift = result.findings.find((f) => f.ruleId === "bugs/schema-mismatch");
    expect(drift?.occurrences).toBeGreaterThan(1);
    expect(result.findings.filter((f) => f.ruleId === "bugs/schema-mismatch")).toHaveLength(1);
    expect(
      result.findings.some(
        (f) => f.ruleId === "bugs/undocumented-status" && f.classification === "reproduced-defect",
      ),
    ).toBe(false);
    // curl reproduction never contains a real token
    for (const rep of Object.values(data.reproductions))
      for (const c of rep.curl) expect(c).not.toMatch(/alice-token|bob-token|admin-token/);
  });

  it("the BOLA reproduction curl commands run for real and reproduce the status", async () => {
    const data = result.data as BugsData;
    const f = result.findings.find((x) => x.ruleId === "bugs/bola");
    const rep = data.reproductions[f?.fingerprint as string];
    expect(rep?.curl).toHaveLength(2);
    const curl = rep?.curl ?? [];
    for (const c of curl) {
      expect(c).not.toMatch(/\{\{|%7B%7B/i);
      expect(c).not.toMatch(/Bearer \$/);
    }
    // Documented convention: the env var holds the full header value.
    const env = { SW_AUTH_USER: "Bearer alice-token", SW_AUTH_OTHER: "Bearer bob-token" };
    for (const useCurl of curlOnPath() ? [true, false] : [false]) {
      await fetch(`${app.url}/__test/reset`, { method: "POST" }); // step 0: known state
      const created = await runCurlLine(curl[0] as string, env, useCurl);
      const stolen = await runCurlLine(curl[1] as string, env, useCurl);
      expect([created, stolen], useCurl ? "curl" : "undici").toEqual([201, 200]); // contract says 404 for bob
    }
  }, 60_000);
});
