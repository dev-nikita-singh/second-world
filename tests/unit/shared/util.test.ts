import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backoff, backoffCeiling } from "../../../src/shared/util/backoff.js";
import { fingerprint } from "../../../src/shared/util/fingerprint.js";
import { fnv1a, fnv1aHex, sha256 } from "../../../src/shared/util/hash.js";
import { createUlidFactory, isUlid, ulid, ulidTime } from "../../../src/shared/util/ulid.js";
import { seeded } from "./_rng.js";

describe("hash", () => {
  it("sha256 known vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"));
  });

  it("fnv1a known vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
    expect(fnv1aHex("")).toBe("811c9dc5");
  });

  it("fnv1a hashes the UTF-8 bytes (matches a byte-level reference)", () => {
    const ref = (s: string): number => {
      let h = 0x811c9dc5;
      for (const b of Buffer.from(s, "utf8")) h = Math.imul(h ^ b, 0x01000193);
      return h >>> 0;
    };
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        expect(fnv1a(s)).toBe(ref(s));
      }),
    );
  });
});

describe("fingerprint", () => {
  it("is 16 hex chars, stable and normalised", () => {
    const f = fingerprint(["GET", "/users/:id", "500"]);
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint([" get ", "/users/:id", 500])).toBe(f);
    expect(fingerprint(["GET", "/users/:id", "404"])).not.toBe(f);
  });

  it("separator cannot be forged", () => {
    expect(fingerprint(["a|b"])).not.toBe(fingerprint(["a", "b"]));
    expect(fingerprint([null, undefined])).toBe(fingerprint(["", ""]));
  });
});

describe("backoff", () => {
  it("full jitter stays within [0, min(cap, base·2^attempt))", () => {
    const rng = seeded(3);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), fc.integer({ min: 1, max: 1000 }), (attempt, base) => {
        const cap = 30_000;
        const d = backoff({ base, cap, attempt, rng });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(Math.min(cap, base * 2 ** Math.min(attempt, 60)) + 1e-9);
      }),
    );
    expect(backoffCeiling(100, 10_000, 0)).toBe(100);
    expect(backoffCeiling(100, 10_000, 3)).toBe(800);
    expect(backoffCeiling(100, 10_000, 30)).toBe(10_000);
    expect(backoffCeiling(100, 10_000, 5000)).toBe(10_000);
  });
});

describe("ulid", () => {
  it("valid, sortable and monotonic within a millisecond", () => {
    const ids = Array.from({ length: 100 }, () => ulid(1_700_000_000_000));
    for (const id of ids) expect(isUlid(id)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(100);
    expect(ulidTime(ids[0] as string)).toBe(1_700_000_000_000);
  });

  it("deterministic with an injected prng", () => {
    const a = createUlidFactory(seeded(9));
    const b = createUlidFactory(seeded(9));
    expect(a(1_700_000_000_000)).toBe(b(1_700_000_000_000));
  });
});
