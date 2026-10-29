import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { suggestedTest } from "../../../src/engines/agent/export.js";
import { type AgentData, runAgent, type SuggestedTest } from "../../../src/engines/agent/index.js";
import { parseScenario, type Scenario } from "../../../src/engines/agent/scenario.js";
import { BASE_INPUT, MiniShop, mockOpenSession, ROLES } from "./mock-session.js";

function syntaxErrors(text: string): string[] {
  const sf = ts.createSourceFile("suggested.test.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** Transpiles a suggested Vitest file and runs it with real `expect`; resolves to the first failure or null. */
async function runSuggested(text: string): Promise<Error | null> {
  const body = text
    .replace(/^import .*from "vitest";$/m, "")
    .replace(/^import \{ randomUUID \} from "node:crypto";$/m, "");
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const tests: (() => Promise<void>)[] = [];
  const describeFn = (_n: string, fn: () => void): void => fn();
  const itFn = (_n: string, fn: () => Promise<void>): void => {
    tests.push(fn);
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...a: string[]
  ) => (...x: unknown[]) => Promise<void>;
  await new AsyncFunction("describe", "it", "expect", "randomUUID", "process", js)(
    describeFn,
    itFn,
    expect,
    randomUUID,
    process,
  );
  expect(tests).toHaveLength(1);
  try {
    await (tests[0] as () => Promise<void>)();
    return null;
  } catch (e) {
    return e as Error;
  }
}

let defective: { app: MiniShop; server: Server; url: string };
let data: AgentData;

async function serve(app: MiniShop): Promise<{ app: MiniShop; server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") h[k] = v;
      const r = app.handle(
        req.method ?? "GET",
        new URL(req.url ?? "/", "http://127.0.0.1"),
        h,
        Buffer.concat(chunks).toString("utf8") || undefined,
      );
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.json === undefined ? "" : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { app, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  defective = await serve(new MiniShop(false));
  const r = await runAgent(
    { ...BASE_INPUT, target: defective.url, budget: { maxRequests: 400, maxIterations: 80, patience: 40 } },
    { seed: 5 },
    { openSession: mockOpenSession(new MiniShop(false)) },
  );
  data = r.data as AgentData;
  process.env.SW_AUTH_USER = "t1";
  process.env.SW_AUTH_OTHER = "t2";
  process.env.SW_AUTH_ADMIN = "t3";
});

afterAll(async () => {
  await new Promise((ok) => defective.server.close(ok));
  delete process.env.SW_TARGET;
});

describe("suggested-test export", () => {
  it("emits one syntactically valid Vitest file and config snippet per confirmed defect", () => {
    expect(data.suggestedTests.length).toBeGreaterThanOrEqual(3);
    for (const t of data.suggestedTests) {
      expect(syntaxErrors(t.vitest), t.filename).toEqual([]);
      expect(syntaxErrors(`const cfg = { ${t.config} };`), `${t.filename} config`).toEqual([]);
      expect(t.filename).toMatch(/^agent-[a-z0-9-]+\.test\.ts$/);
      expect(t.vitest).toContain('from "vitest"');
      expect(t.vitest).toContain("SW_AUTH_");
    }
  });

  it("the emitted tests reproduce the defect and pass once it is fixed", async () => {
    const fixed = await serve(new MiniShop(true));
    try {
      for (const t of data.suggestedTests as SuggestedTest[]) {
        process.env.SW_TARGET = defective.url;
        defective.app.reset();
        const onDefective = await runSuggested(t.vitest);
        expect(onDefective, `${t.filename} should fail on the defective app`).not.toBeNull();
        expect(onDefective?.message).not.toMatch(/precondition|Set SW_AUTH/);
        process.env.SW_TARGET = fixed.url;
        fixed.app.reset();
        const onFixed = await runSuggested(t.vitest);
        expect(onFixed?.message ?? null, `${t.filename} should pass on the fixed app`).toBeNull();
      }
    } finally {
      await new Promise((ok) => fixed.server.close(ok));
    }
  });

  it("embeds hostile strings as data, never as code", () => {
    const raw = {
      title: 'x"); process.exit(1); ("',
      hypothesis: `*/ throw new Error('boom') /* \`$\{process.exit()}\``,
      steps: [{ operation: "GET /items", query: { q: '"]}); process.exit(1); //' } }],
      assertions: [{ kind: "json", step: 0, pointer: '/a"b', equals: `\`$\{x}\`` }],
      expectedClassification: "defect",
    };
    const p = parseScenario(raw);
    expect(p.ok).toBe(true);
    const t = suggestedTest((p as { scenario: Scenario }).scenario, {
      fingerprint: "f",
      ruleId: "agent/assertion-failed",
      operation: "GET /items",
      target: "http://127.0.0.1:1",
      roles: [null],
      requests: [{ method: "GET", path: "/items" }],
      credentials: ROLES,
    });
    expect(syntaxErrors(t.vitest)).toEqual([]);
    const sf = ts.createSourceFile("t.ts", t.vitest, ts.ScriptTarget.ES2022, true);
    // No call to process.exit anywhere in the AST: hostile text only appears inside string literals.
    let calls = 0;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText(sf).includes("exit")) calls++;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(calls).toBe(0);
    expect(t.vitest).not.toContain('"t1"');
  });
});
