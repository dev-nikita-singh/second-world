/**
 * SourceAnalyzer adapter — docs/03-engines/architecture-inspector.md §1.2–1.3, §6.
 * The adapter turns source files into language-agnostic `FileFacts`. The TypeScript compiler API
 * is isolated behind this interface (analyzer/ts/**) so a TS7-native or web-tree-sitter adapter can
 * be swapped in later; graph building, analyses and rules only see facts.
 */

import type { WorkspacePackage } from "../discovery.js";
import type { FileFacts } from "../types.js";

export interface AnalyzeRequest {
  root: string;
  /** All project files (POSIX, relative), for "is this a project file" checks. */
  projectFiles: readonly string[];
  /** Files to (re-)extract (subset of projectFiles). */
  files: readonly string[];
  /** Current content hash per project file. */
  hashes: ReadonlyMap<string, string>;
  tsconfig?: string;
  workspaces: readonly WorkspacePackage[];
  /** Enabled framework extractor ids ("auto" = all). */
  frameworks: "auto" | readonly string[];
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  facts: FileFacts[];
  /** Adapter/tool version info, part of the cache key. */
  limitations: { code: string; message: string }[];
}

export interface SourceAnalyzer {
  readonly id: string;
  /** Version string that invalidates the facts cache when it changes (adapter + extractors + rules). */
  signature(): Promise<string>;
  analyze(req: AnalyzeRequest): Promise<AnalyzeResult>;
}
