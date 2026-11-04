# 06 — Environments & Portability

**Goal**: SECOND WORLD works the same everywhere it can, and explains clearly when it can't.

## 1. Support matrix

| Dimension | Supported (tested in CI) | Best effort | Not supported |
|---|---|---|---|
| OS | Windows 10/11 (x64, arm64), macOS 13+ (arm64, x64), Linux glibc & musl (Ubuntu, Debian, Alpine, RHEL) x64/arm64 | FreeBSD | — |
| Runtime | **Node.js 22 (≥ 22.19), 24 LTS, 26 current** | Bun ≥ 1.2, Deno ≥ 2 (npm compat) for non-worker features | Node < 22.19 (required by `undici@8`, `commander@15`) |
| Shells | PowerShell, cmd, bash, zsh, fish | — | — |
| Containers | Docker, Podman, Kubernetes pods, devcontainers, Codespaces | WSL2 | — |
| CI | GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI, Bitbucket | Buildkite, Drone | — |
| Package managers | npm, pnpm, yarn (classic & berry, incl. PnP), bun | — | — |
| Network | Direct, HTTP(S) proxy, custom CA, IPv4, IPv6, offline | SOCKS proxy (adapter) | — |

## 2. Portability rules (MUST)

| Area | Rule | Why |
|---|---|---|
| Native code | **No native addons** in core or default deps. WASM is allowed (tree-sitter, xxhash) | No compiler/Python needed, works on musl/arm/Windows |
| Paths | `node:path` + `pathToFileURL` for dynamic imports. Never string-concat with `/`. Normalise to POSIX in reports (`path.posix`) for stable fingerprints | Windows backslashes, drive letters, `file://` URLs |
| Case sensitivity | Compare paths case-insensitively on win32/darwin when deduplicating | Avoid duplicate nodes |
| Long paths | Use `\\?\` prefix only when > 260 chars on Windows (fs handles most). Keep temp dirs short | Windows MAX_PATH |
| Line endings | Read with CRLF/LF tolerance. Write LF. Hash snippets after normalising EOL | Stable fingerprints across OS |
| Encoding | UTF-8 everywhere. Strip BOM on read. Detect and warn on non-UTF-8 source files (the original plan file is Windows-1252!) | Garbled text |
| Temp files | `os.tmpdir()` + `fs.mkdtemp`. Cleanup on exit via cleanup stack | Permissions differ |
| Home/config dirs | XDG on Linux, `%APPDATA%` on Windows, `~/Library/Application Support` on macOS (via `env-paths`) | OS conventions |
| Signals | Handle `SIGINT`, `SIGTERM`, `SIGBREAK` (Windows Ctrl+Break), and `beforeExit`. On Windows, SIGTERM from other processes is not delivered, so rely on the parent closing stdin or the IPC `disconnect` too | Graceful cancel everywhere |
| Child processes | Spawn via `execa`/`cross-spawn` (handles `.cmd` shims, PATHEXT, quoting on Windows). Never `shell: true` with user strings | Windows `npm.cmd`, injection safety |
| Process tree kill | Kill the whole tree (`taskkill /T /F` on Windows, process group `-pid` on POSIX) for started apps | Orphaned servers |
| Ports | Bind `:0` to get free ports. Never assume a port is free | Parallel CI jobs |
| `localhost` | Node ≥ 17 resolves `localhost` to **`::1` first**. If connect fails on ::1 and the target was `localhost`, retry 127.0.0.1 and warn, suggesting an explicit IP. Happy-eyeballs via `autoSelectFamily` | Classic "ECONNREFUSED ::1:3000" |
| Time | Report timestamps in UTC ISO-8601. Durations from monotonic clocks only | DST, clock jumps, NTP |
| Locale | Format numbers in reports with a fixed locale (`en-US`) for JSON. TTY may use the user locale | Parsable outputs |
| CPU count | `os.availableParallelism()` + **cgroup quota** read (`/sys/fs/cgroup/cpu.max` v2, `cpu.cfs_quota_us` v1) | Containers report host cores |
| Memory | Read the cgroup memory limit and warn if `--max-old-space-size` > limit | OOM kills in containers |
| Terminal | Detect TTY (`process.stdout.isTTY`), `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, CI env vars → plain output, no spinners, no cursor control | Clean CI logs |
| Unicode in TTY | Fallback ASCII symbols when the terminal is not UTF-8 (older Windows consoles) | Broken boxes/arrows |
| Proxies | Honour `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (case-insensitive) via undici `EnvHttpProxyAgent` for *outbound tool calls* (telemetry). **For load targets, proxy is off by default** (a proxy distorts latency) unless `http.proxy` is set | Corporate networks |
| TLS | Honour `NODE_EXTRA_CA_CERTS`, config `tls.ca`. `insecure: true` only per target with a warning in the report | Self-signed staging certs |
| Offline | All features work offline: nothing calls an external service (no AI, no telemetry phoning home) | Air-gapped environments |
| Module system | Ship ESM + CJS for the public API, ESM CLI, correct `exports` conditions, types for both (`publint`, `arethetypeswrong` in CI) | Any consumer setup |
| TypeScript dep | Use the project's own `typescript` if present (resolve from project root), else the bundled optional dep | Version compatibility with user code |

## 3. Environment probe (`sw doctor`)

At startup (cheap checks) and fully on `sw doctor`, the probe produces an `EnvironmentReport`:

```ts
interface EnvironmentReport {
  os: { platform: NodeJS.Platform; release: string; arch: string; libc?: "glibc" | "musl"; wsl?: boolean };
  runtime: { name: "node" | "bun" | "deno"; version: string; features: { workerThreads: boolean; sqlite: boolean; compileCache: boolean } };
  resources: { cpus: number; cpuQuota?: number; memTotal: number; memLimit?: number; fdLimit?: number; ephemeralPorts?: [number, number] };
  container: { inside: boolean; runtime?: "docker" | "podman" | "kubernetes" | "lxc" };
  ci: { inside: boolean; provider?: string };
  terminal: { tty: boolean; color: 0 | 1 | 2 | 3; unicode: boolean; width: number };
  network: { proxy?: string; noProxy?: string[]; extraCA: boolean; ipv6: boolean; offline?: boolean };
  tools: { git?: string; docker?: string; toxiproxy?: string; k6?: string };
  project?: { root: string; packageManager?: string; tsconfig?: string[]; frameworks: string[]; monorepo: boolean };
  capabilities: Record<CapabilityId, { available: boolean; reason?: string; fix?: string }>;
}
```

Detection is **non-invasive**: read files and env vars, run `--version` with a 2 s timeout, and do a TCP connect to the Docker socket/named pipe (`//./pipe/docker_engine` on Windows). Results are cached for the run.

`sw doctor` prints a checklist with fixes, e.g.:

```text
✔ Node 24.x   ✔ worker_threads   ✔ node:sqlite
✔ 8 CPUs (cgroup quota: 4.0)  ⚠ fd limit 1024 — high-concurrency tests may fail → ulimit -n 65535
✔ git 2.4x    ✖ docker not reachable → Reliability Lab will use the built-in proxy; Evolution sandbox disabled
⚠ HTTPS_PROXY set — telemetry calls go through proxy; load targets bypass it (set http.proxy to change)
```

## 4. Graceful degradation matrix

| Missing | Effect | Fallback |
|---|---|---|
| `worker_threads` (some runtimes) | Single-thread generator | Lower max rate. Warning |
| Docker | No container sandbox/fault injector | Built-in proxy. Evolution `process` sandbox needs opt-in |
| `git` | Evolution unavailable. No commit metadata | History without git info |
| `node:sqlite` | `history.backend: "sqlite"` unavailable | Falls back to JSONL history with a warning |
| TTY | No live dashboard | Line-based progress every 5 s |
| Telemetry | No server-side metrics | Client-side only + limitation note |
| TypeScript in project | — | Use bundled `typescript` |
| Network to target | Pre-flight fails with exit 5 and a DNS/IPv6/proxy diagnostic | — |

## 5. Distribution channels

| Channel | Command | Notes |
|---|---|---|
| npm (primary) | `npm i -D second-world` / `npx second-world` | `bin`: `sw` and `second-world` (alias, avoids clashes) |
| Docker image | `docker run --rm --network host ghcr.io/<org>/second-world perf ...` | Multi-arch (amd64/arm64), distroless/`node:24-slim` base, non-root user |
| GitHub Action | `uses: <org>/second-world-action@v1` | Wraps CLI, uploads report + job summary |
| Standalone binary (later) | Node SEA build per OS/arch | For machines without Node |
| Devcontainer feature (later) | — | — |

> `--network host` doesn't work the same on Docker Desktop (macOS/Windows), so docs recommend `host.docker.internal` as target there. The probe detects this and hints accordingly.

## 6. CI usage pattern

```yaml
# .github/workflows/perf.yml
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci && npm run build && (npm start &) && npx wait-on http://127.0.0.1:3000/health
      - run: npx sw perf --config sw.config.ts --profile ci --format tty,json,junit,md --fail-on high
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: sw-report, path: .second-world/reports }
```

CI runners are noisy. Use `--profile ci` (lower rates, longer duration, more repetitions), compare against a stored baseline with statistical tests, and never use absolute thresholds tuned on a laptop.
