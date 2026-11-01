/**
 * Execution sandboxes for Evolution candidates. docs/03-engines/experiments.md §B.3, §B.5 and
 * docs/11-safety-security-privacy.md §5.
 *
 * - "docker": every build/test/invariant/start command runs in a throw-away container
 *   (`docker run --rm`) with identical `--cpus`/`--memory` for all arms, a non-root `--user` (on a
 *   rootless Linux engine "0:0", which is the unprivileged host user — see sandboxUser),
 *   `--read-only` root fs (+ tmpfs /tmp, HOME=/tmp), the worktree bind-mounted at /work (the only
 *   writable mount), `--network none` for build/test (install uses the default network to reach the
 *   registry). The app container publishes only 127.0.0.1:<port> (needs the default bridge network:
 *   egress is NOT blocked while benchmarking — recorded as a limitation). Containers are named and
 *   force-removed (`docker rm -f`) after every command, also on timeout/cancel.
 * - "process": commands run directly on the host (argv, no shell). Requires explicit opt-in plus
 *   `ctx.safety.requireApproval("evolution-execution", …)` (checked by the engine).
 */
import { execa } from "execa";
import { type ProbeExec, probeContainerEngine } from "../../adapters/faults/docker.js";
import type { LaunchPlan } from "./app.js";
import { type CommandResult, type CommandSpec, describeFailure, runCommand, toArgv } from "./command.js";

export interface SandboxRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** "install" allows network egress in the docker sandbox. */
  phase: "install" | "build" | "test" | "invariant";
  /** Extra read-only mounts host → container path (docker only). */
  mounts?: { host: string; container: string }[];
}

export interface Sandbox {
  kind: "docker" | "process";
  /** Folded into the What-If arm fingerprint (identical for all arms). */
  label: string;
  run(cmd: CommandSpec, opts: SandboxRunOptions): Promise<CommandResult>;
  /** Launch wrapper for the app start command (undefined = run on the host). */
  wrapStart(
    worktree: string,
    mounts?: { host: string; container: string }[],
  ): ((plan: LaunchPlan, port: number) => LaunchPlan) | undefined;
  /** One-time preparation before the first command (docker: pull the image when missing). */
  prepare?(signal?: AbortSignal): Promise<void>;
  /** Removes every resource this sandbox created that is still around (docker: containers by label). Never throws. */
  cleanup?(): Promise<number>;
}

/**
 * Is a container engine reachable through the `docker` CLI? Docker, or podman behind a `docker` shim
 * (see probeContainerEngine for the probes; podman is not verified on this project's own machines).
 */
export async function dockerReachable(timeoutMs = 10_000): Promise<{ ok: boolean; reason?: string }> {
  const p = await probeContainerEngine("docker", timeoutMs);
  if (p.version) return { ok: true };
  return { ok: false, reason: p.reason ?? "docker version failed" };
}

export function createProcessSandbox(): Sandbox {
  return {
    kind: "process",
    label: "process",
    run: (cmd, o) =>
      runCommand(cmd, {
        cwd: o.cwd,
        env: o.env ?? {},
        timeoutMs: o.timeoutMs,
        ...(o.signal ? { signal: o.signal } : {}),
      }),
    wrapStart: () => undefined,
  };
}

export interface DockerSandboxOptions {
  image: string;
  cpus: number;
  memory: string;
  network: string;
  user: string;
  /** Prefix for container names. */
  namePrefix: string;
  /** Extra labels (k → v) on every container, in addition to the io.second-world.* labels. */
  labels?: Record<string, string>;
  /** Timeout for `docker pull` when the image is missing (ms). Default 10 minutes. */
  pullTimeoutMs?: number;
  /** Rootless-engine check run by prepare() on Linux (tests). Default: engineRootless(). */
  detectRootless?: () => Promise<boolean>;
  /** Host platform (tests). Default process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Rootless engines (rootless Docker, rootless podman — also behind a `docker` shim) map container
 * uid 0 to the invoking host user and any other container uid to a subordinate uid, which cannot write
 * the bind-mounted worktree (owned by the host user). Probes: Docker lists "name=rootless" in
 * SecurityOptions; podman reports Host.Security.Rootless. Unknown/failed → false (keep the configured user).
 */
export async function engineRootless(exec?: ProbeExec): Promise<boolean> {
  const probes: [string[], (out: string) => boolean][] = [
    [["info", "--format", "{{json .SecurityOptions}}"], (s) => /name=rootless/.test(s)],
    [["info", "--format", "{{.Host.Security.Rootless}}"], (s) => s.trim() === "true"],
  ];
  const run: ProbeExec =
    exec ??
    (async (bin, args, timeoutMs) => {
      const r = await execa(bin, args, { ...quiet, timeout: timeoutMs });
      return { exitCode: r.exitCode, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
    });
  for (const [args, isRootless] of probes) {
    try {
      const r = await run("docker", args, 15_000);
      if (r.exitCode === 0 && r.stdout.trim() && r.stdout.trim() !== "<no value>")
        return isRootless(r.stdout);
    } catch {
      // try the next probe
    }
  }
  return false;
}

/**
 * The `--user` for sandbox containers. On a rootless Linux engine "0:0" is the invoking (unprivileged)
 * host user, the only uid that can write the worktree; `--read-only`, `no-new-privileges` and the
 * user namespace still apply. Elsewhere the configured user (defaultDockerUser: host uid:gid on Linux).
 */
export function sandboxUser(configured: string, platform: NodeJS.Platform, rootless: boolean): string {
  return platform === "linux" && rootless ? "0:0" : configured;
}

let containerSeq = 0;
let sandboxSeq = 0;

/** Label keys set on every sandbox container (`docker ps -a --filter label=…`). */
export const SANDBOX_LABELS = {
  owner: "io.second-world.owner",
  sandbox: "io.second-world.sandbox",
  pid: "io.second-world.pid",
  instance: "io.second-world.instance",
} as const;

export function defaultDockerUser(fallback: string): string {
  const getuid = (process as { getuid?: () => number }).getuid;
  const getgid = (process as { getgid?: () => number }).getgid;
  if (process.platform !== "win32" && getuid && getgid) {
    const uid = getuid();
    if (uid !== 0) return `${uid}:${getgid()}`;
  }
  return fallback;
}

/**
 * `--mount type=bind` args. Docker Desktop on Windows accepts the native host path (`C:\x\y`) as the
 * source; with `--mount` (unlike `-v src:dst`) a drive-letter colon is never taken for the separator.
 * Exported for tests.
 */
export function bindMount(host: string, container: string, readonly: boolean): string[] {
  if (host.includes(",") || container.includes(","))
    throw new Error(`docker sandbox: mount paths must not contain "," (${host})`);
  return ["--mount", `type=bind,source=${host},target=${container}${readonly ? ",readonly" : ""}`];
}

function dockerArgs(
  o: DockerSandboxOptions,
  user: string,
  name: string,
  worktree: string,
  network: string,
  env: Record<string, string>,
  mounts: { host: string; container: string }[],
  labels: string[],
): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    ...labels,
    "--cpus",
    String(o.cpus),
    "--memory",
    o.memory,
    "--network",
    network,
    "--user",
    user,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec",
    "--security-opt",
    "no-new-privileges",
    ...bindMount(worktree, "/work", false),
    "-w",
    "/work",
    "-e",
    "HOME=/tmp",
    "-e",
    "npm_config_cache=/tmp/.npm",
  ];
  for (const m of mounts) args.push(...bindMount(m.host, m.container, true));
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  return args;
}

async function removeContainer(name: string): Promise<void> {
  await execa("docker", ["rm", "-f", name], {
    reject: false,
    timeout: 30_000,
    windowsHide: true,
    stdin: "ignore",
  });
}

const quiet = { reject: false, windowsHide: true, stdin: "ignore" } as const;

/** True when `image` is present locally. */
export async function dockerImagePresent(image: string): Promise<boolean> {
  const r = await execa("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    ...quiet,
    timeout: 30_000,
  });
  return r.exitCode === 0;
}

export function createDockerSandbox(o: DockerSandboxOptions): Sandbox {
  const instance = `${process.pid}-${++sandboxSeq}`;
  const labelArgs = Object.entries({
    [SANDBOX_LABELS.owner]: "second-world",
    [SANDBOX_LABELS.sandbox]: o.namePrefix.replace(/^sw-/, "") || "sandbox",
    [SANDBOX_LABELS.pid]: String(process.pid),
    [SANDBOX_LABELS.instance]: instance,
    ...o.labels,
  }).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  let prepared: Promise<void> | undefined;
  let user = o.user;
  const platform = o.platform ?? process.platform;
  return {
    kind: "docker",
    label: `docker ${o.image} cpus=${o.cpus} memory=${o.memory}`,
    prepare(signal) {
      // Pull once up front: an implicit pull inside `docker run` would count against gate/health timeouts.
      prepared ??= (async () => {
        if (platform === "linux") {
          user = sandboxUser(o.user, platform, await (o.detectRootless ?? engineRootless)());
        }
        if (await dockerImagePresent(o.image)) return;
        const r = await runCommand(["docker", "pull", o.image], {
          cwd: process.cwd(),
          timeoutMs: o.pullTimeoutMs ?? 600_000,
          ...(signal ? { signal } : {}),
        });
        if (!r.ok) throw new Error(`docker pull ${o.image} failed: ${describeFailure(r)}`);
      })();
      prepared.catch(() => {
        prepared = undefined;
      });
      return prepared;
    },
    async cleanup() {
      const r = await execa(
        "docker",
        ["ps", "-aq", "--filter", `label=${SANDBOX_LABELS.instance}=${instance}`],
        { ...quiet, timeout: 30_000 },
      );
      const ids = String(r.stdout ?? "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (ids.length > 0) await execa("docker", ["rm", "-f", ...ids], { ...quiet, timeout: 60_000 });
      return ids.length;
    },
    async run(cmd, ro) {
      const name = `${o.namePrefix}-${process.pid}-${++containerSeq}`;
      const network = ro.phase === "install" ? "bridge" : o.network;
      const argv = [
        "docker",
        ...dockerArgs(o, user, name, ro.cwd, network, ro.env ?? {}, ro.mounts ?? [], labelArgs),
        o.image,
        ...toArgv(cmd),
      ];
      try {
        return await runCommand(argv, {
          cwd: ro.cwd,
          timeoutMs: ro.timeoutMs,
          ...(ro.signal ? { signal: ro.signal } : {}),
        });
      } finally {
        await removeContainer(name);
      }
    },
    wrapStart(worktree, mounts = []) {
      return (plan: LaunchPlan, port: number): LaunchPlan => {
        const name = `${o.namePrefix}-${process.pid}-${++containerSeq}`;
        // Inside the container the app must listen on 0.0.0.0 for the published port: HOST is set by convention.
        const env = {
          HOST: "0.0.0.0",
          ...Object.fromEntries(
            Object.entries(plan.env).filter((e): e is [string, string] => e[1] !== undefined),
          ),
        };
        const args = dockerArgs(o, user, name, worktree, "bridge", env, mounts, labelArgs);
        args.push("-p", `127.0.0.1:${port}:${port}`);
        return {
          argv: ["docker", ...args, o.image, ...plan.argv],
          cwd: plan.cwd,
          env: {},
          cleanup: () => removeContainer(name),
        };
      };
    },
  };
}
