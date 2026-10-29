/**
 * `sw bugs` → reset → `sw replay` end to end (sw-qa repro): a concurrency finding must replay
 * from its self-contained artifact even though the config has no concurrency tests, and an
 * artifact whose check cannot be resolved must be "inconclusive" (exit 2), never "fixed" (exit 0).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../helpers/cli.js";
import { type RunningExample, startExample } from "../../helpers/examples.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let app: RunningExample;
let tmp: TmpDir;
let fp = "";
let artifactPath = "";

function findArtifact(dir: string, fingerprint: string): string {
  const root = join(dir, ".second-world", "artifacts");
  for (const run of readdirSync(root)) {
    const p = join(root, run, `bugs-${fingerprint}.json`);
    try {
      readFileSync(p);
      return p;
    } catch {
      // next run dir
    }
  }
  throw new Error(`artifact for ${fingerprint} not found`);
}

interface ReportLike {
  results?: ReportLike[];
  artifacts?: { path: string }[];
  findings?: { reproduction?: { artifacts?: string[] }; evidence?: { artifact?: string }[] }[];
}

/** Every artifact path referenced anywhere in a report (result artifacts, reproductions, evidence). */
function referencedPaths(report: ReportLike): string[] {
  const paths: string[] = [];
  for (const r of [report, ...(report.results ?? [])]) {
    for (const a of r.artifacts ?? []) paths.push(a.path);
    for (const f of r.findings ?? []) {
      paths.push(...(f.reproduction?.artifacts ?? []));
      for (const e of f.evidence ?? []) if (e.artifact) paths.push(e.artifact);
    }
  }
  return paths;
}

const reset = (): Promise<Response> => fetch(`${app.url}/__test/reset`, { method: "POST" });

beforeAll(async () => {
  app = await startExample("shop-express");
  tmp = await makeTmpDir("sw-bugs-cli-");
  writeFileSync(
    tmp.join("sw.config.json"),
    JSON.stringify({
      $schemaVersion: 1,
      targets: { api: { url: app.url } },
      // Like examples/shop-express/sw.config.ts: mutations allowed for this disposable test app.
      safety: { allowHosts: ["127.0.0.1", "localhost"], allowMutations: true },
      auth: {
        user: { type: "bearer", token: "alice-token" },
        other: { type: "bearer", token: "bob-token" },
      },
      hooks: { reset: { http: { method: "POST", url: `${app.url}/__test/reset` } } },
      bugs: { contract: resolve("examples/shop-express/openapi.yaml") },
    }),
  );
}, 30_000);

afterAll(async () => {
  await app?.close();
  await tmp?.cleanup();
});

describe("sw bugs → sw replay (concurrency finding)", () => {
  it("bugs finds the stock race (exit 1)", async () => {
    const r = await runCli(
      [
        "--yes",
        "bugs",
        "--allow-mutations",
        "--techniques",
        "concurrency",
        "--concurrency-test",
        "POST /orders",
        "--burst",
        "5",
        "--role",
        "user",
        "--body",
        '{"items":[{"productId":20,"qty":1}]}',
        "--invariant",
        "linearizable:stock:1",
        "--json",
      ],
      { cwd: tmp.path, timeoutMs: 60_000 },
    );
    expect(r.exitCode, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout) as {
      results?: { findings: { ruleId: string; fingerprint: string; classification: string }[] }[];
      findings?: { ruleId: string; fingerprint: string; classification: string }[];
    };
    const findings = report.findings ?? report.results?.flatMap((x) => x.findings) ?? [];
    const race = findings.find((f) => f.ruleId === "bugs/race-lost-update");
    expect(race?.classification).toBe("reproduced-defect");
    fp = race?.fingerprint as string;
    // Every referenced artifact (JSON + HAR) must exist after the pending dir is renamed (stdout and report.json).
    const written = JSON.parse(
      readFileSync(join(tmp.path, ".second-world", "reports", "report.json"), "utf8"),
    ) as ReportLike;
    for (const rep of [report as ReportLike, written]) {
      const paths = referencedPaths(rep);
      expect(paths.some((p) => p.endsWith(join(`bugs-${fp}`, "reproduction.har")))).toBe(true);
      expect(paths.some((p) => p.endsWith(`bugs-${fp}.json`))).toBe(true);
      for (const p of paths) {
        expect(existsSync(p), p).toBe(true);
        expect(p).not.toMatch(/pending-/);
      }
    }
    artifactPath = findArtifact(tmp.path, fp);
    const art = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      case: { context?: { concurrency?: { invariant?: unknown } } };
    };
    expect(art.case.context?.concurrency?.invariant).toEqual({
      kind: "linearizable",
      model: "stock",
      initial: 1,
      take: 1,
    });
  }, 60_000);

  it("after a reset, `sw replay` (config has no concurrency tests) still reproduces → exit 1", async () => {
    await reset();
    const r = await runCli(["replay", fp.slice(0, 8), "--runs", "3"], { cwd: tmp.path, timeoutMs: 60_000 });
    expect(r.stdout).toContain("still reproduces");
    expect(r.stdout).toContain("3/3");
    expect(r.exitCode, r.stderr).toBe(1);
  }, 60_000);

  it("an artifact whose invariant cannot be resolved is inconclusive → exit 2", async () => {
    const original = readFileSync(artifactPath, "utf8");
    const art = JSON.parse(original) as { case: { context: { concurrency: { invariant: unknown } } } };
    art.case.context.concurrency.invariant = { module: join(tmp.path, "gone", "invariant.mjs") };
    writeFileSync(artifactPath, JSON.stringify(art));
    try {
      const r = await runCli(["replay", fp, "--runs", "3", "--json"], { cwd: tmp.path, timeoutMs: 60_000 });
      const out = JSON.parse(r.stdout) as { classification: string; reason?: string };
      expect(out.classification).toBe("inconclusive");
      expect(out.reason).toMatch(/invariant cannot be loaded/);
      expect(r.exitCode).toBe(2);
    } finally {
      writeFileSync(artifactPath, original);
    }
  }, 60_000);

  it("a legacy artifact (index-only check, no embedded spec) is inconclusive → exit 2, never 0", async () => {
    const original = readFileSync(artifactPath, "utf8");
    const art = JSON.parse(original) as { case: Record<string, unknown> };
    delete art.case.context;
    writeFileSync(artifactPath, JSON.stringify(art));
    try {
      const r = await runCli(["replay", fp, "--runs", "3"], { cwd: tmp.path, timeoutMs: 60_000 });
      expect(r.stdout).toContain("inconclusive");
      expect(r.exitCode).toBe(2);
    } finally {
      writeFileSync(artifactPath, original);
    }
  }, 60_000);
});
