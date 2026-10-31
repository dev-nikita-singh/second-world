/**
 * Project-level `sw doctor` checks (docs/06-environments-and-portability.md §3): is there a config
 * for this directory, and is the optional `typescript` peer installed (docs/07-libraries.md; needed by
 * `sw inspect` and the static part of `sw model build`). Read-only; never throws.
 */
import { createRequire } from "node:module";
import { discoverConfigFile } from "../config/loader.js";
import type { DoctorCheck } from "./probe.js";

export interface ProjectCheckOptions {
  cwd: string;
  /** `-c/--config` as typed by the user (resolved against cwd by the caller). */
  configPath?: string;
  /** Injected for tests. Default: walks up from cwd like the config loader. */
  discoverConfig?: (cwd: string) => string | undefined;
  /** Injected for tests. Default: resolves `typescript/package.json` from this package; null if absent. */
  typescriptVersion?: () => string | null;
  /** Injected for tests. Default: node:fs existsSync. */
  exists?: (p: string) => boolean;
}

/** Version of the `typescript` package second-world would load, or null when it is not installed. */
export function installedTypescriptVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("typescript/package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return null;
  }
}

/** Config and optional-dependency checks for the current project. */
export async function projectChecks(o: ProjectCheckOptions): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  try {
    if (o.configPath) {
      const exists = o.exists ?? (await import("node:fs")).existsSync;
      out.push(
        exists(o.configPath)
          ? { id: "config", status: "ok", label: `config ${o.configPath}` }
          : {
              id: "config",
              status: "warn",
              label: `config not found: ${o.configPath}`,
              fix: "Check the -c/--config path, or run `sw init` to create sw.config.ts",
            },
      );
    } else {
      const found = (o.discoverConfig ?? discoverConfigFile)(o.cwd);
      out.push(
        found
          ? { id: "config", status: "ok", label: `config ${found}` }
          : {
              id: "config",
              status: "info",
              label: "no sw.config.* found here or in parent folders",
              fix: "Run `sw init` to create one, or pass a URL: `sw perf http://127.0.0.1:3000`",
            },
      );
    }
  } catch {
    // discovery problems surface when a command loads the config
  }
  const ts = (o.typescriptVersion ?? installedTypescriptVersion)();
  out.push(
    ts
      ? { id: "typescript", status: "ok", label: `typescript ${ts} (sw inspect, sw model build)` }
      : {
          id: "typescript",
          status: "info",
          label: "typescript not installed — `sw inspect` and the static part of `sw model build` need it",
          fix: "npm i -D typescript@6 (next to second-world)",
        },
  );
  return out;
}
