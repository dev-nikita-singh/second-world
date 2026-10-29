/**
 * Execution sandboxes for Evolution candidates. docs/03-engines/experiments.md §B.3, §B.5 and
 * docs/11-safety-security-privacy.md §5.
 *
 * - "docker": every build/test/invariant/start command runs in a throw-away container
 *   (`docker run --rm`) with identical `--cpus`/`--memory` for all arms, a non-root `--user`,
 *   `--read-only` root fs (+ tmpfs /tmp, HOME=/tmp), the worktree bind-mounted at /work (the only
 *   writable mount), `--network none` for build/test (install uses the default network to reach the
 *   registry). The app container publishes only 127.0.0.1:<port> (needs the default bridge network:
 *   egress is NOT blocked while benchmarking — recorded as a limitation). Containers are named and
 *   force-removed (`docker rm -f`) after every command, also on timeout/cancel.
 * - "process": commands run directly on the host (argv, no shell). Requires explicit opt-in plus
 *   `ctx.safety.requireApproval("evolution-execution", …)` (checked by the engine).
 */
import { execa } from "execa";
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

export async function dockerReachable(timeoutMs = 10_000): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
      reject: false,
      timeout: timeoutMs,
      windowsHide: true,
      stdin: "ignore",
    });
    if (r.exitCode === 0 && String(r.stdout).trim()) return { ok: true };
    return {
      ok: false,
      reason: String(r.stderr || r.shortMessage || "docker info failed")
        .trim()
        .split(/\r?\n/)[0],
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
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
    o.user,
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
  return {
    kind: "docker",
    label: `docker ${o.image} cpus=${o.cpus} memory=${o.memory}`,
    prepare(signal) {
      // Pull once up front: an implicit pull inside `docker run` would count against gate/health timeouts.
      prepared ??= (async () => {
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
        ...dockerArgs(o, name, ro.cwd, network, ro.env ?? {}, ro.mounts ?? [], labelArgs),
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
        const args = dockerArgs(o, name, worktree, "bridge", env, mounts, labelArgs);
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
