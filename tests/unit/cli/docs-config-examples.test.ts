/**
 * Every configuration example in the docs must be accepted by the real loader and engine parsers
 * (wave 7: docs/08 §3 had `stress.stopWhen: { errorRate: "> 5%" }`, which the stress schema rejects).
 *
 * Blocks are found by fence (```ts / ```js) and classified:
 * - full config  (`defineConfig({...})`)            → loadConfig({ inline }) + every engine section parsed
 * - section      (`performance: {...}`, `bugs: {...}`) → merged into a minimal config, then as above
 * - engine call  (`world.performance.run({...})`)     → that engine's parse*Input
 * Anything else must be listed in SKIP with the reason, so a new example cannot slip through.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import { planWorkflow, type WorkflowStep } from "../../../src/core/orchestrator.js";
import { BUILTIN_ENGINES } from "../../../src/core/registry.js";
import {
  buildAgentInput,
  buildArchitectureInput,
  buildBugsInput,
  buildPerformanceInput,
  buildReliabilityInput,
  buildStressInput,
} from "../../../src/core/world.js";
import { parseAgentInput } from "../../../src/engines/agent/index.js";
import { parseArchitectureInput } from "../../../src/engines/architecture/index.js";
import { parseBugsInput } from "../../../src/engines/bugs/index.js";
import { checkPerformancePlan, parsePerformanceInput } from "../../../src/engines/performance/index.js";
import { checkReliabilityInput, parseReliabilityInput } from "../../../src/engines/reliability/index.js";
import { parseStressInput } from "../../../src/engines/stress/index.js";
import { REPO_ROOT } from "../../helpers/cli.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

type Obj = Record<string, unknown>;

const DOCS = [
  "docs/08-configuration.md",
  "docs/09-cli-and-api.md",
  "docs/quickstart.md",
  ...readdirSync(join(REPO_ROOT, "docs", "03-engines"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/03-engines/${f}`),
];

/** Blocks that are not configuration (or are deliberately partial), with the reason. */
const SKIP: Record<string, string> = {
  "docs/03-engines/adversarial-test-agent.md:54": "Zod schema excerpt, not a config",
  "docs/03-engines/architecture-inspector.md:77": "API call on a result graph, not a config",
  "docs/03-engines/evidence-and-history.md:9": "type definitions, not a config",
  "docs/03-engines/experiments.md:21": "illustrative experiment() sketch with `scenarios: [...]` elided",
  "docs/03-engines/system-model.md:19": "type definitions, not a config",
  "docs/09-cli-and-api.md:487": "API tour with elided inputs (`{ /* ... */ }`)",
};

interface DocBlock {
  id: string;
  lang: string;
  code: string;
}

function blocks(): DocBlock[] {
  const out: DocBlock[] = [];
  for (const file of DOCS) {
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^```(ts|js|typescript|javascript)\s*$/.exec(lines[i] as string);
      if (!m) continue;
      const start = i + 1;
      let j = start;
      while (j < lines.length && !/^```\s*$/.test(lines[j] as string)) j++;
      out.push({ id: `${file}:${i + 1}`, lang: m[1] as string, code: lines.slice(start, j).join("\n") });
      i = j;
    }
  }
  return out;
}

/** Evaluates a JS object-literal expression (docs examples are plain literals, no TS-only syntax). */
function evalExpr(expr: string): unknown {
  return new Function(`"use strict"; return (${expr});`)();
}

/** Text between the `(` at `open` and its matching `)` (string-aware enough for literals). */
function balanced(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced example");
}

type Kind =
  | { kind: "config"; config: Obj }
  | { kind: "section"; config: Obj }
  | { kind: "engine"; engine: string; input: Obj };

function classify(b: DocBlock): Kind | undefined {
  const dc = b.code.indexOf("defineConfig(");
  if (dc >= 0 && /export default/.test(b.code)) {
    return { kind: "config", config: evalExpr(balanced(b.code, dc + "defineConfig".length)) as Obj };
  }
  const run = /world\.(performance|stress|bugs|reliability|agent)\.run\(/.exec(b.code);
  if (run) {
    const open = (run.index ?? 0) + run[0].length - 1;
    return { kind: "engine", engine: run[1] as string, input: evalExpr(balanced(b.code, open)) as Obj };
  }
  const body = b.code.replace(/^\s*\/\/.*$/gm, "").trim();
  if (/^[a-zA-Z]+:\s*\{/.test(body)) return { kind: "section", config: evalExpr(`{${body}}`) as Obj };
  return undefined;
}

const BASE: Obj = {
  targets: {
    api: { url: "http://127.0.0.1:3000" },
    payments: { url: "http://127.0.0.1:4010", role: "dependency" },
  },
};
const SECRET_ENV = { SW_TEST_USER_TOKEN: "t", SW_ADMIN_ID: "i", SW_ADMIN_SECRET: "s" };
const O = { env: SECRET_ENV };

let tmp: TmpDir;
beforeAll(async () => {
  tmp = await makeTmpDir("sw-docs-ex-");
});
afterAll(() => tmp.cleanup());

/** Loads the config with the real loader and parses every engine section it has. */
async function validateConfig(config: Obj): Promise<string[]> {
  const inline: Obj = { ...BASE, ...config };
  if (inline.agent !== undefined && inline.bugs === undefined) inline.bugs = { openapi: "./openapi.yaml" };
  const cfg = await loadConfig({ cwd: tmp.path, inline, env: SECRET_ENV, userConfig: false });
  const c = cfg.config as Obj;
  const checked: string[] = [];
  if (c.performance !== undefined) {
    checkPerformancePlan(parsePerformanceInput(buildPerformanceInput(cfg, {}, O)));
    checked.push("performance");
  }
  if (c.stress !== undefined) {
    parseStressInput(buildStressInput(cfg, {}, O));
    checked.push("stress");
  }
  if (c.reliability !== undefined) {
    const deps = Object.keys(((c.reliability as Obj).dependencies as Obj | undefined) ?? {});
    const input = buildReliabilityInput(
      cfg,
      { scenario: "dependency-latency", dependency: deps[0] ?? "db" },
      O,
    );
    checkReliabilityInput(parseReliabilityInput(input));
    checked.push("reliability");
  }
  if (c.bugs !== undefined) {
    parseBugsInput(buildBugsInput(cfg, {}, O));
    checked.push("bugs");
  }
  if (c.agent !== undefined) {
    parseAgentInput(buildAgentInput(cfg, {}, O));
    checked.push("agent");
  }
  if (c.architecture !== undefined) {
    parseArchitectureInput(buildArchitectureInput(cfg));
    checked.push("architecture");
  }
  if (c.workflows !== undefined && Object.keys(c.workflows as Obj).length > 0) {
    // `sw run` checks: a valid DAG, and every step names a built-in engine.
    for (const [name, wf] of Object.entries(
      c.workflows as Record<string, { steps: Record<string, WorkflowStep> }>,
    )) {
      planWorkflow(wf.steps);
      for (const [id, st] of Object.entries(wf.steps))
        if (!(st.engine in BUILTIN_ENGINES))
          throw new Error(`workflow ${name} step ${id}: unknown engine ${st.engine}`);
    }
    checked.push("workflows");
  }
  return checked;
}

function validateEngine(engine: string, input: Obj): void {
  if (engine === "performance") checkPerformancePlan(parsePerformanceInput(input));
  else if (engine === "stress") parseStressInput(input);
  else if (engine === "bugs") parseBugsInput(input);
  else if (engine === "agent") parseAgentInput(input);
  else throw new Error(`no validator for ${engine}`);
}

const ALL = blocks();

describe("docs config examples parse with the real loader and engine schemas", () => {
  it("finds the examples (sanity) and every skipped block still exists", () => {
    expect(ALL.length).toBeGreaterThan(10);
    const ids = new Set(ALL.map((b) => b.id));
    for (const id of Object.keys(SKIP)) expect(ids.has(id), `stale SKIP entry ${id}`).toBe(true);
  });

  it.each(ALL.map((b) => [b.id, b] as const))("%s", async (id, b) => {
    if (SKIP[id]) return;
    const k = classify(b);
    expect(
      k,
      `${id}: not a recognised config example — validate it or add it to SKIP with a reason`,
    ).toBeDefined();
    if (!k) return;
    if (k.kind === "engine") validateEngine(k.engine, k.input);
    else expect((await validateConfig(k.config)).length).toBeGreaterThan(0);
  });
});
