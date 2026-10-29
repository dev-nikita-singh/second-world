import { describe, expect, it } from "vitest";
import { combineConfidence, DEFAULT_CONFIDENCE, noisyOr } from "../../../src/engines/model/confidence.js";
import { jaro, jaroWinkler, normalizeName, stem } from "../../../src/engines/model/similarity.js";
import type { ModelEvidence, SourceKind } from "../../../src/engines/model/types.js";

describe("Jaro-Winkler", () => {
  it("matches known reference values", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("DWAYNE", "DUANE")).toBeCloseTo(0.84, 3);
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.813, 3);
    expect(jaro("MARTHA", "MARHTA")).toBeCloseTo(0.944, 3);
    expect(jaro("CRATE", "TRACE")).toBeCloseTo(0.733, 3);
  });
  it("handles identical, empty and disjoint strings", () => {
    expect(jaroWinkler("payments", "payments")).toBe(1);
    expect(jaroWinkler("", "")).toBe(1);
    expect(jaroWinkler("abc", "")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
  it("is symmetric", () => {
    for (const [a, b] of [
      ["payment", "payments"],
      ["orders", "order-svc"],
      ["inventory", "invoice"],
    ] as const)
      expect(jaroWinkler(a, b)).toBeCloseTo(jaroWinkler(b, a), 12);
  });
  it("puts payment/payments above the 0.92 threshold and inventory/invoice below", () => {
    expect(jaroWinkler("payment", "payments")).toBeGreaterThanOrEqual(0.92);
    expect(jaroWinkler("inventory", "invoice")).toBeLessThan(0.92);
  });
});

describe("normalizeName", () => {
  it("strips generic words, env suffixes and separators", () => {
    expect(normalizeName("PaymentClient")).toBe("payment");
    expect(normalizeName("payments-svc")).toBe("payments");
    expect(normalizeName("PAYMENTS_URL")).toBe("payments");
    expect(normalizeName("OrderService")).toBe("order");
    expect(normalizeName("orders_api_base_url")).toBe("orders");
    expect(normalizeName("user-profile-service")).toBe("userprofile");
    expect(normalizeName("Service")).toBe("service");
  });
  it("stem folds simple plurals", () => {
    expect(stem("payments")).toBe("payment");
    expect(stem("categories")).toBe("category");
    expect(stem("address")).toBe("address");
  });
});

const ev = (source: SourceKind, confidence = DEFAULT_CONFIDENCE[source]): ModelEvidence => ({
  source,
  confidence,
  origin: "x",
  detail: "d",
});

describe("confidence", () => {
  it("noisy-OR", () => {
    expect(noisyOr([])).toBe(0);
    expect(noisyOr([0.5, 0.5])).toBeCloseTo(0.75, 12);
    expect(noisyOr([0.8, 0.75])).toBeCloseTo(0.95, 12);
  });
  it("combines independent families, best value per family", () => {
    // Twenty static call sites are not twenty independent sources.
    const many = Array.from({ length: 20 }, () => ev("static"));
    expect(combineConfidence(many).confidence).toBe(0.75);
    // static + static-heuristic are one family.
    expect(combineConfidence([ev("static"), ev("static-heuristic")]).confidence).toBe(0.75);
    expect(combineConfidence([ev("static"), ev("config")]).confidence).toBe(0.95);
    expect(combineConfidence([ev("trace"), ev("openapi"), ev("static")]).confidence).toBe(0.998);
  });
  it("is plain noisy-OR per family; no evidence gives 0", () => {
    expect(combineConfidence([]).confidence).toBe(0);
    expect(combineConfidence([ev("static-heuristic")]).confidence).toBe(0.5);
    expect(combineConfidence([ev("static-heuristic"), ev("config")]).confidence).toBe(0.9);
    expect(Object.keys(combineConfidence([ev("trace")]))).toEqual(["confidence"]);
  });
  it("applies a fuzzy-merge multiplier", () => {
    expect(combineConfidence([ev("trace")], 0.6).confidence).toBe(0.57);
  });
});
