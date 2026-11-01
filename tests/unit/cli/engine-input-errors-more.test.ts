/**
 * Model and What-If input errors name the key and suggest the right one (wave 7, follow-up to
 * sw-ux8's engine-input-errors): they printed `(root)` / the first issue only, with no suggestion.
 */
import { describe, expect, it } from "vitest";
import { parseExperimentInput } from "../../../src/engines/experiments/schema.js";
import { parseModelInput } from "../../../src/engines/model/build.js";

describe("engine input errors with paths and suggestions", () => {
  it("model: unknown key is model.<key> with a did-you-mean", () => {
    expect(() => parseModelInput({ projet: "." })).toThrow(
      /model\.projet: Unknown key \(did you mean "project"\?\)/,
    );
  });

  it("whatif: unknown key gets a did-you-mean", () => {
    expect(() => parseExperimentInput({ name: "x", hypothsis: "h" })).toThrow(
      /hypothsis: Unknown key \(did you mean "hypothesis"\?\)/,
    );
  });
});
