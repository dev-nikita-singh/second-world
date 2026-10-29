# 08 — Configuration

## 1. Sources & precedence (highest wins)

1. CLI flags (`--rate 200`)
2. Environment variables (`SW_PERF_RATE=200`, `SW_TARGET=...`; nested keys use `__`: `SW_REPORT__FAIL_ON=critical`)
3. Selected **profile** (`--profile ci` → `profiles.ci` block)
4. Project config file: `sw.config.{ts,mts,js,mjs,cjs,json,yaml,yml}` or `.swrc`, found by walking up from cwd to the git root
5. `extends` chain (local files or npm packages, e.g. a shared team preset `@acme/sw-preset`)
6. User config (`<config-dir>/second-world/config.*`) — only non-project settings (UI prefs)
7. Built-in defaults

The merged result is validated by **one Zod schema** (`ResolvedConfigSchema`). Errors show the source of each bad value:

```text
✖ Config error (exit 2)
  performance.rate: Expected number > 0, received "fast"   ← from CLI flag --rate
  targets.api.url: Host "api.example.com" is not in safety.allowHosts   ← from sw.config.ts:12
```

`sw config print --resolved` shows the final config with the origin of each key (secrets masked). `sw config schema > sw.schema.json` exports the JSON Schema for editor autocomplete (`"$schema"` in YAML/JSON configs).

### Relative paths

- Paths **inside the config file** (`bugs.contract`, `report.outDir`, `history.dir`, hooks, caches, …) and everything SECOND WORLD writes (`.second-world/`) are relative to the **config file's folder**, wherever you run `sw` from (a subfolder, or `--config path/to/sw.config.ts`). Without a config file, the current directory is used.
- Paths **typed on the command line** (`-o/--out`, `--openapi`, `sw analyze <report…>`, `--context`, `--export-tests`, `--traces`, `--repo`, `--replay`, `sw whatif <file>`, `sw model show <snapshot>`) are relative to the directory you run the command from.

## 2. Units

The parser accepts human units everywhere:

- durations: `250ms`, `30s`, `5m`, `1h30m`, numbers = ms
- sizes: `512B`, `10KB`, `5MiB`
- rates: `200/s`, `12000/m`
- percentages: `1%`, `0.5%`, `0.01`

Everything is normalised internally to ms, bytes, per-second and a 0–1 fraction.

## 3. Full example (`sw.config.ts`)

```ts
import { defineConfig } from "second-world";

export default defineConfig({
  $schemaVersion: 1,
  project: { root: ".", name: "shop-api" },

  environment: "local",                 // local | isolated | staging | production
  targets: {
    api: { url: "http://127.0.0.1:3000", health: "/healthz" },
    payments: { url: "http://127.0.0.1:4010", role: "dependency" },
  },

  safety: {
    allowHosts: ["127.0.0.1", "localhost", "*.staging.shop.internal"],
    maxRps: 2000, maxConcurrency: 500, maxRequests: 2_000_000, maxDuration: "30m",
    allowMutations: false,              // POST/PUT/PATCH/DELETE in Bug Hunter / Agent
    approveDisruptive: false,           // fault injection, evolution sandboxes
    redact: { headers: ["authorization", "cookie", "x-api-key"], bodyPaths: ["$.password", "$..token"] },
  },

  auth: {
    user:  { type: "bearer", token: { env: "SW_TEST_USER_TOKEN" } },
    admin: { type: "oauth2-client-credentials", tokenUrl: "http://127.0.0.1:3000/oauth/token",
             clientId: { env: "SW_ADMIN_ID" }, clientSecret: { env: "SW_ADMIN_SECRET" } },
  },

  hooks: {                              // shell commands or module functions, run with execa (no shell)
    setup:  { command: ["npm", "run", "db:seed:test"] },
    reset:  { http: { method: "POST", url: "http://127.0.0.1:3000/__test/reset" } },
    start:  { command: ["npm", "run", "start:test"], readyWhen: { http: "/healthz" }, timeout: "60s" },
  },

  performance: {
    target: "api",
    model: "open", rate: 300, duration: "2m", rampUp: "20s", warmup: "15s",
    timeout: "5s", workers: "auto", seed: 42,
    http: { version: "1.1", connections: 64, keepAlive: true },
    scenarios: [
      { name: "browse", weight: 8, steps: [
        { method: "GET", path: "/api/products?page={{rand 1 20}}", expect: { status: 200 } } ] },
      { name: "checkout", weight: 2, auth: "user", steps: [
        { method: "POST", path: "/api/cart", json: { sku: "{{data.sku}}", qty: 1 }, extract: { cartId: "$.id" } },
        { method: "POST", path: "/api/orders", json: { cartId: "{{cartId}}" },
          headers: { "Idempotency-Key": "{{uuid}}" }, expect: { status: [201, 409] } } ] },
    ],
    data: { file: "./fixtures/skus.csv", mode: "random" },
    thresholds: {
      "http.p95": "< 300ms",
      "http.error_rate": "< 1%",
      "scenario.checkout.p99": { expr: "< 800ms", abortOnFail: true, delayAbortEval: "30s" },
    },
  },

  stress: { mode: "step", stages: [50, 100, 200, 400, 800], hold: "45s", settle: "10s", stopWhen: { errorRate: "> 5%" } },

  architecture: {
    include: ["src/**/*.ts"], exclude: ["**/*.test.ts"], tsconfig: "tsconfig.json",
    frameworks: "auto",
    rules: { ARCH004: "error", ARCH008: ["warn", { maxExternal: 4 }], ARCH012: ["warn", {
      layers: { controller: "src/controllers/**", service: "src/services/**", repo: "src/repositories/**" },
      allow: [["controller", "service"], ["service", "repo"]] }] },
  },

  bugs: {
    target: "api", openapi: "./openapi.yaml",
    techniques: ["contract", "boundary", "property", "auth"], propertyRuns: 200, replays: 3,
    invariants: ["./tests/sw/invariants.ts"],
  },

  reliability: { injector: "auto", dependencies: { payments: { proxyListen: 14010, upstream: "payments" } } },

  report: { formats: ["tty", "json", "md"], outDir: ".second-world/reports", failOn: "high" },
  history: { backend: "jsonl", dir: ".second-world/history", baseline: "main", retain: { runs: 200 } },

  profiles: {
    ci:    { performance: { rate: 100, duration: "3m", workers: 1 }, report: { formats: ["json", "junit", "md"] } },
    smoke: { performance: { model: "iterations", iterations: 50, vus: 5 } },
  },

  plugins: ["@acme/sw-rules", "./sw-plugins/grpc.ts"],
});
```

### Secrets

Values like `{ env: "NAME" }` or `{ file: "./secret.txt" }` are resolved at runtime and **never written to reports, logs or dry-run output**. A raw string that looks like a secret in a config file triggers a warning.

### Templates

`{{var}}` uses a minimal, safe, logic-less template language (no JS evaluation). Built-ins are `uuid`, `ulid`, `rand a b`, `seq`, `now`, `data.<col>`, `env.<NAME>` (allow-listed), extracted variables, and a `faker`-like set via an optional plugin. Templates are compiled once into closures.

## 4. Threshold expression grammar

```text
threshold := metric WS? op WS? value
metric    := ("http" | "scenario.<name>" | "endpoint.<METHOD /path>") "." stat
stat      := "p(" number ")" | "p50" | "p90" | "p95" | "p99" | "avg" | "max" | "rps" | "error_rate" | "timeout_rate"
op        := "<" | "<=" | ">" | ">=" | "=="
value     := number unit?
```

They are parsed by a small hand-written recursive-descent parser (no `eval`) and validated at load time.

## 5. Config file formats

TS/JS configs are loaded with `c12`/`jiti`. **This is the only place SECOND WORLD executes user-authored code**, and it is the user's own config, same as ESLint/Vite. `--no-config-code` restricts loading to JSON/YAML (for untrusted repos, CI on forks).
