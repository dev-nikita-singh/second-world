/**
 * `sw ui` job requests → CLI argv (src/ui/server/engines.ts). The browser is untrusted input: only the
 * whitelisted options, with checked values, may reach the command line, and nothing can become a flag.
 */
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../../../src/core/config/schema.js";
import {
  buildCommand,
  buildReplayCommand,
  engineCatalogue,
  JobRequestError,
} from "../../../../src/ui/server/engines.js";
import type { JobRequest } from "../../../../src/ui/shared/api-types.js";

const cfg = ConfigSchema.parse({
  targets: {
    api: { url: "http://127.0.0.1:3000" },
    payments: { url: "http://127.0.0.1:4010", role: "dependency" },
  },
  reliability: { dependencies: { payments: { injector: "builtin" } } },
});
const scenarios = [
  { id: "dependency-5xx", title: "Dependency returns 5xx" },
  { id: "dependency-latency", title: "Dependency latency" },
];
const G = ["--config", "/p/sw.config.ts"];
const build = (r: JobRequest) => buildCommand(r, cfg, scenarios, G);

function rejects(r: JobRequest): JobRequestError {
  try {
    build(r);
  } catch (e) {
    expect(e).toBeInstanceOf(JobRequestError);
    return e as JobRequestError;
  }
  throw new Error("expected a JobRequestError");
}

describe("engine catalogue", () => {
  it("lists every engine with options but never the CLI flags", () => {
    const cat = engineCatalogue(cfg, scenarios);
    expect(cat.map((e) => e.id)).toEqual([
      "inspect",
      "bugs",
      "perf",
      "stress",
      "reliability",
      "agent",
      "whatif",
      "model",
    ]);
    for (const e of cat) for (const o of e.options) expect(o).not.toHaveProperty("flag");
    const rel = cat.find((e) => e.id === "reliability");
    expect(rel?.needs).toEqual(["disruptive"]);
    expect(rel?.options.find((o) => o.name === "scenario")?.choiceLabels?.["dependency-5xx"]).toBe(
      "Dependency returns 5xx",
    );
    expect(rel?.options.find((o) => o.name === "dependency")?.choices).toEqual(["payments"]);
    // What-If needs experiments in the config.
    expect(cat.find((e) => e.id === "whatif")).toMatchObject({ configured: false });
  });

  it("offers the config's targets", () => {
    const perf = engineCatalogue(cfg, scenarios).find((e) => e.id === "perf");
    expect(perf?.options.find((o) => o.name === "target")?.choices).toEqual(["api", "payments"]);
  });
});

describe("buildCommand", () => {
  it("builds the same argv a user would type", () => {
    expect(build({ engine: "inspect" }).args).toEqual([...G, "inspect"]);
    expect(build({ engine: "perf", options: { rate: 50, duration: "20s", model: "open" } }).args).toEqual([
      ...G,
      "perf",
      "--model",
      "open",
      "--rate",
      "50",
      "--duration",
      "20s",
    ]);
    expect(build({ engine: "bugs", options: { techniques: ["auth", "contract", "auth"] } }).args).toEqual([
      ...G,
      "bugs",
      "--techniques",
      "auth,contract",
    ]);
    expect(build({ engine: "agent", options: { time: "60s", requests: 500 } }).args).toEqual([
      ...G,
      "agent",
      "--budget",
      "time=60s,requests=500",
    ]);
    expect(build({ engine: "model", options: { noArchitecture: true } }).args).toEqual([
      ...G,
      "model",
      "build",
      "--no-architecture",
    ]);
    expect(build({ engine: "perf", dryRun: true, label: "before-fix" }).args).toEqual([
      ...G,
      "--label",
      "before-fix",
      "--dry-run",
      "perf",
    ]);
  });

  it("empty values and false booleans mean 'use the config'", () => {
    expect(build({ engine: "perf", options: { rate: "", duration: null, warmup: undefined } }).args).toEqual([
      ...G,
      "perf",
    ]);
    expect(build({ engine: "bugs", options: { allowMutations: false, techniques: [] } }).args).toEqual([
      ...G,
      "bugs",
    ]);
  });

  it("puts the reliability scenario as the positional argument", () => {
    const b = build({
      engine: "reliability",
      options: { scenario: "dependency-5xx", repeat: 2 },
      confirm: { disruptive: true },
    });
    expect(b.args).toEqual([
      ...G,
      "--approve-disruptive",
      "reliability",
      "run",
      "dependency-5xx",
      "--repeat",
      "2",
    ]);
    expect(b.display).toBe(
      "sw --config /p/sw.config.ts --approve-disruptive reliability run dependency-5xx --repeat 2",
    );
  });

  it("refuses unknown engines and unknown options", () => {
    expect(rejects({ engine: "evolve" as never }).message).toMatch(/Unknown test type/);
    expect(rejects({ engine: "perf", options: { exec: "calc" } }).issues).toEqual([
      "exec: unknown option for Load test",
    ]);
    expect(rejects({ engine: "perf", options: [] as never }).message).toMatch(/object/);
  });

  it("no value can become a flag, a second argument or a shell construct", () => {
    const attempts: Array<[string, unknown]> = [
      ["duration", "--target=http://evil"],
      ["duration", "10s --target http://evil"],
      ["workers", "-1"],
      ["workers", "auto; calc"],
      ["workers", "a b"],
      ["workers", "$(calc)"],
      ["workers", "`calc`"],
      ["model", "open --yes"],
      ["rate", "50 --yes"],
      ["rate", "-5"],
      ["target", "http://evil.example"],
    ];
    for (const [k, v] of attempts) {
      const e = rejects({ engine: "perf", options: { [k]: v } });
      expect(e.code, `${k}=${String(v)}`).toBe("BAD_REQUEST");
    }
    expect(rejects({ engine: "bugs", options: { techniques: ["contract", "--yes"] } }).code).toBe(
      "BAD_REQUEST",
    );
    expect(rejects({ engine: "perf", label: "x --yes" }).code).toBe("BAD_REQUEST");
    expect(rejects({ engine: "perf", label: "-x" }).code).toBe("BAD_REQUEST");
  });

  it("checks ranges, durations and choices", () => {
    expect(rejects({ engine: "perf", options: { rate: 0 } }).issues[0]).toMatch(/≥ 1/);
    expect(rejects({ engine: "perf", options: { rate: 1e9 } }).issues[0]).toMatch(/≤/);
    expect(rejects({ engine: "perf", options: { duration: "20 seconds" } }).issues[0]).toMatch(/duration/);
    expect(rejects({ engine: "perf", options: { model: "turbo" } }).issues[0]).toMatch(/one of/);
    expect(rejects({ engine: "reliability", options: {}, confirm: { disruptive: true } }).issues).toEqual([
      "Failure: required",
    ]);
  });

  it("needs a confirmation for disruptive engines and for mutating options (not for dry runs)", () => {
    const e1 = rejects({ engine: "reliability", options: { scenario: "dependency-5xx" } });
    expect(e1.code).toBe("CONFIRM_REQUIRED");
    expect(e1.needs).toEqual(["disruptive"]);
    const e2 = rejects({ engine: "bugs", options: { allowMutations: true } });
    expect(e2.needs).toEqual(["mutations"]);
    expect(
      build({ engine: "bugs", options: { allowMutations: true }, confirm: { mutations: true } }).args,
    ).toEqual([...G, "--yes", "bugs", "--allow-mutations"]);
    // A dry run sends nothing: no confirmation needed, and none is passed on.
    expect(
      build({ engine: "reliability", options: { scenario: "dependency-5xx" }, dryRun: true }).args,
    ).toEqual([...G, "--dry-run", "reliability", "run", "dependency-5xx"]);
    // A confirmation the request doesn't need is not passed on.
    expect(build({ engine: "inspect", confirm: { mutations: true, disruptive: true } }).args).toEqual([
      ...G,
      "inspect",
    ]);
  });
});

describe("buildReplayCommand", () => {
  it("accepts a fingerprint and nothing else", () => {
    expect(buildReplayCommand("3227e752cfdfcb3c", G).args).toEqual([...G, "replay", "3227e752cfdfcb3c"]);
    for (const bad of ["--yes", "abc", "3227e752 --yes", "../../x", ""])
      expect(() => buildReplayCommand(bad, G), bad).toThrow(JobRequestError);
  });
});
