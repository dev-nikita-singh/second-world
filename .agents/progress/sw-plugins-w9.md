# sw-plugins-w9 progress

## Done
- src/core/plugins/{types,define,resolve,hooks,loader,wire,index}.ts; src/plugin.ts (second-world/plugin entry)
- schema: plugins entries (string | {name, optional, options}); report.formats + history.backend accept "ns/name"
- world.ts: setUpPlugins (noPlugins / noConfigCode / required fail / optional degrade), hooks (run.started, engine.started, finding.created, run.completed, run.failed, config.resolved), arch rules via inspectArchitecture deps, bugs assertions via runBugsWith, plugin history store, world.plugins + world.report.write plugin formats
- bugs seam: LoadedInvariant.kind, openSession extraInvariants, executeBugs deps, index runBugsWith
- fixtures tests/fixtures/plugins/**; tests/unit/plugins (33) + tests/integration/plugins/world.test.ts (12) pass
- src/cli/commands/plugins.ts (pluginsList / pluginsCheck)

- tests/integration/plugins/cli.test.ts (7, 1 skipped until main.ts registers `plugins`); docs/10 rewritten (as built + limitations)
- requests to sw-cli-w9 written in CONTRACTS.md Requests + messages.log (SendMessage names did not resolve)
- tsc clean, biome clean on my files, design tests 47/47, plugin tests 52 pass 3x in a row; tests/unit/bugs + core green

## In progress
- (none) DONE; waiting on sw-cli-w9 / main for main.ts + run-common wiring and package.json/tsdown entry

## Next
- if resumed: verify main.ts wiring, un-skip CLI process test runs, adjust docs/10 §5 line about finishRun if not wired

## Decisions
- core/plugins has no engine imports (R1): structural types; world.ts bridges to engines.
- namespace = derived from plugin name (@acme/sw-x -> acme; sw-plugin-x / second-world-plugin-x -> x) or plugin.namespace
- hooks are observers: errors -> warning + limitation PLUGIN_HOOK_FAILED; never fail the run
- template helpers unsupported (perf templates compile in worker threads)
- plugin history stores resolved world-scoped in world.ts (not sw-sqlite-w9's process-global registry)
