// Fixture plugin "@acme/sw-extras" (docs/10-plugins-and-extensibility.md): one contribution per
// supported 0.x extension point. Plain ESM without imports, as a published plugin could be.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal HistoryStore persisted to <dir>/memory-store.json (enough for world.history.*). */
function fileStore(dir) {
  const file = join(dir, "memory-store.json");
  const load = () =>
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { runs: [], baselines: {} };
  const save = (db) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(db));
  };
  const entry = (r) => ({ v: 1, id: r.id, createdAt: r.createdAt, engines: r.engines, status: r.status });
  return {
    backend: "acme/file",
    dir,
    async append(input) {
      const db = load();
      const id = input.id ?? `run-${db.runs.length + 1}`;
      const run = {
        schemaVersion: 1,
        id,
        createdAt: "2026-11-04T00:00:00.000Z",
        engines: [...new Set(input.results.map((r) => r.engine))],
        status: "passed",
        tags: input.tags ?? [],
        results: input.results,
      };
      db.runs.unshift(run);
      save(db);
      return entry(run);
    },
    async get(id) {
      return load().runs.find((r) => r.id === id) ?? null;
    },
    async list() {
      return load().runs.map(entry);
    },
    async query(f) {
      const all = load().runs.map(entry);
      return typeof f === "function" ? all.filter(f) : all;
    },
    async setBaseline(name, runId) {
      const db = load();
      db.baselines[name] = runId;
      save(db);
      return { name, runId };
    },
    async getBaseline(name) {
      const db = load();
      return db.runs.find((r) => r.id === db.baselines[name]) ?? null;
    },
    async listBaselines() {
      return Object.entries(load().baselines).map(([name, runId]) => ({ name, runId }));
    },
    async diff() {
      throw new Error("diff not implemented by the fixture store");
    },
    async trend() {
      throw new Error("trend not implemented by the fixture store");
    },
    async verify() {
      return { ok: true, checked: load().runs.length, errors: [], warnings: [] };
    },
    async prune() {
      return { kept: load().runs.length, compacted: 0, removed: 0 };
    },
  };
}

export default {
  name: "@acme/sw-extras",
  version: "1.2.3",
  apiVersion: 1,
  description: "fixture: reporter, rule, assertion, history store, hooks",
  setup(api) {
    const hookLog = typeof api.options.hookLog === "string" ? api.options.hookLog : undefined;
    const record = (event) => (payload) => {
      if (!hookLog) return;
      const line = { event, engine: payload.engine };
      if (event === "finding.created") line.ruleId = payload.finding.ruleId;
      if (event === "run.completed") line.status = payload.result.status;
      appendFileSync(hookLog, `${JSON.stringify(line)}\n`);
    };
    for (const e of [
      "config.resolved",
      "run.started",
      "engine.started",
      "finding.created",
      "run.completed",
      "run.failed",
    ])
      api.hooks.on(e, record(e));

    api.registerReporter("summary", {
      extension: ".summary.txt",
      render(report) {
        const lines = [
          `verdict: ${report.verdict.passed ? "passed" : "failed"}`,
          `results: ${report.results.length}`,
        ];
        for (const r of report.results) for (const f of r.findings) lines.push(`- ${f.ruleId}: ${f.title}`);
        return `${lines.join("\n")}\n`;
      },
    });

    // Architecture rule (ArchRule shape) with a bare id: registered as "acme/no-legacy-files".
    api.registerRule({
      meta: {
        id: "no-legacy-files",
        title: "Legacy file still present",
        severity: "low",
        category: "architecture",
        defaultLevel: "warn",
        docs: "https://acme.example/rules/no-legacy-files",
        fix: "Delete or migrate the legacy module",
      },
      check(ctx) {
        return ctx.facts
          .filter((f) => /legacy/i.test(f.file))
          .map((f) => ({
            ruleId: "no-legacy-files",
            message: `${f.file} is a legacy module`,
            file: f.file,
            line: 1,
            symbol: "<module>",
            snippet: f.file,
            confidence: 1,
          }));
      },
    });

    // Bug Hunter assertion: the JSON array body is sorted by args.key (ascending).
    api.registerAssertion("sorted-by", (res, args) => {
      if (!Array.isArray(res.body)) return true;
      const key = String(args.key ?? "id");
      for (let i = 1; i < res.body.length; i++)
        if (res.body[i - 1][key] > res.body[i][key]) return `items are not sorted by ${key} (index ${i})`;
      return true;
    });

    api.registerHistoryStore("file", (ctx) => fileStore(ctx.dir));
  },
};
