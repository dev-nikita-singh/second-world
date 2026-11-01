/**
 * Docker injector via the docker CLI (execa, no shell, no dockerode). See docs/03-engines/reliability-lab.md §1
 * and docs/06-environments-and-portability.md §2 (Docker named pipe on Windows is handled by the CLI).
 *
 * container faults: pause → unpause; stop → start; restart (one-shot; revert ensures it runs);
 * network-disconnect → network connect. Reverts are persisted in the ledger and armed in a detached
 * watchdog (crash-safe), so a paused dependency never stays paused.
 */
import { type Action, ExternalInjectorBase, type ExternalInjectorOptions } from "./external.js";
import type { Fault, InjectorCapabilities } from "./types.js";

export interface DockerInjectorOptions extends ExternalInjectorOptions {
  /** CLI binary: "docker" (default) or "podman". */
  bin?: string;
  /** Probe timeout (ms). Default 3000. */
  probeTimeoutMs?: number;
  /** Probe override (tests). */
  probe?: () => Promise<string | null>;
  /**
   * `docker inspect -f <format> <container>` override (tests). Default: the CLI — skipped when a fake
   * `exec` is injected without an inspect.
   */
  inspect?: (container: string, format: string) => Promise<string | null>;
}

/**
 * Container-engine probes, tried in order until one prints a version:
 * - `version --format {{.Server.Version}}`: Docker (any OS), and podman in remote mode (podman machine
 *   on macOS/Windows), where a server section exists.
 * - `info --format {{.Version.Version}}`: local podman (Linux, also behind a `docker` → podman shim),
 *   which has no `.Server` in `version` and no `.ServerVersion` in `info`.
 * Both fail (non-zero exit) when the daemon/socket is unreachable.
 */
export const CONTAINER_ENGINE_PROBES: readonly (readonly string[])[] = [
  ["version", "--format", "{{.Server.Version}}"],
  ["info", "--format", "{{.Version.Version}}"],
];

export interface ContainerEngineProbe {
  /** Server/engine version, or null when no probe succeeded. */
  version: string | null;
  /** First line of the first probe's error when version is null. */
  reason?: string;
}

/** One CLI call for the probe: exitCode undefined = could not run (ENOENT) or timed out. */
export type ProbeExec = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number | undefined; stdout: string; stderr: string }>;

const execaProbe: ProbeExec = async (bin, args, timeoutMs) => {
  const { execa } = await import("execa");
  const r = await execa(bin, args, { timeout: timeoutMs, reject: false, windowsHide: true, stdin: "ignore" });
  return {
    exitCode: r.timedOut ? undefined : r.exitCode,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr || r.shortMessage || ""),
  };
};

/** Probes the container engine behind `bin` (docker or podman). Never throws. */
export async function probeContainerEngine(
  bin = "docker",
  timeoutMs = 3000,
  exec: ProbeExec = execaProbe,
): Promise<ContainerEngineProbe> {
  let reason: string | undefined;
  try {
    for (const args of CONTAINER_ENGINE_PROBES) {
      const r = await exec(bin, [...args], timeoutMs);
      const v = r.stdout.trim();
      // "<no value>" = the template field does not exist in this engine's output.
      if (r.exitCode === 0 && v && v !== "<no value>") return { version: v };
      reason ??= (r.stderr.trim() || `${bin} ${args[0]} failed`).split(/\r?\n/)[0];
      // ENOENT/timeout: the binary is missing or hung; the next probe would fail the same way.
      if (r.exitCode === undefined) break;
    }
  } catch (e) {
    reason ??= (e as Error).message;
  }
  return { version: null, ...(reason ? { reason } : {}) };
}

/** Returns the container server version (docker or podman), or null when it is not reachable. */
export async function dockerServerVersion(bin = "docker", timeoutMs = 3000): Promise<string | null> {
  return (await probeContainerEngine(bin, timeoutMs)).version;
}

/** Docker CLI errors meaning the revert has nothing left to do. */
const ALREADY_REVERTED =
  /is not paused|already (connected|started|running)|already exists in network|is not connected|no such container/i;

export class DockerInjector extends ExternalInjectorBase {
  readonly name = "docker";
  readonly bin: string;
  private readonly d: DockerInjectorOptions;
  private cached: string | null | undefined;

  constructor(opts: DockerInjectorOptions = {}) {
    super(opts);
    this.d = opts;
    this.bin = opts.bin ?? "docker";
  }

  async capabilities(): Promise<InjectorCapabilities> {
    if (this.cached === undefined) {
      this.cached = this.d.probe
        ? await this.d.probe()
        : await dockerServerVersion(this.bin, this.d.probeTimeoutMs ?? 3000);
    }
    const ok = this.cached !== null;
    return {
      injector: this.name,
      available: ok,
      ...(ok ? {} : { reason: `${this.bin} daemon not reachable (is Docker running?)` }),
      faults: ["container"],
      partial: false,
      flapping: false,
      countsRequests: false,
    };
  }

  private cmd(args: string[]): Action {
    return { kind: "exec", file: this.bin, args };
  }

  /** Revert command: "already in that state" counts as success, also when replayed from the ledger. */
  private undo(args: string[]): Action {
    return { kind: "exec", file: this.bin, args, alreadyDone: ALREADY_REVERTED.source };
  }

  private async inspect(container: string, format: string): Promise<string | null> {
    if (this.d.inspect) return this.d.inspect(container, format);
    if (this.opts.exec) return null; // fake exec (tests): no real daemon to ask
    const { execa } = await import("execa");
    const r = await execa(this.bin, ["inspect", "-f", format, container], {
      reject: false,
      timeout: 15_000,
      windowsHide: true,
      stdin: "ignore",
    });
    return r.exitCode === 0 ? String(r.stdout ?? "").trim() : null;
  }

  protected async applyActions(fault: Fault): Promise<Action[]> {
    if (fault.type !== "container") throw new Error(`docker injector does not support fault "${fault.type}"`);
    switch (fault.action) {
      case "pause":
        return [this.cmd(["pause", fault.container])];
      case "stop":
        // `docker stop` DELETES a container started with --rm: the revert (`docker start`) could never
        // bring it back. Refuse instead of destroying the dependency.
        if ((await this.inspect(fault.container, "{{.HostConfig.AutoRemove}}")) === "true")
          throw new Error(
            `refusing to stop container "${fault.container}": it was started with --rm, so stopping removes it and the fault could not be reverted (use action "pause" or "restart")`,
          );
        return [this.cmd(["stop", "-t", "1", fault.container])];
      case "restart":
        return [this.cmd(["restart", "-t", "1", fault.container])];
      case "network-disconnect":
        if (!fault.network) throw new Error("network-disconnect requires `network`");
        return [this.cmd(["network", "disconnect", fault.network, fault.container])];
    }
  }

  protected revertActions(fault: Fault): Action[] {
    if (fault.type !== "container") return [];
    switch (fault.action) {
      case "pause":
        return [this.undo(["unpause", fault.container])];
      case "stop":
      case "restart":
        return [this.undo(["start", fault.container])];
      case "network-disconnect":
        return fault.network ? [this.undo(["network", "connect", fault.network, fault.container])] : [];
    }
  }

  /** Revert actions tolerate "already in that state" / "no such container" errors (nothing left to revert). */
  protected override async exec(a: Action, phase: "apply" | "revert" = "revert"): Promise<void> {
    try {
      await super.exec(a, phase);
    } catch (e) {
      if (phase === "apply") throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (ALREADY_REVERTED.test(msg)) return;
      throw e;
    }
  }
}

export function createDockerInjector(opts: DockerInjectorOptions = {}): DockerInjector {
  return new DockerInjector(opts);
}
