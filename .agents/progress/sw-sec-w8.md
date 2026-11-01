# sw-sec-w8 progress — DONE (2026-11-01)

## Done (each: failing test on HEAD first, then fix)
1. guard.ts: `localhost` (default-listed) resolving to a LAN IP was pinned+allowed → loopback names must
   resolve to loopback unless the addresses are listed. lookup() no longer throws synchronously on
   unparseable hostnames. dnsTimeoutMs (default 10 s) on pin + recheck. Tests: tests/unit/security/
   guard-fuzz.test.ts (incl. main's compat a/b/c), dns-timeout.test.ts.
2. redact.ts: sensitive-name assignments in free text (any length; quoted values whole), credential header
   lines, acronym/glued keys, more keywords; shared isSensitiveHeader/isSensitiveParam/redactUrlParams/
   REDACTED_PLACEHOLDER used by har.ts AND bugs/http.ts curl (main approved http.ts edit). Tests:
   redaction-fuzz.test.ts, curl-redaction.test.ts.
3. export.ts: role map null-prototype (`__proto__` role). Test: export-injection-fuzz.test.ts (AST shape).
4. artifact.ts: replay imports invariant modules only inside the project (RCE from shared artifacts).
   Tests: artifact-path.test.ts, replay-cli-outside.test.ts (CLI exit 2, reason printed). main updated
   tests/unit/bugs/artifact.test.ts:276. Doc line in docs/03-engines/api-bug-hunter.md.
5. child-process.test.ts: no shell anywhere, reviewed spawner list, split fuzz.
6. npm audit --omit=dev: 0 vulnerabilities. npm pack --dry-run: 131 files (dist, LICENSE, README, package.json).
7. .github/workflows/release.yml (not runnable here). docs/11 §1 threat model (assets, actors, boundaries,
   STRIDE with code+test, residual risks), §2/§4/§5/§7 updated. SECURITY.md updated.
Checks: tests/unit 169 files / 1655 passed; tsc clean; biome --error-on-warnings clean on changed files.

## Open (reported to main, out of lane)
- src/engines/model/build.ts:359 prometheus scrape: global fetch follows redirects, no DNS pin (code reading).
- src/engines/history/jsonl-store.ts:189 trusts index `file` field (tampered index → read outside dir; low).
