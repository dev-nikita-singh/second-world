import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModel } from "../../../src/engines/model/index.js";
import {
  detectConfigType,
  discoverConfigFiles,
  envIdentity,
  fromConfigFiles,
  parseDotEnv,
  scanCodeEnv,
} from "../../../src/engines/model/sources/config.js";
import { makeTmpDir, type TmpDir } from "../../helpers/tmp.js";

let tmp: TmpDir;
beforeEach(async () => {
  tmp = await makeTmpDir("sw-model-");
});
afterEach(async () => {
  await tmp.cleanup();
});

const SECRETS = ["hunter2", "sk_live_51Hxyz", "sup3r-s3cret", "AKIAIOSFODNN7EXAMPLE", "p4ss"];

describe(".env parsing and secret handling", () => {
  it("parses KEY=VALUE with export, quotes and comments", () => {
    expect(parseDotEnv("# c\nexport A=1\nB=\"two words\" # x\nC='q'\nD=v # comment\n bad line\nE=")).toEqual([
      { name: "A", value: "1", line: 2 },
      { name: "B", value: "two words", line: 3 },
      { name: "C", value: "q", line: 4 },
      { name: "D", value: "v", line: 5 },
      { name: "E", value: "", line: 7 },
    ]);
  });

  it("keeps only scheme://host:port of URL-like values", () => {
    expect(envIdentity("DATABASE_URL", "postgres://u:hunter2@db:5432/shop?password=p4ss")).toEqual({
      kind: "datastore",
      hostPort: "db:5432",
      hostname: "db",
      display: "postgres://db:5432",
    });
    expect(envIdentity("REDIS_URL", "redis://:pw@localhost")).toMatchObject({
      kind: "cache",
      hostPort: "127.0.0.1:6379",
    });
    expect(envIdentity("PAYMENTS_HOST", "payments:8080")).toMatchObject({
      hostPort: "payments:8080",
      hostname: "payments",
    });
    expect(envIdentity("API_KEY", "sk_live_51Hxyz")).toBeUndefined();
    expect(envIdentity("SECRET_TOKEN", "abc:1234")).toBeUndefined();
    expect(envIdentity("PORT", "3000")).toBeUndefined();
    expect(envIdentity("GREETING", "hello world")).toBeUndefined();
  });

  it("never stores secret values in the model", async () => {
    const env = tmp.join(".env");
    await writeFile(
      env,
      [
        "PAYMENTS_URL=https://user:sup3r-s3cret@payments.internal:8443/v1?token=hunter2",
        "STRIPE_KEY=sk_live_51Hxyz",
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        "DB_PASSWORD=p4ss",
        "DATABASE_URL=postgres://app:hunter2@127.0.0.1:5432/app",
      ].join("\n"),
    );
    const r = await buildModel({ config: { files: [env], discover: false } });
    const json = JSON.stringify(r);
    for (const s of SECRETS) expect(json).not.toContain(s);
    const pay = r.data?.nodes.find((n) => n.names.includes("payments.internal"));
    expect(pay?.hosts).toEqual(["payments.internal:8443"]);
    expect(pay?.evidence[0]?.detail).toBe("PAYMENTS_URL=https://payments.internal:8443");
    expect(r.limitations.map((l) => l.code)).toContain("MODEL_SOURCE_ONLY");
  });
});

describe("docker-compose / k8s / package.json", () => {
  it("compose: services, ports, depends_on, env URLs", async () => {
    const f = tmp.join("docker-compose.yml");
    await writeFile(
      f,
      `services:
  api:
    build: .
    ports: ["8080:3000", { target: 9229, published: 9230 }]
    environment:
      - ORDERS_URL=http://orders:4000
      - PASSWORD=hunter2
    depends_on: { db: { condition: service_healthy } }
  orders:
    image: example/orders:1
    expose: ["4000"]
  db:
    image: postgres:16
    ports: ["127.0.0.1:5433:5432"]
`,
    );
    const set = await fromConfigFiles([f], { root: tmp.path });
    expect(set.files).toEqual([{ file: "docker-compose.yml", type: "compose" }]);
    const api = set.nodes.find((n) => n.key === "compose:api");
    expect(api?.hosts?.sort()).toEqual(["127.0.0.1:8080", "127.0.0.1:9230", "api:3000", "api:9229"]);
    expect(set.nodes.find((n) => n.key === "compose:db")?.kind).toBe("datastore");
    expect(set.nodes.find((n) => n.key === "compose:db")?.hosts).toContain("127.0.0.1:5433");
    expect(set.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "compose:api", to: "compose:db", kind: "depends" }),
        expect.objectContaining({ from: "compose:api", to: "env:orders:4000", kind: "calls" }),
      ]),
    );
    expect(JSON.stringify(set)).not.toContain("hunter2");
    // Built model: api → orders resolves through env URL + compose service name.
    const r = await buildModel({ config: { files: [f], discover: false } });
    const ids = r.data?.nodes.map((n) => n.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["service:api", "service:orders", "datastore:db"]));
    expect(r.data?.edges.map((e) => e.id)).toEqual(
      expect.arrayContaining(["service:api->service:orders:calls", "service:api->datastore:db:depends"]),
    );
  });

  it("k8s: Deployment + Service linked by selector, env URL to another Service", async () => {
    const f = tmp.join("k8s.yaml");
    await writeFile(
      f,
      `apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout, namespace: shop }
spec:
  template:
    metadata: { labels: { app: checkout } }
    spec:
      containers:
        - name: c
          image: shop/checkout:2
          env:
            - { name: PAYMENTS_URL, value: "http://payments.shop.svc.cluster.local:80" }
            - { name: SECRET, valueFrom: { secretKeyRef: { name: s, key: k } } }
---
apiVersion: v1
kind: Service
metadata: { name: checkout, namespace: shop }
spec:
  selector: { app: checkout }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: v1
kind: Service
metadata: { name: payments, namespace: shop }
spec:
  selector: { app: payments }
  ports: [{ port: 80 }]
`,
    );
    expect(detectConfigType(f, "apiVersion: v1\nkind: Service\n")).toBe("k8s");
    const set = await fromConfigFiles([f], { root: tmp.path });
    expect(set.links).toEqual([
      expect.objectContaining({
        a: "k8s:shop/service/checkout",
        b: "k8s:shop/deployment/checkout",
        rule: "k8s-selector",
      }),
    ]);
    const r = await buildModel({ config: { files: [f], discover: false } });
    const d = r.data;
    expect(
      d?.nodes
        .filter((n) => n.kind === "service")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["service:checkout", "service:payments"]);
    expect(d?.edges.map((e) => e.id)).toContain("service:checkout->service:payments:calls");
  });

  it("discovers config files and scans code for env reads", async () => {
    await writeFile(tmp.join("package.json"), JSON.stringify({ name: "my-api" }));
    await writeFile(tmp.join(".env.example"), "X_URL=http://x:1\n");
    await writeFile(tmp.join("compose.yaml"), "services: {}\n");
    await writeFile(tmp.join("README.md"), "x");
    const found = (await discoverConfigFiles(tmp.path)).map((p) => p.replace(/\\/g, "/").split("/").pop());
    expect(found.sort()).toEqual([".env.example", "compose.yaml", "package.json"]);
    await writeFile(
      tmp.join("a.ts"),
      'const u = process.env.X_URL;\nconst v = process.env["Y_HOST"] ?? import.meta.env.Z;\n',
    );
    const refs = await scanCodeEnv(tmp.path, ["a.ts"]);
    expect([...refs.keys()].sort()).toEqual(["X_URL", "Y_HOST", "Z"]);
    expect(refs.get("Y_HOST")).toEqual([{ file: "a.ts", line: 2 }]);
    const r = await buildModel({ project: tmp.path, architecture: false });
    expect(r.data?.primaryService).toBe("service:my-api");
    expect(r.data?.edges.map((e) => e.id)).toContain("service:my-api->external:x:calls");
  });
});
