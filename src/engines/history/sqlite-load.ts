/**
 * Lazy loader for `node:sqlite` (docs/03-engines/evidence-and-history.md §B.1 "SQLite backend").
 *
 * - Loaded only when `history.backend: "sqlite"` is used: nothing on the CLI startup path imports
 *   this file (tests/unit/design/startup-budget.test.ts).
 * - Node 22/24 print `ExperimentalWarning: SQLite is an experimental feature…` the first time the
 *   module is loaded. Only THAT warning is dropped (matched on the warning type and its message);
 *   every other warning — including other ExperimentalWarnings emitted meanwhile — passes through.
 * - Unavailable (older Node, Bun/Deno without it, `--no-experimental-sqlite`) → `null`, and the
 *   caller falls back to JSONL with a warning.
 */
type SqliteModule = typeof import("node:sqlite");

/** The exact warning node:sqlite emits on first load (Node 22.13+ … 24.x). */
export function isNodeSqliteWarning(warning: unknown, type?: unknown): boolean {
  const name =
    typeof type === "string"
      ? type
      : typeof type === "object" && type !== null && typeof (type as { type?: unknown }).type === "string"
        ? (type as { type: string }).type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const message = warning instanceof Error ? warning.message : typeof warning === "string" ? warning : "";
  return name === "ExperimentalWarning" && /^SQLite is an experimental feature\b/.test(message);
}

let loading: Promise<SqliteModule | null> | undefined;
let unavailableReason: string | undefined;

/** Imports node:sqlite once per process, dropping only its own ExperimentalWarning. */
export function loadNodeSqlite(): Promise<SqliteModule | null> {
  loading ??= (async () => {
    const original = process.emitWarning;
    const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]): void {
      if (isNodeSqliteWarning(warning, rest[0])) return;
      (original as (...a: unknown[]) => void).call(process, warning, ...rest);
    };
    process.emitWarning = filtered as typeof process.emitWarning;
    try {
      const m = (await import("node:sqlite")) as SqliteModule;
      if (typeof m.DatabaseSync !== "function") {
        unavailableReason = "node:sqlite has no DatabaseSync";
        return null;
      }
      return m;
    } catch (e) {
      unavailableReason = (e as Error).message;
      return null;
    } finally {
      // Restore unless something else replaced emitWarning in the meantime (then leave theirs alone).
      if (process.emitWarning === filtered) process.emitWarning = original;
    }
  })();
  return loading;
}

/** Why node:sqlite could not be loaded (after `loadNodeSqlite()` returned null). */
export function nodeSqliteUnavailableReason(): string | undefined {
  return unavailableReason;
}

/** Test seam: forget the cached module (the next load imports again). */
export function resetNodeSqliteLoaderForTests(): void {
  loading = undefined;
  unavailableReason = undefined;
}
