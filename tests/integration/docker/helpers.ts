/**
 * Shared helpers for the live Docker integration tests (tests/integration/docker/**).
 * Every test file skips with `describe.skipIf(!dockerAvailable)` when `docker info` fails, so CI
 * without a daemon stays green. Everything the tests create carries the label TEST_LABEL (plus the
 * labels the code under test sets itself); `removeLabelled()` force-removes only those objects.
 */
import { execa } from "execa";

/** Label put on every container/network the tests create directly. */
export const TEST_LABEL = "io.second-world.test=docker-integration";

export async function dockerInfoOk(): Promise<boolean> {
  try {
    const r = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
      reject: false,
      timeout: 15_000,
      windowsHide: true,
      stdin: "ignore",
    });
    return r.exitCode === 0 && String(r.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

export const dockerAvailable = await dockerInfoOk();

export async function docker(
  args: string[],
  opts: { timeout?: number; reject?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await execa("docker", args, {
    reject: opts.reject ?? false,
    timeout: opts.timeout ?? 60_000,
    windowsHide: true,
    stdin: "ignore",
  });
  return {
    exitCode: r.exitCode ?? -1,
    stdout: String(r.stdout ?? "").trim(),
    stderr: String(r.stderr ?? "").trim(),
  };
}

/** Pulls `image` unless it is present locally (generous timeout). */
export async function ensureImage(image: string, timeout = 300_000): Promise<void> {
  const has = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  if (has.exitCode === 0) return;
  const r = await docker(["pull", image], { timeout });
  if (r.exitCode !== 0) throw new Error(`docker pull ${image} failed: ${r.stderr}`);
}

/** Names of containers (any state) carrying `label` (k=v). */
export async function containersWithLabel(label: string): Promise<string[]> {
  const r = await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]);
  return r.stdout ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export async function networksWithLabel(label: string): Promise<string[]> {
  const r = await docker(["network", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]);
  return r.stdout ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** Force-removes containers and networks carrying `label` (never anything else). */
export async function removeLabelled(label: string): Promise<void> {
  const cs = await containersWithLabel(label);
  if (cs.length > 0) await docker(["rm", "-f", ...cs]);
  const ns = await networksWithLabel(label);
  if (ns.length > 0) await docker(["network", "rm", ...ns]);
}

/** `docker inspect -f <format> <name>` (trimmed), or null when the container does not exist. */
export async function inspect(name: string, format: string): Promise<string | null> {
  const r = await docker(["inspect", "-f", format, name]);
  return r.exitCode === 0 ? r.stdout : null;
}

/** Polls `fn` until it returns true or `timeoutMs` passes. */
export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (performance.now() >= end) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Host port published for `containerPort/tcp` of a container. */
export async function publishedPort(name: string, containerPort: number): Promise<number> {
  const r = await docker(["port", name, `${containerPort}/tcp`]);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("127.0.0.1:") || l.startsWith("0.0.0.0:"));
  const port = Number(line?.split(":").pop());
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`no published port for ${name}: ${r.stdout} ${r.stderr}`);
  return port;
}
