# 10 — Plugins & Extensibility

The plugin system is what makes SECOND WORLD *dynamic*: new protocols, frameworks, rules, assertions, fault injectors, storage backends and reporters can be added without forking.

## 1. Plugin shape

```ts
import { definePlugin } from "second-world/plugin";

export default definePlugin({
  name: "@acme/sw-grpc",
  version: "1.0.0",
  apiVersion: 1,                         // plugin API contract version; checked with semver
  setup(api) {
    api.registerExecutor("grpc", grpcExecutor);           // new request protocol for Perf/Bugs
    api.registerExtractor(nestMicroservicesExtractor);    // Architecture Inspector
    api.registerRule(myRule);                             // architecture/static rule
    api.registerAssertion("isSortedBy", isSortedBy);      // Bug Hunter assertion
    api.registerFaultInjector("chaos-mesh", chaosMesh);   // Reliability Lab
    api.registerReporter("slack-summary", slackReporter); // output format
    api.registerHistoryStore("s3", s3Store);              // history backend
    api.registerEngine(myCustomEngine);                   // a whole new engine
    api.registerTemplateHelper("faker", fakerHelper);     // template functions
    api.hooks.on("run.completed", async (ctx) => { /* ... */ });
  },
});
```

## 2. Extension points

| Point | Interface | Built-ins |
|---|---|---|
| `Executor` | `prepare(step) → execute(prepared, ctx) → Result` | `http` (undici), `fetch` (fallback) |
| `Extractor` | `kinds: SyntaxKind[]`, `visit(node, ctx)` → facts | express, fastify, nest, hono, koa, next, pg, prisma, … |
| `Rule` | `id, meta, create(ctx) → visitors` (ESLint-like) or `checkGraph(graph)` | ARCH001–ARCH012 |
| `Assertion` | `(response, args, ctx) → AssertionResult` | status, header, jsonPath, schema, latency, custom |
| `FaultInjector` | `capabilities(), apply(fault, signal), revert()` | builtin-proxy, toxiproxy, docker |
| `Reporter` | `render(report, opts) → string \| Stream` | tty, json, md, junit, sarif, html |
| `HistoryStore` | `append, get, list, query, setBaseline` | jsonl (sqlite planned) |
| `TelemetrySource` | `query(window, filters) → metrics/traces` | otlp-file, otlp-receiver, prometheus-scrape |
| `Engine` | full engine contract | all 12 engines are built as internal "plugins" |
| Lifecycle hooks | `config.resolved`, `run.started`, `engine.started`, `finding.created`, `run.completed`, `run.failed` | — |

## 3. Loading & isolation

- Plugins are listed in config (`plugins: [...]`) and resolved from the **project's** `node_modules` (via `createRequire(projectRoot)`) or a relative path. There is no auto-discovery of random packages.
- `apiVersion` mismatch gives a clear error. Plugins declare `requires` capabilities like engines.
- Plugins run **in-process** (trusted, like ESLint plugins). This is documented. `--no-plugins` and `--no-config-code` exist for untrusted repos.
- Plugin errors are wrapped with the plugin name. A failing optional plugin degrades instead of crashing (`plugins: [{ name, optional: true }]`).
- Each plugin's contributions are namespaced (`acme/no-raw-sql`) to prevent clashes.

## 4. Writing a custom rule (example)

```ts
export const noUnboundedQuery = defineRule({
  id: "acme/no-unbounded-query",
  meta: { severity: "medium", docs: "https://acme.dev/rules/unbounded-query", category: "performance" },
  create(ctx) {
    return {
      CallExpression(node) {
        const target = ctx.resolveCall(node);                 // lazily uses TypeChecker
        if (target?.module === "@prisma/client" && target.name === "findMany" && !ctx.hasArgProperty(node, "take"))
          ctx.report({ node, message: "findMany without `take` may return unbounded rows",
                       fix: "Add pagination (`take`/`cursor`)" });
      },
    };
  },
});
```

## 5. Presets

Shareable configs (`extends: ["@acme/sw-preset"]`) bundle plugins, rule settings, thresholds and profiles, so a team can roll out one standard across repos.
