import { describe, expect, it } from "vitest";
import { parseRunSelector, resolveRunSelector } from "../../../src/cli/commands/history.js";
import { SecondWorldError } from "../../../src/core/errors.js";

describe("parseRunSelector", () => {
  it.each([
    ["01ABCDEF", { kind: "ids", ids: ["01ABCDEF"] }],
    ["a1, a2 ,a3", { kind: "ids", ids: ["a1", "a2", "a3"] }],
    ["last:5", { kind: "last", n: 5 }],
    ["label:fast", { kind: "label", label: "fast" }],
    ["label:fast:3", { kind: "label", label: "fast", n: 3 }],
    ["label:a:b", { kind: "label", label: "a:b" }],
    ["baseline:main", { kind: "baseline", name: "main" }],
  ])("%s", (raw, sel) => expect(parseRunSelector(raw)).toEqual(sel));

  it.each(["", "last:0", "last:x", "label:", "label:x:0", "baseline:"])("rejects %j (exit 2)", (raw) => {
    try {
      parseRunSelector(raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SecondWorldError);
      expect((e as SecondWorldError).exitCode).toBe(2);
    }
  });
});

describe("resolveRunSelector", () => {
  const entries = [
    { id: "r6", label: "slow", engines: ["performance"] },
    { id: "r5", label: "slow", engines: ["performance"] },
    { id: "r4", label: "fast", engines: ["performance"], compacted: true },
    { id: "r3", label: "fast", engines: ["performance"] },
    { id: "r2", label: "fast", engines: ["stress"] },
    { id: "r1", label: "fast", engines: ["performance"] },
  ];
  const calls: unknown[] = [];
  const store = {
    list: async (o: { limit?: number; label?: string; engine?: string } = {}) => {
      calls.push(o);
      return entries
        .filter((e) => (!o.label || e.label === o.label) && (!o.engine || e.engines.includes(o.engine)))
        .slice(0, o.limit ?? 1000) as never;
    },
  };

  it("ids / baseline pass through; last:N and label: query the index (compacted runs skipped)", async () => {
    expect(await resolveRunSelector(store, { kind: "ids", ids: ["x"] })).toBe("x");
    expect(await resolveRunSelector(store, { kind: "ids", ids: ["x", "y"] })).toEqual(["x", "y"]);
    expect(await resolveRunSelector(store, { kind: "baseline", name: "main" })).toBe("baseline:main");
    expect(await resolveRunSelector(store, { kind: "last", n: 2 })).toEqual(["r6", "r5"]);
    expect(await resolveRunSelector(store, { kind: "label", label: "fast" })).toEqual(["r3", "r2", "r1"]);
    expect(
      await resolveRunSelector(store, { kind: "label", label: "fast" }, { engine: "performance" }),
    ).toEqual(["r3", "r1"]);
    expect(await resolveRunSelector(store, { kind: "last", n: 3 }, { label: "fast" })).toEqual(["r3", "r2"]);
    await expect(resolveRunSelector(store, { kind: "label", label: "nope" })).rejects.toMatchObject({
      code: "SW_HISTORY_NOT_FOUND",
      exitCode: 2,
    });
  });
});
