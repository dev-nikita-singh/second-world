/**
 * Property-based fuzzing of the Safety Guard (docs/11 §1–2, threat model T1–T4).
 *
 * Property: a host that is not loopback and not on safety.allowHosts is never allowed — whatever
 * spelling the URL uses. Every URL is generated as an *encoding* of a ground-truth address (IPv4 as
 * a uint32, IPv6 as 16 bytes) and the decision is checked against an independent oracle written in
 * this file (it does not reuse guard.ts helpers). Forms: decimal/octal/hex/short IPv4, %-encoding,
 * fullwidth digits and ideographic dots, IPv4-mapped/compatible/NAT64/6to4 IPv6, zone ids,
 * userinfo decoys, `\@` and `#@` tricks, trailing dots, IDN, mixed case; redirects; DNS answers
 * (pinning) and DNS rebinding.
 *
 * Seeds are fixed so a failure is reproducible; bump NUM_RUNS locally for a longer fuzz.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSafetyGuard, type ResolvedAddress } from "../../../src/core/safety/guard.js";

const NUM_RUNS = Number(process.env.SW_FUZZ_RUNS ?? 2000);
const SEED = process.env.SW_FUZZ_SEED ? Number(process.env.SW_FUZZ_SEED) : 0x5ec_0008;

// ------------------------------------------------------------------ oracle (independent of guard.ts)

/** 16 bytes of an IPv6 literal (no brackets, no zone) or null. Written from RFC 4291 §2.2. */
function v6Bytes(s: string): number[] | null {
  let text = s.toLowerCase();
  let tail: number[] = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    tail = v4.slice(1).map(Number);
    if (tail.some((x) => x > 255)) return null;
    text = `${text.slice(0, v4.index)}0:0`; // placeholder groups, overwritten below
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const a = parse(halves[0] as string);
  const b = halves.length === 2 ? parse(halves[1] as string) : [];
  if (!a || !b) return null;
  const fill = halves.length === 2 ? 8 - a.length - b.length : 0;
  if (fill < 0 || (halves.length === 1 && a.length !== 8)) return null;
  const groups = [...a, ...new Array<number>(fill).fill(0), ...b];
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (v4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function v4Of(host: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return (
    ((p[0] as number) * 2 ** 24 + (p[1] as number) * 2 ** 16 + (p[2] as number) * 256 + (p[3] as number)) >>>
    0
  );
}

const isLoopV4 = (n: number): boolean => n >>> 24 === 127 || n === 0;

/** Ground truth: does connecting to this (WHATWG-serialised) hostname reach this machine only? */
function oracleLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true; // names: DNS answers are checked separately
  const n = v4Of(h);
  if (n !== null) return isLoopV4(n);
  if (h.startsWith("[") && h.endsWith("]")) {
    const b = v6Bytes(h.slice(1, -1));
    if (!b) return false;
    const zero10 = b.slice(0, 10).every((x) => x === 0);
    if (zero10 && b.slice(10).every((x) => x === 0)) return true; // ::
    if (zero10 && b.slice(10, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
    if (zero10 && b[10] === 0xff && b[11] === 0xff) {
      return isLoopV4(
        (((b[12] as number) << 24) |
          ((b[13] as number) << 16) |
          ((b[14] as number) << 8) |
          (b[15] as number)) >>>
          0,
      );
    }
    return false;
  }
  return false;
}

function oracleInCidr(hostname: string, base: number, bits: number): boolean {
  const n = v4Of(hostname.replace(/\.$/, ""));
  if (n === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === (base & mask) >>> 0;
}

// ------------------------------------------------------------------ generators

/** Interesting IPv4 ground truths: loopback, unspecified, RFC 1918, CGNAT, link-local, edges, random. */
const ipv4 = fc.oneof(
  fc.integer({ min: 127 * 2 ** 24, max: 128 * 2 ** 24 - 1 }),
  fc.constant(0),
  fc.integer({ min: 10 * 2 ** 24, max: 11 * 2 ** 24 - 1 }),
  fc.integer({ min: 0xac100000, max: 0xac1fffff }),
  fc.integer({ min: 0xc0a80000, max: 0xc0a8ffff }),
  fc.integer({ min: 0xa9fe0000, max: 0xa9feffff }),
  fc.constantFrom(0x7effffff, 0x80000000, 0xffffffff, 0x00000001, 0x7f000001, 0xa9fea9fe),
  fc.integer({ min: 0, max: 0xffffffff }),
);

type Radix = "dec" | "oct" | "hex" | "HEX";
const radix = fc.constantFrom<Radix>("dec", "oct", "hex", "HEX");

function enc(v: number, r: Radix): string {
  if (r === "oct") return `0${v.toString(8)}`;
  if (r === "hex") return `0x${v.toString(16)}`;
  if (r === "HEX") return `0X${v.toString(16).toUpperCase()}`;
  return String(v);
}

/** Every WHATWG IPv4 spelling: 1, 2, 3 or 4 parts, each part in its own radix. */
const ipv4Spelling = fc
  .tuple(ipv4, fc.integer({ min: 1, max: 4 }), fc.array(radix, { minLength: 4, maxLength: 4 }))
  .map(([n, parts, rs]) => {
    const o = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    let nums: number[];
    if (parts === 1) nums = [n];
    else if (parts === 2) nums = [o[0] as number, n & 0xffffff];
    else if (parts === 3) nums = [o[0] as number, o[1] as number, n & 0xffff];
    else nums = o;
    return nums.map((v, i) => enc(v, rs[i] as Radix)).join(".");
  });

const FULLWIDTH = (s: string): string =>
  [...s]
    .map((c) => (/[0-9a-zA-Z]/.test(c) ? String.fromCodePoint((c.codePointAt(0) as number) + 0xfee0) : c))
    .join("");

/** Cosmetic host mutations that must not change the destination. */
function mutateHost(h: string, m: number): string {
  switch (m) {
    case 1:
      return `${h}.`; // trailing dot
    case 2:
      return h.replace(/\./g, "\u3002"); // ideographic full stop
    case 3:
      return FULLWIDTH(h);
    case 4:
      return [...h]
        .map((c, i) => (i % 2 === 0 ? `%${(c.codePointAt(0) as number).toString(16).padStart(2, "0")}` : c))
        .join("");
    case 5:
      return h.toUpperCase();
    default:
      return h;
  }
}

const hex4 = fc.integer({ min: 0, max: 0xffff }).map((x) => x.toString(16));

const ipv6Spelling = fc.oneof(
  fc.array(hex4, { minLength: 8, maxLength: 8 }).map((g) => g.join(":")),
  fc.tuple(ipv4, fc.boolean()).map(([n, hex]) => {
    const dotted = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    return hex ? `::ffff:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}` : `::ffff:${dotted}`;
  }),
  ipv4.map((n) => `0:0:0:0:0:ffff:${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")}`),
  ipv4.map((n) => `::${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")}`), // compat (deprecated)
  ipv4.map((n) => `64:ff9b::${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`), // NAT64
  ipv4.map((n) => `2002:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}::1`), // 6to4
  fc.constantFrom(
    "::1",
    "::",
    "0::1",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:0:0",
    "1::",
  ),
  fc
    .tuple(fc.constantFrom("fe80::1", "::1", "fd00::2"), fc.constantFrom("%25eth0", "%251", "%eth0"))
    .map(([a, z]) => `${a}${z}`),
);

const names = fc.oneof(
  fc.constantFrom(
    "localhost",
    "LocalHost",
    "a.localhost",
    "localhost.evil.com",
    "evil-localhost",
    "127.0.0.1.nip.io",
    "xn--80ak6aa92e.com",
    "\u0430pple.com",
    "\u24DBocalhost",
    "metadata.google.internal",
    "intranet",
    "host.docker.internal",
    "example.com",
  ),
  fc.stringMatching(/^[a-z0-9-]{1,12}(\.[a-z0-9-]{1,12}){0,3}$/),
);

const host = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.tuple(ipv4Spelling, fc.integer({ min: 0, max: 5 })).map(([h, m]) => mutateHost(h, m)),
  },
  {
    weight: 3,
    arbitrary: fc.tuple(ipv6Spelling, fc.boolean()).map(([h, up]) => `[${up ? h.toUpperCase() : h}]`),
  },
  { weight: 2, arbitrary: fc.tuple(names, fc.integer({ min: 0, max: 5 })).map(([h, m]) => mutateHost(h, m)) },
);

/** Prefix/suffix decoys around the authority. */
const decoratedUrl = fc
  .tuple(
    fc.constantFrom("http", "https", "HTTP", "ws", "wss"),
    fc.constantFrom("", "user@", "user:pass@", "127.0.0.1@", "localhost:80@", "[::1]@", "a%40b@"),
    host,
    fc.constantFrom("", ":80", ":3000", ":65535", ":0"),
    fc.constantFrom("/", "/a?b=c", "#@127.0.0.1", "\\@127.0.0.1/", "?@localhost", "/..;/@[::1]"),
  )
  .map(([scheme, userinfo, h, port, rest]) => `${scheme}://${userinfo}${h}${port}${rest}`);

function parse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

const fcOpts = { numRuns: NUM_RUNS, seed: SEED };

// ------------------------------------------------------------------ properties

describe("Safety Guard fuzz: host classification (fast-check)", () => {
  it("default config: a URL is allowed only if its real destination is this machine", () => {
    const g = createSafetyGuard({}, { interactive: false, auditFile: undefined });
    fc.assert(
      fc.property(decoratedUrl, (raw) => {
        const u = parse(raw);
        const d = g.checkTarget(u ?? (raw as unknown as URL));
        if (!u) {
          expect(d.allowed).toBe(false);
          return true;
        }
        if (d.allowed) expect(oracleLoopback(u.hostname), `${raw} → ${u.hostname}`).toBe(true);
        return true;
      }),
      fcOpts,
    );
  });

  it("every IPv4 spelling gets the same decision as its canonical dotted form", () => {
    const g = createSafetyGuard({ allowHosts: ["10.0.0.0/8", "localhost"] }, { interactive: false });
    fc.assert(
      fc.property(ipv4, ipv4Spelling, (_n, spelled) => {
        const u = parse(`http://${spelled}/`);
        if (!u) return true; // e.g. a part > 255 in a 4-part form: rejected by the parser
        const canonical = parse(`http://${u.hostname}/`) as URL;
        expect(g.checkTarget(u).allowed).toBe(g.checkTarget(canonical).allowed);
        return true;
      }),
      fcOpts,
    );
  });

  it("private CIDR on the allow-list admits that CIDR and loopback, nothing else", () => {
    const g = createSafetyGuard({ allowHosts: ["10.0.0.0/8"] }, { interactive: false });
    fc.assert(
      fc.property(decoratedUrl, (raw) => {
        const u = parse(raw);
        if (!u) return true;
        if (g.checkTarget(u).allowed)
          expect(oracleLoopback(u.hostname) || oracleInCidr(u.hostname, 10 * 2 ** 24, 8), raw).toBe(true);
        return true;
      }),
      fcOpts,
    );
  });

  it("public hosts need allowHosts + allowPublic + approval, even when listed", () => {
    fc.assert(
      fc.property(decoratedUrl, fc.boolean(), fc.boolean(), (raw, allowPublic, approve) => {
        const u = parse(raw);
        if (!u) return true;
        const g = createSafetyGuard({ allowHosts: ["*"], allowPublic }, { interactive: false, approve });
        const d = g.checkTarget(u);
        if (d.allowed && !(allowPublic && approve)) {
          // Without public permission only loopback/private destinations may pass.
          const h = u.hostname.toLowerCase();
          const v4 = v4Of(h.replace(/\.$/, ""));
          const isPublicV4 =
            v4 !== null &&
            !isLoopV4(v4) &&
            !oracleInCidr(h, 10 << 24, 8) &&
            !oracleInCidr(h, 0xac100000, 12) &&
            !oracleInCidr(h, 0xc0a80000, 16) &&
            !oracleInCidr(h, 0xa9fe0000, 16) &&
            !oracleInCidr(h, 0x64400000, 10);
          expect(isPublicV4, raw).toBe(false);
        }
        return true;
      }),
      { ...fcOpts, numRuns: 500 },
    );
  });

  it("redirects: a Location is allowed only if its destination is this machine", () => {
    const g = createSafetyGuard({}, { interactive: false });
    const location = fc.oneof(
      decoratedUrl,
      fc.constantFrom(
        "/x",
        "//10.0.0.1/",
        "//[::ffff:a00:1]/",
        "///evil.com",
        "\\\\evil.com/",
        "http:evil.com",
        "https:/\\/evil.com",
      ),
    );
    fc.assert(
      fc.property(location, (loc) => {
        const from = "http://127.0.0.1:3000/start";
        const d = g.checkRedirect(from, loc);
        if (d.allowed) {
          const next = new URL(loc, from);
          expect(oracleLoopback(next.hostname), `${loc} → ${next.href}`).toBe(true);
        }
        return true;
      }),
      fcOpts,
    );
  });
});

describe("Safety Guard fuzz: DNS pinning and rebinding (fast-check)", () => {
  const addr = fc.oneof(
    ipv4.map((n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")),
    ipv6Spelling.filter((s) => !s.includes("%")),
  );
  const answers = fc.array(addr, { minLength: 1, maxLength: 4 });
  const toResolved = (list: string[]): ResolvedAddress[] =>
    list.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));

  it("a name only pins if every answer is loopback (default allow-list)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("localhost", "app.localhost", "LOCALHOST."),
        answers,
        async (name, list) => {
          const g = createSafetyGuard({}, { interactive: false, resolver: async () => toResolved(list) });
          let pinned = false;
          try {
            await g.preflight(`http://${name}:3000/`);
            pinned = true;
          } catch {
            pinned = false;
          }
          if (pinned)
            for (const a of list)
              expect(oracleLoopback(a.includes(":") ? `[${a}]` : a), `${name} → ${a}`).toBe(true);
          return true;
        },
      ),
      { ...fcOpts, numRuns: 500 },
    );
  });

  it("after pinning, lookup only ever returns pinned addresses, whatever DNS says later", async () => {
    await fc.assert(
      fc.asyncProperty(answers, async (later) => {
        let current = ["127.0.0.1"];
        const g = createSafetyGuard({}, { interactive: false, resolver: async () => toResolved(current) });
        await g.preflight("http://localhost:3000/");
        current = later; // the attacker's DNS flips
        try {
          await g.recheckDns("localhost");
        } catch {
          // a class change is a rebind: kill switch engaged
        }
        const got = await new Promise<string[]>((res, rej) =>
          g.lookup("localhost", { all: true }, (err, a) =>
            err ? rej(err) : res((a as unknown as ResolvedAddress[]).map((x) => x.address)),
          ),
        );
        expect(got).toEqual(["127.0.0.1"]);
        const rebound = later.some((a) => !oracleLoopback(a.includes(":") ? `[${a}]` : a));
        // A non-loopback answer for a loopback-pinned name is a rebind → the run is killed.
        if (rebound) expect(g.killSwitch.aborted).toBe(true);
        return true;
      }),
      { ...fcOpts, numRuns: 500 },
    );
  });

  it("lookup on an unpinned name never hands out an address the guard would refuse", async () => {
    await fc.assert(
      fc.asyncProperty(names, answers, async (name, list) => {
        const g = createSafetyGuard({}, { interactive: false, resolver: async () => toResolved(list) });
        const got = await new Promise<string[] | null>((res) =>
          g.lookup(name, { all: true }, (err, a) =>
            res(err ? null : (a as unknown as ResolvedAddress[]).map((x) => x.address)),
          ),
        );
        if (got)
          for (const a of got)
            expect(oracleLoopback(a.includes(":") ? `[${a}]` : a), `${name} → ${a}`).toBe(true);
        return true;
      }),
      { ...fcOpts, numRuns: 500 },
    );
  });
});

describe("Safety Guard regressions found by the fuzzer (wave 8)", () => {
  it("localhost resolving to a LAN address is refused even though 'localhost' is on the default allow-list", async () => {
    // Before the fix: pinned as private and allowed (the listed NAME vouched for any answer).
    const g = createSafetyGuard(
      {},
      { interactive: false, resolver: async () => [{ address: "10.0.0.5", family: 4 }] },
    );
    await expect(g.preflight("http://localhost:3000/")).rejects.toMatchObject({
      code: "SW_SAFETY_DNS_CLASS",
    });
    expect(g.pins()).toEqual([]);
  });

  it("…unless the resolved address itself is allow-listed", async () => {
    const g = createSafetyGuard(
      { allowHosts: ["localhost", "10.0.0.0/8"] },
      { interactive: false, resolver: async () => [{ address: "10.0.0.5", family: 4 }] },
    );
    await expect(g.preflight("http://localhost:3000/")).resolves.toBeUndefined();
  });

  it("lookup with a hostname WHATWG cannot parse calls back with an error instead of throwing", async () => {
    // Before the fix: `new URL("http://-.0")` threw synchronously out of the LookupFunction.
    const g = createSafetyGuard(
      {},
      { interactive: false, resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
    );
    const err = await new Promise<NodeJS.ErrnoException | null>((res) =>
      g.lookup("-.0", { all: true }, (e) => res(e)),
    );
    expect(err?.code).toBe("SW_SAFETY_INVALID_HOST");
  });
});

describe("DNS pinning compatibility (main's checklist for the localhost fix)", () => {
  const res = (address: string) => async (): Promise<ResolvedAddress[]> => [
    { address, family: address.includes(":") ? 6 : 4 },
  ];

  it("(a) implicit loopback name localhost → LAN IP is blocked", async () => {
    const g = createSafetyGuard({}, { interactive: false, resolver: res("192.168.1.5") });
    await expect(g.preflight("http://localhost:3000/")).rejects.toMatchObject({
      code: "SW_SAFETY_DNS_CLASS",
    });
  });

  it("(b) user-listed private names resolving to private/LAN IPs still work", async () => {
    const docker = createSafetyGuard(
      { allowHosts: ["host.docker.internal"] },
      { interactive: false, resolver: res("192.168.65.254") },
    );
    await expect(docker.preflight("http://host.docker.internal:3000/")).resolves.toBeUndefined();
    expect(docker.pins()[0]?.addresses[0]?.address).toBe("192.168.65.254");
    const lan = createSafetyGuard(
      { allowHosts: ["myapp.lan"] },
      { interactive: false, resolver: res("192.168.1.5") },
    );
    await expect(lan.preflight("http://myapp.lan/")).resolves.toBeUndefined();
  });

  it("(c) a listed private name resolving to a PUBLIC IP still needs allowPublic", async () => {
    const g = createSafetyGuard(
      { allowHosts: ["myapp.lan"] },
      { interactive: false, resolver: res("8.8.8.8") },
    );
    await expect(g.preflight("http://myapp.lan/")).rejects.toMatchObject({ code: "SW_SAFETY_DNS_CLASS" });
    const docker = createSafetyGuard(
      { allowHosts: ["host.docker.internal"] },
      { interactive: false, resolver: res("8.8.8.8") },
    );
    await expect(docker.preflight("http://host.docker.internal/")).rejects.toMatchObject({
      code: "SW_SAFETY_DNS_CLASS",
    });
  });
});
