/**
 * Scenario-level `auth` (docs/08-configuration.md §3): role name resolved by the world, or a resolved
 * credential object. Overrides section auth for that scenario; explicit step headers still win.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/core/config/loader.js";
import { ConfigError } from "../../../src/core/errors.js";
import { buildPerformanceInput, buildStressInput } from "../../../src/core/world.js";
import { parsePerformanceInput } from "../../../src/engines/performance/index.js";
import { compilePlan } from "../../../src/engines/performance/prepare.js";
import { PerformanceInputSchema } from "../../../src/engines/performance/schema.js";

function headerOf(flat: string[], name: string): string | undefined {
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] === name) return flat[i + 1];
  return undefined;
}

describe("scenario auth: schema + prepare", () => {
  it("schema accepts a role name or a credential object on a scenario", () => {
    const v = PerformanceInputSchema.parse({
      target: "http://127.0.0.1:1",
      scenarios: [
        { name: "a", auth: "user", steps: [{ path: "/" }] },
        { name: "b", auth: { type: "bearer", token: "T" }, steps: [{ path: "/" }] },
      ],
    });
    expect(v.scenarios[0]?.auth).toBe("user");
    expect(v.scenarios[1]?.auth).toEqual({ type: "bearer", token: "T" });
    expect(() =>
      parsePerformanceInput({
        target: "http://127.0.0.1:1",
        scenarios: [{ name: "a", auth: { type: "bogus" }, steps: [{ path: "/" }] }],
      }),
    ).toThrow(ConfigError);
  });

  it("scenario auth overrides section auth per scenario; step headers win", () => {
    const plan = compilePlan(
      PerformanceInputSchema.parse({
        target: "http://127.0.0.1:1",
        auth: { type: "bearer", token: "SECTION" },
        scenarios: [
          { name: "browse", steps: [{ path: "/p" }] },
          { name: "checkout", auth: { type: "bearer", token: "USER" }, steps: [{ path: "/c" }] },
          {
            name: "custom",
            auth: { type: "basic", username: "u", password: "p" },
            steps: [{ path: "/x", headers: { Authorization: "Bearer STEP" } }],
          },
        ],
      }),
    );
    const [browse, checkout, custom] = plan.scenarios;
    expect(headerOf(browse?.steps[0]?.staticHeaders ?? [], "authorization")).toBe("Bearer SECTION");
    expect(headerOf(checkout?.steps[0]?.staticHeaders ?? [], "authorization")).toBe("Bearer USER");
    expect(headerOf(custom?.steps[0]?.staticHeaders ?? [], "authorization")).toBe("Bearer STEP");
  });

  it("an unresolved role name reaching the engine is a clear ConfigError", () => {
    const input = PerformanceInputSchema.parse({
      target: "http://127.0.0.1:1",
      scenarios: [{ name: "checkout", auth: "user", steps: [{ path: "/" }] }],
    });
    expect(() => compilePlan(input)).toThrow(/scenario "checkout" auth: role "user" was not resolved/);
  });
});

describe("scenario auth: world resolution", () => {
  async function cfg() {
    return loadConfig({
      configFile: false,
      userConfig: false,
      inline: {
        targets: { api: { url: "http://127.0.0.1:3000" } },
        auth: { user: { type: "bearer", token: { env: "SW_TEST_SCN_TOKEN" } } },
        performance: {
          target: "api",
          rate: 10,
          scenarios: [
            { name: "browse", steps: [{ path: "/p" }] },
            { name: "checkout", auth: "user", steps: [{ path: "/c" }] },
          ],
        },
      },
      env: { SW_TEST_SCN_TOKEN: "secret-123" },
    });
  }

  it("buildPerformanceInput resolves scenario role names (secrets resolved) and the input validates", async () => {
    const c = await cfg();
    const input = buildPerformanceInput(c, {}, { env: { SW_TEST_SCN_TOKEN: "secret-123" } });
    const parsed = parsePerformanceInput(input);
    expect(parsed.scenarios[1]?.auth).toEqual({ type: "bearer", token: "secret-123" });
    expect(parsed.scenarios[0]?.auth).toBeUndefined();
    // stress inherits perf scenarios and resolves them the same way
    const stress = buildStressInput(c, {}, { env: { SW_TEST_SCN_TOKEN: "secret-123" } });
    expect((stress.scenarios as { auth?: unknown }[])[1]?.auth).toEqual({
      type: "bearer",
      token: "secret-123",
    });
  });

  it("an unknown scenario role gives ConfigError SW_CONFIG_AUTH with the path", async () => {
    const c = await cfg();
    try {
      buildPerformanceInput(c, {
        scenarios: [{ name: "x", auth: "nobody", steps: [{ path: "/" }] }],
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe("SW_CONFIG_AUTH");
      expect((e as Error).message).toMatch(
        /performance\.scenarios\.0\.auth "nobody" is not defined in config\.auth/,
      );
    }
  });
});
