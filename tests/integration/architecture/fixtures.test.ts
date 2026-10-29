/** Architecture Inspector on the fixture repos in tests/fixtures/arch (known routes, edges, findings). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectArchitecture } from "../../../src/engines/architecture/index.js";

const ROOT = path.resolve("tests/fixtures/arch");

interface Expected {
  routes: string[];
  edges: [string, string, string][];
  reachability: Record<string, string[]>;
  findings: { ruleId: string; file: string; line: number }[];
}

describe.each(["express-api", "fastify-api", "nest-api"])("fixture %s", (name) => {
  it("matches expected routes, edges, reachability and findings", async () => {
    const dir = path.join(ROOT, name);
    const exp = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Expected;
    const r = await inspectArchitecture({ project: dir, noCache: true });
    const d = r.data;
    if (!d) throw new Error("no data");
    expect(d.routes.map((x) => `${x.method} ${x.path}`).sort()).toEqual(exp.routes);
    for (const [from, to, kind] of exp.edges) {
      const e = d.edges.find((x) => x.from === from && x.to === to && x.kind === kind);
      expect(e, `${from} -[${kind}]-> ${to}`).toBeDefined();
      expect(e?.evidence[0]?.file).toMatch(/^src\//);
      expect(e?.evidence[0]?.line).toBeGreaterThan(0);
      expect(e?.evidence[0]?.extractor).toBeTruthy();
    }
    for (const [route, deps] of Object.entries(exp.reachability)) expect(d.reachability[route]).toEqual(deps);
    const got = r.findings.map((f) => ({
      ruleId: f.ruleId,
      file: f.locations[0]?.file,
      line: f.locations[0]?.line,
    }));
    expect(got.sort((a, b) => `${a.ruleId}${a.file}`.localeCompare(`${b.ruleId}${b.file}`))).toEqual(
      exp.findings,
    );
    for (const f of r.findings) {
      expect(f.classification).toBe("suspected-risk");
      expect(f.evidence[0]?.kind).toBe("code");
    }
    expect(r.limitations.length).toBeGreaterThan(0);
  });
});
