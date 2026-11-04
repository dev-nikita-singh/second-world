# 10 — Plugins & Extensibility

Plugins add report formats, architecture rules, Bug Hunter assertions, history backends and
lifecycle hooks without forking SECOND WORLD. This page describes the plugin system **as built in
0.x (plugin API 1)**: what works, what does not exist yet, and how loading and isolation work.

Source: `src/core/plugins/**` (loading, validation, namespacing, hooks), `src/plugin.ts` (the
`second-world/plugin` entry), `src/core/world.ts` (wiring into the engines),
`src/cli/commands/plugins.ts` (`sw plugins`). Tests: `tests/unit/plugins/**`,
`tests/integration/plugins/**`, fixture plugins in `tests/fixtures/plugins/**`.

## 1. Plugin shape

```ts
import { definePlugin } from "second-world/plugin";

export default definePlugin({
  name: "@acme/sw-extras",            // package name; also gives the namespace "acme"
  version: "1.0.0",
  apiVersion: 1,                      // plugin API contract: a number, or a semver range like "^1"
  // namespace: "acme",               // optional; default derived from `name` (see §3)
  // requires: [{ cap: "docker" }],   // optional capabilities (as in `sw doctor`)
  setup(api) {
    api.registerReporter("summary", { extension: ".summary.txt", render: (report) => "…" });
    api.registerRule(noLegacyFiles);                        // architecture rule → "acme/no-legacy-files"
    api.registerAssertion("sorted-by", sortedBy);           // Bug Hunter assertion → "acme/sorted-by"
    api.registerHistoryStore("s3", (ctx) => createS3Store(ctx.options));
    api.hooks.on("run.completed", async ({ engine, result }) => { /* … */ });
  },
});
```

- `definePlugin` validates the shape and the `apiVersion` and returns the object unchanged; a plugin
  does not have to import it (a plain object works too). A module may also export a **factory**
  `(options) => plugin` (sync or async).
- The module's `default` export (or a named `plugin` export; CommonJS `module.exports`) is used.
- `api.options` holds the options from the config entry; `api.log` logs to stderr with the plugin
  name; `api.namespace` is the prefix of every contribution.
- `apiVersion` is checked when the plugin loads: a number must equal the API version of this
  build (`PLUGIN_API_VERSION`, currently 1), a string must be a semver range that contains
  `1.0.0`. Otherwise: `plugin "<name>": needs plugin API 2, this SECOND WORLD provides plugin API 1`
  (`SW_CONFIG_PLUGIN_API_VERSION`, exit 2).
- `setup()` may be async. It gets 30 s, then it counts as failed.

## 2. Extension points

| Point | Status in 0.x | How it is used |
|---|---|---|
| `registerReporter(name, reporter)` | **supported** | `-f acme/summary` / `report.formats: ["acme/summary"]`. `reporter` = `{ render(report, { format, options }) → string \| Promise<string>, extension? }` or just the render function. `report` is the combined report (schemaVersion 1, the same JSON as `report.json`). The file is `<outDir>/report<extension>`; default extension `.<namespace>-<name>.txt`. Plugin formats are files only (never printed as the terminal report). |
| `registerRule(rule)` | **supported** | Architecture Inspector (`sw inspect`, `world.architecture.inspect`). `rule` is an `ArchRule` (`{ meta: { id, title, severity, category, defaultLevel, docs, fix }, check(ctx) → RuleReport[] }`, same interface as ARCH001–ARCH012) or a `defineTsRule(...)` result (AST visitor, §4). Levels/options use the namespaced id: `architecture.rules: { "acme/no-legacy-files": "off" }`. |
| `registerAssertion(name, fn)` | **supported** | Bug Hunter: `bugs.assertions: [{ operation: "GET /items", use: "acme/sorted-by", args: { key: "price" }, name?: "…" }]`. `fn(response, args, ctx)` gets `{ operation, method, url, status, headers, body, requestBody? }` for every matching exchange and returns `true`/nothing (passed), `false` or a message (failed), or `{ ok, message }`; may be async. A failure is a `bugs/assertion-failed` finding (replayed and classified like built-in assertions). A throw counts as a failure with the plugin name in the message. |
| `registerHistoryStore(name, factory)` | **supported** | `history.backend: "acme/s3"`. `factory({ cwd, dir, options, isoNow, onWarning })` returns (or resolves to) an object implementing the `HistoryStore` interface of `src/engines/history` (`append, get, list, query, setBaseline, getBaseline, listBaselines, diff, trend, verify, prune`; contract: `.agents/CONTRACTS.md`, behaviour suite `tests/unit/history/contract.ts`). It is checked when first opened; a missing method is `SW_CONFIG_PLUGIN_HISTORY`. |
| `hooks.on(event, fn)` | **supported** | See §2.1. |
| `registerExecutor` | not supported in 0.x | throws `SW_CONFIG_PLUGIN_UNSUPPORTED` |
| `registerExtractor` | not supported in 0.x (standalone) | AST extractors come with `defineTsRule` rules only |
| `registerFaultInjector` | not supported in 0.x | throws `SW_CONFIG_PLUGIN_UNSUPPORTED` |
| `registerEngine` | not supported in 0.x | throws `SW_CONFIG_PLUGIN_UNSUPPORTED` |
| `registerTemplateHelper` | not supported in 0.x | perf templates are compiled inside worker threads, where plugin functions cannot be sent |
| `registerTelemetrySource` | not supported in 0.x | throws `SW_CONFIG_PLUGIN_UNSUPPORTED` |

Calling an unsupported point fails the plugin's `setup`:
`plugin "x": registerExecutor() is not supported in SECOND WORLD 0.x (plugin API 1)`.

### 2.1 Lifecycle hooks

| Event | When | Payload |
|---|---|---|
| `config.resolved` | once, after all plugins loaded | `{ config, configFile, cwd }` (read-only) |
| `run.started` | an engine run is requested, before input validation | `{ engine }` |
| `engine.started` | the input is valid; the engine starts now | `{ engine, engineVersion }` |
| `finding.created` | a new finding enters the evidence store | `{ engine, finding }` |
| `run.completed` | the engine returned a result | `{ engine, result }` |
| `run.failed` | the engine (or its input) threw | `{ engine, error: { code, message } }` |

Hooks **observe**; they cannot change results. Handlers run one after another in plugin order and
are awaited (each bounded to 30 s), so a `run.completed` webhook finishes before the CLI writes its
reports. A throwing or hanging handler never fails the run: it becomes a warning and a
`PLUGIN_HOOK_FAILED` limitation on that engine's result, with the plugin name in the message.

## 3. Loading & isolation

```yaml
plugins:
  - "@acme/sw-extras"                     # package in the project's node_modules
  - "./tools/sw-local-plugin.mjs"         # path relative to the config file
  - name: "sw-plugin-slack"
    optional: true                         # failing → warning + limitation, run continues
    options: { channel: "#perf" }          # → api.options (and the factory argument)
```

- **Resolution**: a package name is looked up in `node_modules` starting at the config file's folder
  and walking up, exactly like Node (`package.json` `exports` with the `node`/`import`/`default`
  conditions, then `main`, then `index.js`; `createRequire(<config dir>)` as a last resort). A
  relative path resolves against the config file's folder. Absolute paths are rejected. SECOND
  WORLD's own install is never searched and there is **no auto-discovery**.
- **Trust**: plugins run **in-process** with full Node access, like ESLint plugins. Only list
  plugins you trust.
- **Untrusted repositories**: `--no-config-code` never imports a plugin named by the config (it also
  refuses TS/JS config files); `--no-plugins` loads no plugin at all. In both cases the configured
  plugins are listed as `disabled`, a warning is printed, results get a `PLUGINS_DISABLED`
  limitation, and contributions the config refers to are skipped with a warning (plugin report
  formats are not written, plugin assertions are not run, a plugin history backend falls back to
  JSONL).
- **Errors** are wrapped with the plugin name: `plugin "@acme/sw-extras": cannot import …`,
  `plugin "x": boom in setup`. A failing **required** plugin stops every command that creates a
  world with that error (`SW_CONFIG_PLUGIN_*`, exit 2; a missing `requires` capability is
  `SW_CAP_PLUGIN_REQUIRES`, exit 4). A failing **optional** plugin degrades: warning +
  `PLUGIN_DEGRADED` limitation on every result.
- **Namespacing**: every contribution id is `<namespace>/<name>`. The namespace is the plugin's
  `namespace`, or derived from its name: `@acme/sw-x` → `acme`, `sw-plugin-foo` /
  `second-world-plugin-foo` → `foo`, otherwise the name itself. A plugin may register a bare name
  (`"summary"` → `acme/summary`) or its own prefix (`"acme/summary"`); another prefix is an error.
  Two plugins registering the same id, a reporter reusing another reporter's or a built-in file
  extension (`.json`, `.md`, `.junit.xml`, `.sarif`, `.html`), the same plugin listed twice, or a
  plugin registering the same id twice are **errors** (`SW_CONFIG_PLUGIN_CLASH`); nothing of the
  clashing plugin is registered.
- **References are checked**: an unknown plugin format in `report.formats`, or an unknown plugin
  store in `history.backend` is a config error when the world is created (exit 2, with the list of
  registered ids); an unknown `bugs.assertions[].use` is a config error when `sw bugs` runs.
- Projects without plugins pay nothing: `src/core/plugins` is only imported when the config lists
  plugins (or refers to a plugin contribution).

### `sw plugins`

```text
sw plugins list  [--json]   # name, version, apiVersion, status (loaded/failed/degraded/disabled), contributions, hooks
sw plugins check [--json]   # loads + validates every plugin and the config's references to them
```

`list` exits 0 (2 only for an invalid config). `check` exits **2** when a required plugin is broken
or the config refers to an unknown plugin format, history store or assertion; failing optional
plugins and plugin rule ids in `architecture.rules` that no plugin registers are warnings. Both
honour `--no-plugins` and `--no-config-code` (plugins listed as `disabled`, nothing imported).

Programmatic API: `createWorld({ plugins: [pluginObject], noPlugins })`; `world.plugins.list()`,
`world.plugins.formats()`, `world.plugins.render(report, "acme/summary")`,
`world.plugins.writeReports(results, { formats })`; `world.report.write` writes plugin formats too.

## 4. Writing a custom rule (example)

AST rules use `defineTsRule` from `second-world/plugin`; their id must already carry the namespace
(the AST hits are matched by id, so it cannot be prefixed afterwards):

```ts
import { definePlugin, defineTsRule, ruleMeta } from "second-world/plugin";

const noUnboundedQuery = defineTsRule({
  meta: ruleMeta("acme/no-unbounded-query", "findMany without take", "medium", "performance", "warn",
    "Add pagination (`take`/`cursor`)"),
  create(api) {
    return {
      CallExpression(node) {
        const call = node as import("typescript").CallExpression;
        if (api.ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "findMany" && !api.hasArgProperty(call, "take"))
          api.report({ node, message: "findMany without `take` may return unbounded rows" });
      },
    };
  },
});

export default definePlugin({ name: "@acme/sw-rules", apiVersion: 1, setup: (api) => api.registerRule(noUnboundedQuery) });
```

Graph-level rules implement `ArchRule.check(ctx)` directly (`ctx.facts`, `ctx.graph`, `ctx.routes`,
`ctx.options`, …) and may use a bare id; `RuleReport.ruleId` equal to the bare id is rewritten to the
namespaced id.

## 5. Known limitations (0.x)

- Supported points: reporters, architecture rules, Bug Hunter assertions, history stores, hooks.
  Executors, standalone extractors, fault injectors, engines, template helpers and telemetry
  sources are not (they throw, §2).
- Plugin rules run in `sw inspect` / `world.architecture.inspect`, not in the architecture pass that
  `sw model build` does internally. Plugin assertions run in `sw bugs`, not in `sw agent`, and are not
  embedded in `sw replay` artifacts (a replay re-checks built-in assertions only).
- Plugin report formats are files; the terminal (`tty`) report and `--json` stdout are built-in only.
  The CLI writes plugin formats through `world.plugins.writeReports` (see `src/cli/run-common.ts`).
- Plugins are not sandboxed (in-process, trusted). There is no plugin marketplace or auto-discovery.

## 6. Presets

Not implemented in 0.x. Shareable configs (`extends: ["./base.yaml"]`, see docs/08) already bundle
settings, thresholds and profiles; a preset can list `plugins: [...]` like any config layer.
