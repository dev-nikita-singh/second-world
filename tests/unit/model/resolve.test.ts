import { describe, expect, it } from "vitest";
import { kindsCompatible, resolveEntities } from "../../../src/engines/model/resolve.js";
import type { NodeObservation } from "../../../src/engines/model/sources/observation.js";

const ev = [{ source: "static" as const, confidence: 0.75, origin: "x", detail: "d" }];
const obs = (
  key: string,
  kind: NodeObservation["kind"],
  name: string,
  extra: Partial<NodeObservation> = {},
): NodeObservation => ({
  key,
  kind,
  name,
  evidence: ev,
  ...extra,
});
const together = (r: ReturnType<typeof resolveEntities>, a: string, b: string) =>
  r.groupOf(a) === r.groupOf(b);

describe("entity resolution rules", () => {
  it("same host:port merges", () => {
    const r = resolveEntities(
      [
        obs("compose:payments", "service", "payments", { hosts: ["127.0.0.1:4010"] }),
        obs("trace:peer:external:127.0.0.1:4010", "external", "127.0.0.1:4010", {
          hosts: ["127.0.0.1:4010"],
        }),
        obs("trace:peer:external:other", "external", "other", { hosts: ["127.0.0.1:4011"] }),
      ],
      [],
    );
    expect(together(r, "compose:payments", "trace:peer:external:127.0.0.1:4010")).toBe(true);
    expect(together(r, "compose:payments", "trace:peer:external:other")).toBe(false);
    const g = r.groupOf("compose:payments");
    expect(g?.merges).toEqual([
      expect.objectContaining({
        rule: "host-port",
        detail: "127.0.0.1:4010",
        proposed: false,
        confidence: 1,
      }),
    ]);
    expect(g?.multiplier).toBe(1);
  });

  it("same service.name / peer.service merges", () => {
    const r = resolveEntities(
      [
        obs("trace:svc:payments", "service", "payments", { serviceNames: ["payments"] }),
        obs("trace:peer:external:payments", "external", "payments", { serviceNames: ["Payments"] }),
      ],
      [],
    );
    expect(together(r, "trace:svc:payments", "trace:peer:external:payments")).toBe(true);
    expect(r.groupOf("trace:svc:payments")?.merges[0]?.rule).toBe("service-name");
  });

  it("env var stem ↔ client name in code (env-url)", () => {
    const r = resolveEntities(
      [
        obs("env:payments:8080", "external", "payments", {
          envStems: ["payments"],
          aliases: ["PAYMENT_URL"],
          hosts: ["payments:8080"],
        }),
        obs("arch:external:payment", "external", "payment", { envStems: ["payment"] }),
        obs("arch:external:stripe", "external", "stripe", { envStems: ["stripe"] }),
      ],
      [],
    );
    expect(together(r, "env:payments:8080", "arch:external:payment")).toBe(true);
    expect(together(r, "env:payments:8080", "arch:external:stripe")).toBe(false);
    expect(r.groupOf("arch:external:payment")?.merges[0]?.rule).toBe("env-url");
  });

  it("explicit links (trace-link, k8s-selector) merge", () => {
    const r = resolveEntities(
      [
        obs("k8s:default/service/api", "service", "api"),
        obs("k8s:default/deployment/api-v2", "service", "api-v2"),
      ],
      [
        {
          a: "k8s:default/service/api",
          b: "k8s:default/deployment/api-v2",
          rule: "k8s-selector",
          detail: "app=api",
        },
      ],
    );
    expect(together(r, "k8s:default/service/api", "k8s:default/deployment/api-v2")).toBe(true);
  });

  it("Jaro-Winkler ≥ 0.92 with compatible kinds is a PROPOSED merge with lowered confidence", () => {
    const r = resolveEntities(
      [
        obs("arch:external:PaymentClient", "external", "PaymentClient"),
        obs("trace:svc:payments-svc", "service", "payments-svc"),
      ],
      [],
    );
    expect(together(r, "arch:external:PaymentClient", "trace:svc:payments-svc")).toBe(true);
    const g = r.groupOf("trace:svc:payments-svc");
    expect(g?.proposed).toBe(true);
    expect(g?.merges[0]).toMatchObject({ rule: "name-similarity", proposed: true });
    expect(g?.multiplier).toBeLessThan(1);
    expect(g?.multiplier).toBeGreaterThanOrEqual(0.6);
  });
});

describe("entity resolution negative cases", () => {
  it("similar names with incompatible kinds do not merge", () => {
    const r = resolveEntities([obs("a", "datastore", "orders"), obs("b", "queue", "orders")], []);
    expect(together(r, "a", "b")).toBe(false);
    // service ↔ datastore is not a fuzzy-compatible pair either
    const r2 = resolveEntities([obs("a", "service", "inventory"), obs("b", "datastore", "inventory")], []);
    expect(together(r2, "a", "b")).toBe(false);
  });

  it("similar but different names stay apart (below threshold)", () => {
    const r = resolveEntities([obs("a", "external", "inventory"), obs("b", "external", "invoice")], []);
    expect(together(r, "a", "b")).toBe(false);
    const r2 = resolveEntities([obs("a", "external", "users"), obs("b", "external", "orders")], []);
    expect(together(r2, "a", "b")).toBe(false);
  });

  it("never fuzzy-merges different addresses, two traced services, or IP-like names", () => {
    const hosts = resolveEntities(
      [
        obs("a", "external", "payments", { hosts: ["10.0.0.1:80"] }),
        obs("b", "external", "payment", { hosts: ["10.0.0.2:80"] }),
      ],
      [],
    );
    expect(together(hosts, "a", "b")).toBe(false);
    const traced = resolveEntities(
      [obs("trace:svc:order", "service", "order"), obs("trace:svc:orders", "service", "orders")],
      [],
    );
    expect(together(traced, "trace:svc:order", "trace:svc:orders")).toBe(false);
    const ips = resolveEntities(
      [obs("a", "external", "10.0.0.1:8080"), obs("b", "external", "10.0.0.1:8081")],
      [],
    );
    expect(together(ips, "a", "b")).toBe(false);
    const short = resolveEntities([obs("a", "external", "db1"), obs("b", "external", "db2")], []);
    expect(together(short, "a", "b")).toBe(false);
  });

  it("refuses strong merges that would chain incompatible kinds (transitively)", () => {
    const r = resolveEntities(
      [
        obs("x", "datastore", "pg", { hosts: ["db:5432"] }),
        obs("y", "external", "db", { hosts: ["db:5432"], serviceNames: ["shared"] }),
        obs("z", "queue", "q", { serviceNames: ["shared"] }),
      ],
      [],
    );
    expect(together(r, "x", "y")).toBe(true);
    expect(together(r, "y", "z")).toBe(false);
    expect(r.refused[0]).toMatchObject({ rule: "service-name" });
  });

  it("can disable fuzzy matching", () => {
    const r = resolveEntities([obs("a", "external", "payment"), obs("b", "external", "payments")], [], {
      fuzzy: false,
    });
    expect(together(r, "a", "b")).toBe(false);
  });

  it("routes merge only within the same resolved service", () => {
    const route = (key: string, svc: string, path: string) =>
      obs(key, "route", `GET ${path}`, { route: { method: "GET", path, serviceKey: svc }, fuzzy: false });
    const r = resolveEntities(
      [
        obs("svcA", "service", "a", { hosts: ["127.0.0.1:3000"] }),
        obs("svcA2", "service", "a2", { hosts: ["127.0.0.1:3000"] }),
        obs("svcB", "service", "b", { hosts: ["127.0.0.1:4000"] }),
        route("r1", "svcA", "/health"),
        route("r2", "svcA2", "/health"),
        route("r3", "svcB", "/health"),
        route("r4", "svcA", "/p/:id"),
        route("r5", "svcA2", "/p/{productId}"),
      ],
      [],
    );
    expect(together(r, "r1", "r2")).toBe(true);
    expect(together(r, "r1", "r3")).toBe(false);
    expect(together(r, "r4", "r5")).toBe(true);
    expect(together(r, "svcA", "r1")).toBe(false);
  });

  it("kind compatibility table", () => {
    expect(kindsCompatible(["service"], ["external"], true)).toBe(true);
    expect(kindsCompatible(["service"], ["datastore"], false)).toBe(true);
    expect(kindsCompatible(["service"], ["datastore"], true)).toBe(false);
    expect(kindsCompatible(["datastore"], ["cache"], false)).toBe(true);
    expect(kindsCompatible(["datastore"], ["queue"], false)).toBe(false);
    expect(kindsCompatible(["route"], ["service"], false)).toBe(false);
  });
});
