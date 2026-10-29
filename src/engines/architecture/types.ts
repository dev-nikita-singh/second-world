/**
 * Architecture Inspector — language-agnostic fact & graph types.
 * See docs/03-engines/architecture-inspector.md §1 (pipeline), §2 (data structures), §5 (honesty).
 *
 * `FileFacts` is what an analyzer adapter (TypeScript today, tree-sitter later) extracts from one
 * source file. It is plain JSON so it can be cached per file (docs/05-optimization.md §3.2).
 * Everything after extraction (graph build, analyses, rules) works on facts only.
 */

export type NodeKind =
  | "route"
  | "handler"
  | "service"
  | "repository"
  | "module"
  | "client"
  | "datastore"
  | "external"
  | "cache"
  | "queue";

export type EdgeKind = "calls" | "imports" | "reads" | "writes" | "publishes" | "consumes" | "configures";

export type ClientKind = "http" | "db" | "cache" | "queue";

/** 1-based line/column, POSIX path relative to the project root. */
export interface Loc {
  file: string;
  line: number;
  column: number;
  endLine?: number;
}

export interface ImportFact {
  specifier: string;
  /** Project-relative POSIX path when the import resolves to a project file. */
  resolved?: string;
  /** Package name for bare specifiers that do not resolve to a project file. */
  external?: string;
  typeOnly: boolean;
  dynamic: boolean;
  /** `import(expr)` / `require(expr)` with a non-literal argument. */
  computed: boolean;
  /** Resolved via workspace-package heuristic (lower confidence). */
  heuristic?: boolean;
  line: number;
  column: number;
}

export interface CallFact {
  /** Unit id of the resolved call target (`file#Qualified.name`). */
  target: string;
  line: number;
  column: number;
  inLoop: boolean;
}

export type UnitKind = "function" | "method" | "handler" | "consumer" | "module-init";

/** A "unit" is a named function/method, an inline route handler, or a module's top-level code. */
export interface UnitFact {
  id: string;
  name: string;
  kind: UnitKind;
  line: number;
  endLine: number;
  async: boolean;
  calls: CallFact[];
}

export interface RouteFact {
  framework: string;
  method: string;
  /** Path as written at the registration site (router prefix composed later). */
  path: string;
  /** Router/app identity, e.g. `src/routes/products.ts#productsRouter:r`. */
  owner: string;
  /** Unit id of the handler, when known. */
  handler?: string;
  /** Names of middlewares/guards/hooks attached at the route itself. */
  middlewares: string[];
  /** Auth middleware identified at the registration site. */
  auth: boolean;
  /** Explicitly marked public (e.g. Nest `@Public()`). */
  public?: boolean;
  params: string[];
  line: number;
  column: number;
  extractor: string;
  confidence: number;
}

/** `app.use(prefix?, ...mw|router)`, `fastify.register(plugin, {prefix})`, `addHook`, `app.route(prefix, sub)`. */
export interface UseFact {
  framework: string;
  owner: string;
  prefix?: string;
  middlewares: string[];
  auth: boolean;
  /** Mounted router identity (same format as RouteFact.owner). */
  targetOwner?: string;
  /** Mounted router factory / plugin unit id: routers created inside this unit get the prefix. */
  targetUnit?: string;
  line: number;
  /** Registration order inside the file (for "use before route" semantics). */
  order: number;
}

export type ClientOp = "calls" | "reads" | "writes" | "publishes" | "consumes" | "configures";

export interface ClientFact {
  kind: ClientKind;
  library: string;
  op: ClientOp;
  /** Logical target: host, datastore/queue/topic name. */
  target: string;
  /** Target name derived from naming heuristics (confidence < 0.6). */
  heuristicTarget?: boolean;
  unit: string;
  line: number;
  column: number;
  endLine: number;
  inLoop: boolean;
  /** HTTP only: true = timeout/AbortSignal found, false = none found, undefined = unknown. */
  timeout?: boolean;
  /** Free-form detail, e.g. "fetch POST", "prisma.user.findMany". */
  detail: string;
  snippet: string;
  extractor: string;
  confidence: number;
}

/** Raw AST-level rule candidate; turned into a Finding by the rule layer (config, suppression, reachability). */
export interface RuleHit {
  ruleId: string;
  line: number;
  column: number;
  endLine?: number;
  unit: string;
  /** Enclosing symbol for the fingerprint (stable across line shifts). */
  symbol: string;
  /** Normalised snippet (whitespace-collapsed source text) for the fingerprint. */
  snippet: string;
  message: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  /** Only report when the unit is reachable from a route handler / consumer. */
  requiresHandler?: boolean;
  data?: Record<string, string | number | boolean>;
}

export interface Suppression {
  /** Target line the suppression applies to (0 = whole file). */
  line: number;
  rules: string[];
  reason: string;
}

export interface FactLimitation {
  code: string;
  message: string;
}

export interface FileFacts {
  file: string;
  /** sha256 of the file content at extraction time. */
  hash: string;
  /** Project files this file's facts depend on (resolved imports) → their hash ("" = missing). */
  deps: Record<string, string>;
  language: string;
  imports: ImportFact[];
  units: UnitFact[];
  routes: RouteFact[];
  uses: UseFact[];
  clients: ClientFact[];
  hits: RuleHit[];
  suppressions: Suppression[];
  /** Project-wide flags, e.g. "axios.defaults.timeout". */
  flags: string[];
  limitations: FactLimitation[];
}

export interface EdgeEvidence {
  file: string;
  line: number;
  column: number;
  extractor: string;
  confidence: number;
  snippetHash?: string;
  /** Derived from naming heuristics (confidence < 0.6). */
  heuristic?: boolean;
}

export interface ComponentNode {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  line?: number;
  library?: string;
  framework?: string;
  heuristic?: boolean;
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface ArchEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: EdgeEvidence[];
}

export interface RouteInfo {
  id: string;
  framework: string;
  method: string;
  path: string;
  handler?: string;
  middlewares: string[];
  auth: boolean;
  file: string;
  line: number;
}

export interface CycleInfo {
  /** Files (modules) in the strongly connected component. */
  members: string[];
  /** Shortest example cycle a → b → … → a, starting at the lexicographically smallest file. */
  example: string[];
}

export interface NodeMetric {
  id: string;
  fanIn: number;
  fanOut: number;
}

export interface ArchitectureMetrics {
  files: number;
  filesFromCache: number;
  modules: number;
  components: number;
  edges: number;
  routes: number;
  cycles: number;
  /** Top coupled nodes by fan-in × fan-out. */
  hubs: NodeMetric[];
  /** Longest call chain (routes/handlers/services → deps) on the condensation DAG. */
  deepestChain: { length: number; path: string[] };
  durationMs: number;
  analyzeMs: number;
}

export interface SuppressedFinding {
  ruleId: string;
  file: string;
  line: number;
  reason: string;
}
