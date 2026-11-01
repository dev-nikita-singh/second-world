/**
 * Container-engine probe used by the evolution sandbox, the docker fault injector and the live Docker
 * tests (src/adapters/faults/docker.ts probeContainerEngine). The podman cases replay the CLI behaviour
 * of a `docker` → podman shim (no `.ServerVersion` in `info`, no `.Server` in local `version`); they are
 * simulated here, not run against a real podman.
 */
import { describe, expect, it } from "vitest";
import { type ProbeExec, probeContainerEngine } from "../../../src/adapters/faults/docker.js";
import {
  createDockerSandbox,
  engineRootless,
  sandboxUser,
} from "../../../src/engines/experiments/sandbox.js";

type Reply = { exitCode: number | undefined; stdout: string; stderr: string };

function fakeExec(replies: Record<string, Reply>): { exec: ProbeExec; calls: string[] } {
  const calls: string[] = [];
  const exec: ProbeExec = async (_bin, args) => {
    const key = args.join(" ");
    calls.push(key);
    return replies[key] ?? { exitCode: 1, stdout: "", stderr: `unknown ${key}` };
  };
  return { exec, calls };
}

const VERSION = "version --format {{.Server.Version}}";
const INFO = "info --format {{.Version.Version}}";

describe("probeContainerEngine", () => {
  it("docker: the server version from `docker version`, one call", async () => {
    const f = fakeExec({ [VERSION]: { exitCode: 0, stdout: "29.3.0\n", stderr: "" } });
    expect(await probeContainerEngine("docker", 1000, f.exec)).toEqual({ version: "29.3.0" });
    expect(f.calls).toEqual([VERSION]);
  });

  it("local podman behind a docker shim: falls back to `info {{.Version.Version}}`", async () => {
    const f = fakeExec({
      [VERSION]: {
        exitCode: 125,
        stdout: "",
        stderr: 'Error: template: version:1:9: executing "version" at <.Server.Version>: nil pointer',
      },
      [INFO]: { exitCode: 0, stdout: "4.9.3", stderr: "" },
    });
    expect(await probeContainerEngine("docker", 1000, f.exec)).toEqual({ version: "4.9.3" });
    expect(f.calls).toEqual([VERSION, INFO]);
  });

  it("a template field the engine lacks printing <no value> does not count as reachable", async () => {
    const f = fakeExec({
      [VERSION]: { exitCode: 0, stdout: "<no value>", stderr: "" },
      [INFO]: { exitCode: 0, stdout: "5.0.1", stderr: "" },
    });
    expect((await probeContainerEngine("docker", 1000, f.exec)).version).toBe("5.0.1");
  });

  it("daemon down: null with the first error line as the reason", async () => {
    const f = fakeExec({
      [VERSION]: {
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs it running?",
      },
      [INFO]: { exitCode: 1, stdout: "", stderr: "template: can't evaluate field Version" },
    });
    expect(await probeContainerEngine("docker", 1000, f.exec)).toEqual({
      version: null,
      reason: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    });
  });

  it("binary missing or hung: stops after the first probe", async () => {
    const f = fakeExec({ [VERSION]: { exitCode: undefined, stdout: "", stderr: "spawn docker ENOENT" } });
    expect(await probeContainerEngine("docker", 1000, f.exec)).toEqual({
      version: null,
      reason: "spawn docker ENOENT",
    });
    expect(f.calls).toEqual([VERSION]);
  });

  it("an exec that throws never escapes", async () => {
    const exec: ProbeExec = async () => {
      throw new Error("boom");
    };
    expect(await probeContainerEngine("docker", 1000, exec)).toEqual({ version: null, reason: "boom" });
  });
});

describe("sandbox --user on rootless engines (Linux)", () => {
  const SEC = "info --format {{json .SecurityOptions}}";
  const PODMAN = "info --format {{.Host.Security.Rootless}}";

  it("rootless Docker: SecurityOptions lists name=rootless", async () => {
    const f = fakeExec({
      [SEC]: { exitCode: 0, stdout: '["name=seccomp,profile=builtin","name=rootless"]', stderr: "" },
    });
    expect(await engineRootless(f.exec)).toBe(true);
  });

  it("rootful Docker: not rootless", async () => {
    const f = fakeExec({ [SEC]: { exitCode: 0, stdout: '["name=seccomp,profile=builtin"]', stderr: "" } });
    expect(await engineRootless(f.exec)).toBe(false);
  });

  it("podman (no SecurityOptions): Host.Security.Rootless", async () => {
    const f = fakeExec({
      [SEC]: { exitCode: 125, stdout: "", stderr: "template: can't evaluate field SecurityOptions" },
      [PODMAN]: { exitCode: 0, stdout: "true\n", stderr: "" },
    });
    expect(await engineRootless(f.exec)).toBe(true);
    expect(f.calls).toEqual([SEC, PODMAN]);
  });

  it("unknown engine output: not rootless (keeps the configured user)", async () => {
    expect(await engineRootless(fakeExec({}).exec)).toBe(false);
  });

  it("sandboxUser: 0:0 only for a rootless engine on Linux", () => {
    expect(sandboxUser("1001:121", "linux", true)).toBe("0:0");
    expect(sandboxUser("1001:121", "linux", false)).toBe("1001:121");
    expect(sandboxUser("1000:1000", "darwin", true)).toBe("1000:1000");
    expect(sandboxUser("1000:1000", "win32", true)).toBe("1000:1000");
  });

  it("prepare() on a rootless Linux engine switches the container --user", async () => {
    const sb = createDockerSandbox({
      image: "sw-test-image-that-does-not-exist:0",
      cpus: 1,
      memory: "256m",
      network: "none",
      user: "1001:121",
      namePrefix: "sw-evolve",
      platform: "linux",
      detectRootless: async () => true,
      pullTimeoutMs: 1,
    });
    const userOf = (): string | undefined => {
      const argv = sb.wrapStart("/w")?.({ argv: ["node"], cwd: "/w", env: {} }, 4000).argv ?? [];
      return argv[argv.indexOf("--user") + 1];
    };
    expect(userOf()).toBe("1001:121");
    await sb.prepare?.().catch(() => undefined); // image pull fails (or docker absent): user is decided first
    expect(userOf()).toBe("0:0");
  });
});
