/**
 * TypeScript SourceAnalyzer adapter — docs/03-engines/architecture-inspector.md §1.2, docs/05-optimization.md §3.
 * The only module that loads `typescript` (lazily, via dynamic import, so CLI startup stays fast).
 * One Program per run with noEmit/skipLibCheck/allowJs/types:[]; rootNames = files to (re-)extract only
 * (dependencies are loaded on demand for symbol resolution). Never emits or executes project code.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { CapabilityError } from "../../../../core/errors.js";
import path from "node:path";
import type * as ts from "typescript";
import { parseSuppressions } from "../../suppress.js";
import type { FileFacts } from "../../types.js";
import type { AnalyzeRequest, AnalyzeResult, SourceAnalyzer } from "../source-analyzer.js";
import { TsFileContext, type TsModule } from "./context.js";
import { detectorsExtractor, growthBoundExtractor } from "./detectors.js";
import { cacheQueueExtractor, dbClientExtractor, httpClientExtractor } from "./extractors/clients.js";
import { callsExtractor, importsExtractor } from "./extractors/core.js";
import { callRoutesExtractor, nestExtractor, nextExtractor } from "./extractors/routes.js";
import { buildDispatch, type TsExtractor, walkFile } from "./walker.js";

export { TsFileContext } from "./context.js";
export type { TsExtractor } from "./walker.js";

export const BUILTIN_TS_EXTRACTORS: readonly TsExtractor[] = [
  importsExtractor,
  callsExtractor,
  callRoutesExtractor,
  nestExtractor,
  nextExtractor,
  httpClientExtractor,
  dbClientExtractor,
  cacheQueueExtractor,
  detectorsExtractor,
  growthBoundExtractor,
];

const ADAPTER_VERSION = "1";

let tsPromise: Promise<TsModule> | undefined;
export function loadTypeScript(): Promise<TsModule> {
  tsPromise ??= import("typescript").then(
    (m) => (m as { default?: TsModule }).default ?? (m as unknown as TsModule),
    (e: unknown) => {
      tsPromise = undefined;
      // typescript is an optional peer dependency (docs/07-libraries.md): absent → capability error.
      throw new CapabilityError("SW_CAP_TYPESCRIPT", "The Architecture Inspector needs the `typescript` package (5.x or 6.x)", {
        hint: "Install it next to second-world: npm i -D typescript@6",
        cause: e,
      });
    },
  );
  return tsPromise;
}

function typescriptVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = JSON.parse(readFileSync(req.resolve("typescript/package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

export interface TsAnalyzerOptions {
  /** Extra (plugin) extractors run after the built-ins. */
  extractors?: readonly TsExtractor[];
}

export function createTsAnalyzer(opts: TsAnalyzerOptions = {}): SourceAnalyzer {
  const extractors = [...BUILTIN_TS_EXTRACTORS, ...(opts.extractors ?? [])];
  return {
    id: "typescript",
    async signature() {
      return `ts-adapter@${ADAPTER_VERSION};typescript@${typescriptVersion()};${extractors.map((e) => `${e.id}@${e.version}`).join(",")}`;
    },
    async analyze(req: AnalyzeRequest): Promise<AnalyzeResult> {
      const limitations: AnalyzeResult["limitations"] = [];
      if (req.files.length === 0) return { facts: [], limitations };
      const t = await loadTypeScript();
      const options = compilerOptions(t, req, limitations);
      const host = t.createCompilerHost(options, true);
      const rootNames = req.files.map((f) => path.join(req.root, f));
      const program = t.createProgram({ rootNames, options, host });
      const checker = program.getTypeChecker();
      const cache = t.createModuleResolutionCache(
        host.getCurrentDirectory(),
        (s) => host.getCanonicalFileName(s),
        options,
      );
      const projectSet = new Set(req.projectFiles);
      const wsByName = new Map(req.workspaces.map((w) => [w.name, w]));
      const rel = (abs: string) => path.relative(req.root, abs).split(path.sep).join("/");
      const enabled = extractors.filter(
        (e) => !e.framework || req.frameworks === "auto" || req.frameworks.includes(e.framework),
      );
      const dispatch = buildDispatch(t, enabled);

      const facts: FileFacts[] = [];
      for (const file of req.files) {
        if (req.signal?.aborted) break;
        const abs = path.join(req.root, file);
        const sf = program.getSourceFile(abs);
        if (!sf) {
          limitations.push({
            code: "ARCH_PARSE_FAILED",
            message: `could not load ${file} into the TypeScript program`,
          });
          continue;
        }
        const ctx = new TsFileContext({
          ts: t,
          checker,
          sf,
          root: req.root,
          file,
          hash: req.hashes.get(file) ?? "",
          projectFiles: projectSet,
        });
        ctx.frameworks = req.frameworks;
        ctx.resolveModule = (spec: string) => {
          let r: ts.ResolvedModuleFull | undefined;
          try {
            r = t.resolveModuleName(spec, abs, options, host, cache).resolvedModule;
          } catch {
            r = undefined;
          }
          if (r) {
            const rf = rel(path.resolve(r.resolvedFileName));
            if (projectSet.has(rf)) return { resolved: rf };
            // declaration next to a project source (e.g. resolved .d.ts) — map back when possible
            const src = rf.replace(/\.d\.(m|c)?ts$/, ".ts");
            if (projectSet.has(src)) return { resolved: src };
          }
          if (!spec.startsWith(".") && !spec.startsWith("/")) {
            const pn = packageName(spec);
            const ws = wsByName.get(pn);
            if (ws?.entry && spec === pn && projectSet.has(ws.entry))
              return { resolved: ws.entry, heuristic: true };
            return { external: pn };
          }
          return {};
        };
        try {
          walkFile(ctx, dispatch, req.signal);
          for (const ex of enabled) ex.finish?.(ctx);
        } catch (e) {
          limitations.push({
            code: "ARCH_EXTRACT_FAILED",
            message: `extraction failed for ${file}: ${(e as Error).message}`,
          });
        }
        const f = ctx.finalize();
        f.suppressions = parseSuppressions(sf.text);
        for (const d of Object.keys(f.deps)) f.deps[d] = d.startsWith("?") ? "" : (req.hashes.get(d) ?? "");
        facts.push(f);
      }
      return { facts, limitations };
    },
  };
}

function compilerOptions(
  t: TsModule,
  req: AnalyzeRequest,
  limitations: AnalyzeResult["limitations"],
): ts.CompilerOptions {
  let base: ts.CompilerOptions = {
    target: t.ScriptTarget.ES2022,
    module: t.ModuleKind.ESNext,
    moduleResolution: t.ModuleResolutionKind.Bundler,
    jsx: t.JsxEmit.Preserve,
    experimentalDecorators: true,
    esModuleInterop: true,
    resolveJsonModule: true,
  };
  if (req.tsconfig) {
    const read = t.readConfigFile(req.tsconfig, t.sys.readFile);
    if (read.error) {
      limitations.push({
        code: "ARCH_TSCONFIG_INVALID",
        message: `tsconfig could not be read: ${t.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
      });
    } else {
      const parsed = t.parseJsonConfigFileContent(
        read.config,
        t.sys,
        path.dirname(req.tsconfig),
        undefined,
        req.tsconfig,
      );
      base = { ...base, ...parsed.options };
    }
  }
  return {
    ...base,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: false,
    types: [],
    declaration: false,
    sourceMap: false,
    composite: false,
    incremental: false,
    plugins: [],
  };
}
