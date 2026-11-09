# Wave 10 — `sw ui`: a local browser UI (2026-11-09)

User (2026-11-09): "can't we have a UI rather than running everything from the CLI … run it once in the CLI and it
should open the UI … show all things, reports, bugs … options to run different types of testing … professional,
clean, better UX". Decision (asked): **browser UI** started by `sw ui` (not Electron).

Branch: `main`. Agents do NOT commit; main reviews and commits. Commits never carry AI attribution.
Rules: .agents/README.md (ownership, no npm install / package.json edits → message main, tests mandatory,
Windows + macOS + Linux portability, **no AI/LLM features ever**).

Definition of Done for every agent:
- unit + integration tests for everything new; `npx tsc --noEmit` clean; `npx biome check src tests --error-on-warnings`
  clean for your files; your tests pass 3× in a row.
- docs updated; CHANGELOG lines sent to main (main owns CHANGELOG.md, README.md, docs/manual-testing.md).
- final progress file + message to main: done, test counts, known gaps.

## User-visible result

```
PS> sw ui                      # or: sw --config examples/shop-express/sw.config.ts ui
SECOND WORLD UI → http://127.0.0.1:4777/#t=<token>   (opening your browser; Ctrl+C to stop)
```

Screens (left sidebar navigation, project name + target health at the top):

1. **Dashboard** — project name/config path; each target with live health (●up / ●down, latency); last run per
   engine with status; open findings by severity (critical/high/medium/low/info); "Start a test" call to action;
   friendly empty state when there is no history ("No runs yet — start your first test" + the 3 easiest engines).
2. **Runs** — the history list (newest first): time, engine, status badge, findings count, p95, duration, label.
   Filter by engine/status, search. Click → **Run detail**:
   - header: engine, status, exit code meaning in words, duration, run id (copy), "Run again" (same options),
     "Compare with…" (history diff), download report as JSON/MD/HTML/SARIF/JUnit.
   - Findings table (severity, class, title, where) with filters; click → side drawer: description, evidence,
     reproduction (curl, copy button), location (file:line), fix hint, fingerprint, "Replay" button for Bug
     Hunter findings.
   - Engine sections: perf/stress metrics tables (+ a simple latency-over-time chart from the windows),
     reliability detectors/invariants, limitations (with impact), thresholds.
3. **Findings** — all findings across runs, grouped by fingerprint: first seen, last seen, times seen, still open
   (seen in the latest run of that engine) vs gone.
4. **New test** — a card per engine with one sentence of what it does and how long it takes:
   Inspect, Bug Hunter, Performance, Stress, Reliability (scenario picker), Agent, What-If (experiment picker),
   System Model. A form per engine with the important options prefilled from the config (target, duration/rate,
   scenario, budget…) + "Advanced" fold-out. Buttons: **Dry run** and **Start**. Mutating / disruptive runs show a
   clear confirmation dialog (what will happen, to which target) — that maps to `--yes` / `--approve-disruptive`.
   While running: live log (streamed), elapsed time, **Stop** (= Ctrl+C, exit 130). On finish → the run detail.
   One run at a time (the button is disabled with "A test is running" while one runs).
5. **Settings** — config summary (redacted, read-only, with the file path), `sw doctor` results, theme
   (system/light/dark), about (version, docs link).

Design: clean, professional, calm. System font stack, 8-px spacing grid, neutral greys + one accent colour,
severity colours that also differ by icon/label (colour-blind safe), light + dark theme (prefers-color-scheme +
toggle), keyboard navigable, visible focus, works from 1024 px to wide screens, no layout shift while live data
updates, numbers right-aligned with tabular figures. No external fonts/CDNs (offline, local only).

## Architecture

- `sw ui` = a small `node:http` server in the CLI process. It **never** runs engines in-process: each test is a
  child process `process.execPath [...execArgv] <cli entry> --config <cfg> <engine argv>` (shell: false), exactly
  the CLI a user would run, so safety guard, audit log, history and exit codes stay identical. Stdout/stderr lines
  are streamed to the browser (SSE). Stop = SIGINT to the child (on Windows: the same mechanism the CLI's own tests
  use for Ctrl+C; document what works).
- The browser app is static files (HTML + one JS bundle + one CSS file) built from `src/ui/web/**` with Preact
  (devDependency, bundled into the asset: zero new runtime deps). Main installs `preact`.
- Data comes only from the existing APIs: history store (list/get/diff), report.json files, config loader
  (redacted), probe (doctor). No new storage.

### Security (non-negotiable — this server can start load tests and fault injection)
1. Bind `127.0.0.1` only. `--port` default 4777, falls back to a free port if taken. No `--host` option.
2. A random 32-byte session token per `sw ui` start. The URL carries it in the **fragment** (`#t=…`, never sent in
   requests or logs); the app sends it as `Authorization: Bearer <t>` on every `/api/*` call and as `?t=` on the
   SSE URL only. Missing/wrong token → 401. Static files are public (they contain no data).
3. `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) → else 421/403.
   For non-GET requests the `Origin` header, if present, must equal the server origin. No CORS headers at all.
4. Strict headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self';
   style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
   form-action 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`
   for `/api/*`.
5. No arbitrary commands: the client sends `{ engine, options }`; the server validates with zod against a
   whitelist per engine and builds argv itself. Option values are typed (numbers, enums, durations, names that must
   exist in the config); free text only where the CLI takes it (labels), never as a flag. Paths are never taken
   from the client (reports are addressed by run id; ids validated against the history).
6. Body size limit 64 kB; JSON only. Everything the server returns that contains config/secrets goes through the
   existing redaction.
7. The token is printed once in the terminal URL; `--no-open` prints it without opening the browser.

## HTTP API contract (server ⇄ web) — owner: sw-ui-server; sw-ui-web codes against it

All JSON. Errors: `{ "error": { "code": string, "message": string } }` with 4xx/5xx.

| Method | Path | Response |
|---|---|---|
| GET | `/api/session` | `{ version, project: { name, root, configPath \| null }, engines: EngineInfo[], history: { backend, dir }, running: RunJob \| null }` |
| GET | `/api/targets` | `{ targets: [{ name, url, role, health: { ok: boolean, status?: number, ms?: number, error?: string } }] }` (probes `health` path, 2 s timeout, loopback/allowed hosts only via the safety guard) |
| GET | `/api/runs?engine=&status=&limit=&before=` | `{ runs: RunSummary[], next: string \| null }` — from history list |
| GET | `/api/runs/:id` | `{ run: RunSummary, report: <the report.json object, redacted> }` |
| GET | `/api/runs/:id/report.:fmt` (fmt ∈ json, md, html, sarif, junit) | the rendered report file, `Content-Disposition: attachment` (uses the existing renderers, like `sw report --run`) |
| GET | `/api/runs/diff?baseline=&current=` | the `sw history diff` result object |
| GET | `/api/findings` | `{ findings: FindingGroup[] }` grouped by fingerprint across the history |
| GET | `/api/config` | `{ path, config: <redacted resolved config> }` |
| GET | `/api/doctor` | the `sw doctor --json` object |
| POST | `/api/jobs` body `{ engine, options, confirm?: { mutations?: boolean, disruptive?: boolean }, dryRun?: boolean }` | 202 `{ job: RunJob }`; 409 if a job is running; 400 with the zod issues; 428 `{ error: { code: "CONFIRM_REQUIRED", message, needs: ["mutations"\|"disruptive"] } }` when confirmation is required |
| GET | `/api/jobs/current` | `{ job: RunJob \| null }` |
| GET | `/api/jobs/:id/events?t=<token>` | SSE: `event: line` `data: {stream:"stdout"\|"stderr", text}`; `event: status` `data: RunJob`; `event: end` `data: RunJob` (then close). Replays the buffered lines (cap 5,000) when a client reconnects. |
| POST | `/api/jobs/:id/stop` | 202 `{ job }` (SIGINT; a second stop = hard kill) |
| POST | `/api/runs/:id/replay` body `{ fingerprint }` | starts a job `replay <fingerprint>` (same as POST /api/jobs) |

Types (export them from `src/ui/shared/api-types.ts`, imported by both sides — the only shared file; owner
sw-ui-server, create it FIRST and mark READY in CONTRACTS.md):

```ts
type EngineId = "inspect" | "bugs" | "perf" | "stress" | "reliability" | "agent" | "whatif" | "model";
interface EngineInfo { id: EngineId; title: string; summary: string; typicalDuration: string; configured: boolean;
  needs: Array<"mutations" | "disruptive" | "typescript" | "contract">; options: OptionSpec[] }
interface OptionSpec { name: string; label: string; help: string; kind: "number" | "duration" | "enum" | "boolean" | "text";
  choices?: string[]; default?: string | number | boolean; advanced?: boolean; min?: number; max?: number }
interface RunSummary { id: string; createdAt: string; engine: string; label?: string; status: string;
  exitCode?: number; findings: { total: number; bySeverity: Record<string, number> }; p95Ms?: number; durationMs?: number }
interface RunJob { id: string; engine: EngineId; argv: string[] /* display only, redacted */; startedAt: string;
  state: "running" | "stopping" | "finished"; exitCode?: number; exitMeaning?: string; runId?: string /* history id when saved */ }
interface FindingGroup { fingerprint: string; ruleId: string; title: string; severity: string; classification: string;
  engine: string; where?: string; firstSeen: string; lastSeen: string; runs: number; open: boolean; lastRunId: string }
```

(`options` per engine are the server's whitelist; the web renders forms from `OptionSpec`, so adding an option is a
server-only change.)

## sw-ui-server — `sw ui` command, HTTP API, job runner, security
- Owns: `src/ui/server/**`, `src/ui/shared/**`, `src/cli/commands/ui.ts`, the `ui` registration in
  `src/cli/main.ts` (only that block + its import), `tests/unit/ui/server/**`, `tests/integration/ui/**`,
  docs/09-cli-and-api.md (`sw ui` section), docs/11 (a "Local UI server" threat-model row/section).
- `sw ui [--port <n>] [--no-open]`, global `--config` honoured. Opens the browser with the OS default
  (`start ""`/`open`/`xdg-open` via execFile, shell: false — Windows needs `cmd /c start "" <url>`: careful quoting,
  the URL contains `#`). Ctrl+C stops the server and SIGINTs a running child.
- Serves static assets from the built bundle: `dist/ui/**` when running the built package; when running from source
  (tsx) and the bundle is missing, build it on the fly once with the bundler sw-ui-web provides
  (`buildUiAssets(outDir)` exported from `src/ui/web/build.ts`), or serve a clear page "UI assets not built: run
  npm run build". Coordinate the exact mechanism with sw-ui-web.
- Tests: token/Host/Origin/CSP checks (each a failing request), whitelist rejects unknown engines/options and any
  attempt to inject flags (`"--target=http://evil"` as a value), job lifecycle against a real example app
  (start → SSE lines → end → run appears in /api/runs), stop → exit 130, 409 on a second job, report downloads in
  every format, path-traversal attempts on run ids, port fallback, `--no-open`. Integration tests start the server on
  port 0.

## sw-ui-web — the browser app
- Owns: `src/ui/web/**` (Preact + TSX, CSS), `tests/unit/ui/web/**`, the UI bundle build entry
  (`src/ui/web/build.ts` exporting `buildUiAssets(outDir)`, used by `npm run build` via a script main wires into
  package.json/tsdown — message main with the exact change), docs/09 screenshots/description of screens if useful.
- Implements the 5 screens above against the API contract (code against the types; use a local fake API in tests).
- Hash routing (`#/runs/<id>`), token read from the fragment on first load then kept in sessionStorage and removed
  from the visible URL. Graceful states everywhere: loading skeletons, empty states with next step, error banners
  with the server's message, server-gone banner ("SECOND WORLD UI stopped — restart `sw ui`").
- Accessibility: semantic HTML, labels for every input, focus management in dialogs/drawers, Escape closes,
  aria-live for the job log status, contrast ≥ 4.5:1 in both themes.
- No external requests (fonts, CDNs, analytics). Bundle budget: JS ≤ 150 kB minified.
- Tests: pure logic (formatters, filters, grouping, routing, option→form mapping) with vitest; rendering tests only
  if they need no new heavy dependency (ask main before adding jsdom/happy-dom).

## sw-rel-fix — reliability false PASS when the fault never reaches the app (found in manual testing)
- Bug: with the shop started WITHOUT `PAYMENTS_URL=http://127.0.0.1:4011`, `sw reliability run dependency-5xx`
  injected the fault into a proxy the app never called, reported "0 dependency calls / 34 requests", detectors ok,
  `✔ PASS (exit 0)`. Correct: the experiment is invalid → a limitation with impact `invalidates`
  (e.g. `fault-not-exercised`: "the dependency proxy received 0 calls while N requests were made; the app is not
  routed through the fault proxy — point <dependency> at <proxyListen>") and the run must not pass
  (status inconclusive/error per the docs' exit-code rules — pick the documented one, likely exit 5 or 1; justify).
  Also the inverse: some calls but none during the fault window.
- Owns: `src/engines/reliability/**`, `tests/{unit,integration}/reliability/**`, docs/03-engines/reliability-lab.md.
- Test: integration with shop-express started pointing payments directly at payments-fake (bypassing the proxy).

## Status (2026-11-09)
The user chose "build it yourself, one by one" instead of parallel agents: main built all three parts
(no sw-ui-server / sw-ui-web / sw-rel-fix agents were spawned). Done: src/ui/** (server, shared types, web app),
`sw ui` command, IPC stop for UI-started commands (src/cli/main.ts listenForUiInterrupt), reliability
`fault-not-exercised`, docs 09/11/03-reliability/README/manual-testing, CHANGELOG. Tests: tests/unit/ui/**,
tests/integration/ui/**, tests/integration/reliability/fault-not-exercised.test.ts.
Note: env vars starting with SW_ are config overrides (loader) — the UI uses SECOND_WORLD_UI_JOB / SECOND_WORLD_UI_ASSETS.
