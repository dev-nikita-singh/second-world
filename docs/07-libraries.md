# 07 — Libraries & Dependencies

Versions were checked against the npm registry on **2026-10-29**. Use caret ranges (`^`) on the major shown. Run `npm outdated` before each milestone and re-check majors.

**Runtime floor: Node.js `>=22.19.0`** (driven by `undici@8` and `commander@15`). Tested on 22, 24 (LTS) and 26 (current).

## 1. Dependency policy

1. **Prefer Node built-ins**: `node:sqlite`, `node:crypto`, `node:zlib`, `node:worker_threads`, `node:perf_hooks`, `node:diagnostics_channel`, `fetch`, `AbortSignal.any`, `util.parseArgs`. Tests use Vitest rather than `node:test`.
2. **No native addons** in `dependencies` (see [06](06-environments-and-portability.md#2-portability-rules-must)).
3. **Heavy or vendor-specific packages are `optionalDependencies` or `peerDependencies` (optional)** and are loaded via dynamic `import()`, with an install hint on failure.
4. Each new dependency needs: licence check (MIT/Apache-2.0/BSD/ISC only in runtime deps), maintenance check (release in the last 12 months), install-size check, and an entry in this file.
5. Lockfile committed. Renovate/Dependabot weekly. `npm audit signatures` + provenance in CI.

## 2. Runtime dependencies (always installed)

| Package | Version | Purpose | Why this one | Alternatives |
|---|---|---|---|---|
| `zod` | ^4.6 | Config, report, finding, scenario-DSL schemas; JSON Schema export (`z.toJSONSchema`) | Types + validation from one source, v4 is fast and smaller | valibot (smaller), arktype |
| `commander` | ^15.0 | CLI parsing, subcommands, help | Mature, typed, zero deps | `util.parseArgs` (too basic), yargs, citty, clipanion |
| `undici` | ^8.12 | HTTP/1.1 + HTTP/2 load engine, pools, proxy agent, diagnostics | Fastest Node HTTP client, the same code that powers Node `fetch`, fine-grained pooling | `node:http` (slower), got/axios (heavier, not for load) |
| `hdr-histogram-js` | ^3.0 | Latency histograms | Reference HDR port, mergeable, encodable, optional WASM | Own implementation (fallback), DDSketch |
| `c12` | ^4.0 (RC: pin `^3` until 4.0 is final) | Load `sw.config.{ts,mjs,js,json,yaml}`, `.swrc`, env overlays, `extends` | Loads TS configs without a build step (uses `jiti`), layered configs | cosmiconfig + jiti, lilconfig |
| `yaml` | ^2.9 | YAML config & OpenAPI YAML | Spec-compliant, no deps | js-yaml |
| `ajv` + `ajv-formats` | ^8.20 / ^3.0 | Response schema validation (JSON Schema / OpenAPI 3.1) | Fastest, compiled validators | @cfworker/json-schema (no codegen, CSP-safe) |
| `@apidevtools/swagger-parser` | ^13.1 | Parse, validate, dereference OpenAPI/Swagger | Handles `$ref` & circular refs | @readme/openapi-parser, @scalar/openapi-parser |
| `tinyglobby` | ^0.2 | File discovery | Small, fast, fast-glob compatible | fast-glob, globby |
| `ignore` | ^7.0 | `.gitignore` / `.swignore` semantics | Spec-accurate gitignore matching | — |
| `pino` | ^10.4 | Structured logging with async destination + redaction paths | Lowest overhead logger | consola (pretty, slower) |
| `picocolors` | ^1.1 | Terminal colour (respects `NO_COLOR`) | Tiny | chalk, `util.styleText` (built-in, Node ≥ 22.13: preferred where enough) |
| `cli-table3` | ^0.6 | TTY tables | Unicode/ASCII borders | own renderer |
| `log-update` | ^8.0 | Live dashboard redraw | Simple, TTY-aware | ink (React, heavier) |
| `@clack/prompts` | ^1.8 | `sw init` wizard, disruptive-action confirmations | Nice UX, small | inquirer, prompts |
| `execa` | ^10.2 | Spawn app/test/build commands cross-platform, process-tree kill | Windows `.cmd`/PATHEXT handling, no shell | cross-spawn, tinyexec |
| `env-paths` | ^4.0 | OS-correct config/cache/data dirs | — | — |
| `ulid` | ^3.0 | Sortable IDs | — | own 30-line impl |
| `semver` | ^7.8 | Version checks (Node, TS, tool compat, schema migration) | — | — |
| `ci-info` | ^4.4 | Detect CI provider | Covers 40+ CI systems | `std-env` |

Approximate install size of runtime deps: ~6–8 MB.

## 3. Engine-specific (optional / peer, lazily imported)

| Package | Version | Engine | Type | Notes |
|---|---|---|---|---|
| `typescript` | **^6.0** (peer, optional) | Architecture Inspector | peer | **Important:** `typescript@7` (now `latest`) is the Go-native compiler and only exposes `typescript/unstable/*` APIs. Use the **6.x** line for the stable `ts.createProgram` / TypeChecker API. Hide it behind a `SourceAnalyzer` adapter so a TS 7 adapter can be added once its API is stable. The user project's own TS version is used for *parsing compatibility* when ≥ 5.x, otherwise the bundled 6.x |
| `web-tree-sitter` | ^0.27 | Multi-language inspection (Phase 7+) | optional | WASM grammars, no native build |
| `fast-check` | ^4.10 | Property-based, model-based tests in Bug Hunter | dependency of `bugs` | Shrinking, `commands()` |
| `piscina` | ^5.3 | Worker pool for CPU tasks (AST shards, bootstrap) | optional | Or plain `worker_threads` for the load generator (custom protocol) |
| `simple-git` | ^4.0 | Evolution: worktrees, diffs, commit metadata | optional | Or `execa('git', …)` directly |
| `dockerode` | ^5.0 | Docker control for Reliability/Evolution sandboxes | optional | Talks to socket/named pipe |
| `testcontainers` | ^12.2 | Disposable DBs/deps for isolated experiments | optional | Requires Docker |
| `toxiproxy-node-client` | ^4.1 | Toxiproxy fault injection | optional | Built-in proxy is the fallback |
| `playwright` | ^1.64 | Browser scenarios (later phase) | optional peer | Large install, so never default |
| `@opentelemetry/api` | ^1.10 | Telemetry types | optional | — |
| `@opentelemetry/sdk-node` + OTLP exporters/receivers | ^0.300 | Ingest traces/metrics, export SW metrics | optional | 0.x versioning is normal for OTel JS SDK |
| `uplot` | ^1.6 | Charts in HTML reports | bundled into report template | Tiny, fast time-series |
| `cytoscape` | ^3.34 | Interactive graph in HTML reports | bundled into report template | — |

Optional k6/Artillery bridges call the **external binaries** (`k6`, `artillery`) and import their JSON summaries. They are not npm deps.

## 4. Development dependencies

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^6.0 for type-checking the package (**or** `^7.0` `tsc` for faster `--noEmit` checks once the team verifies parity) | Type checking |
| `tsdown` | ^0.23 | Bundle ESM+CJS+d.ts (Rolldown-based, successor to tsup). `tsup` ^9 is an acceptable alternative |
| `vitest` | ^5.0 | Unit/integration tests, coverage (`@vitest/coverage-v8`), benchmarks (`vitest bench`) |
| `@biomejs/biome` | ^2.6 | Lint + format (fast, one tool). Add `typescript-eslint` only for type-aware rules if needed |
| `dependency-cruiser` | ^18.7 | Enforce layer boundaries (core ↛ engines, engine ↛ engine) |
| `publint` | ^0.3 | Validate `package.json` exports |
| `@arethetypeswrong/cli` | ^0.18 | Verify types resolve for ESM/CJS/bundler consumers |
| `@changesets/cli` | ^3.0 | Versioning & changelog |
| `nock` | ^15.0 | Alternative HTTP interception for undici-based adapters |
| `get-port` | ^7.2 | Free ports for test servers |
| `wait-on` | ^9.5 | Wait for example apps in e2e tests |
| `tinybench` / `mitata` | ^6.2 / ^1.0 | Micro-benchmarks of hot paths (histogram record, scheduler) |
| `json-schema-to-typescript` | ^16.0 | (Optional) generate types for third-party schemas |
| `express`, `fastify`, `hono`, `@nestjs/core` | latest | **Example/fixture apps only**, never runtime deps |

## 5. Built-ins used (no install)

| Built-in | Use |
|---|---|
| `node:perf_hooks` | `performance.now()`, `monitorEventLoopDelay`, `eventLoopUtilization` |
| `node:diagnostics_channel` | undici request timing hooks |
| `node:worker_threads` | Load generator sharding, `MessagePort` histogram transfer |
| `node:sqlite` | Planned history backend (not used yet: still experimental in Node 22/24) |
| `node:crypto` | SHA-256, `randomUUID`, `getRandomValues` (seed generation) |
| `node:zlib` | gzip reports & artifacts |
| `node:fs/promises`, `node:path`, `node:url`, `node:os` | Portable FS & environment |
| `node:events` | Event bus base (`EventEmitter` with `captureRejections`) |
| `node:module` | `enableCompileCache()`, `createRequire` for resolving user's `typescript` |
| `node:util` | `styleText`, `parseArgs` (for tiny helper scripts), `inspect` |
| `AbortController`, `AbortSignal.timeout`, `AbortSignal.any` | Cancellation tree |
| `structuredClone`, `fetch` | Utilities. `fetch` is the fallback HTTP adapter for Bun/Deno |

## 6. Example `package.json` skeleton

```jsonc
{
  "name": "second-world",
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "bin": { "sw": "./dist/cli.js", "second-world": "./dist/cli.js" },
  "exports": {
    ".": { "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./performance": { "import": "./dist/performance.js", "require": "./dist/performance.cjs" },
    "./architecture": { "import": "./dist/architecture.js", "require": "./dist/architecture.cjs" },
    "./schemas/*": "./schemas/*",
    "./package.json": "./package.json"
  },
  "sideEffects": false,
  "files": ["dist", "schemas"],
  "dependencies": {
    "zod": "^4.6.7", "commander": "^15.0.0", "undici": "^8.12.3", "hdr-histogram-js": "^3.0.1",
    "c12": "^3", "yaml": "^2.9.1", "ajv": "^8.20.0", "ajv-formats": "^3.0.1",
    "@apidevtools/swagger-parser": "^13.1.0", "tinyglobby": "^0.2.17", "ignore": "^7.0.14",
    "pino": "^10.4.0", "picocolors": "^1.1.1", "cli-table3": "^0.6.5", "log-update": "^8.0.0",
    "@clack/prompts": "^1.8.1", "execa": "^10.2.1", "env-paths": "^4.0.0", "ulid": "^3.0.2",
    "semver": "^7.8.5", "ci-info": "^4.4.0", "fast-check": "^4.10.2"
  },
  "peerDependencies": {
    "typescript": ">=5.0 <7", "playwright": "^1.64"
  },
  "peerDependenciesMeta": {
    "typescript": { "optional": true }, "playwright": { "optional": true }
  },
  "optionalDependencies": {
    "simple-git": "^4.0.2", "dockerode": "^5.0.1", "toxiproxy-node-client": "^4.1.0", "piscina": "^5.3.2"
  }
}
```

> The `c12` entry is pinned to `^3` because 4.0 is still a release candidate. Bump once 4.0 is final. Check the version of `c12@3` with `npm view c12@3 version` when scaffolding.
