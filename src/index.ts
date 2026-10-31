/**
 * Public API of `second-world`. See docs/09-cli-and-api.md §2 and §3 (stability policy).
 */

export { createFakeClock, type FakeClock, systemClock } from "./core/clock.js";
export {
  collectSecretValues,
  type LoadConfigOptions,
  loadConfig,
  type ResolvedConfig,
  resolveSecret,
} from "./core/config/loader.js";
export {
  type Config,
  type ConfigInput,
  ConfigSchema,
  configJsonSchema,
  defineConfig,
  type SecretRef,
} from "./core/config/schema.js";
export {
  evaluateThreshold,
  formatThreshold,
  parseThreshold,
  parseThresholdEntry,
  parseThresholds,
  type Threshold,
  type ThresholdEntry,
  type ThresholdOp,
  type ThresholdSpec,
  type ThresholdUnit,
} from "./core/config/thresholds.js";
export {
  formatBytes,
  formatDuration,
  parseBytes,
  parseDuration,
  parsePercent,
  parseRate,
} from "./core/config/units.js";
export {
  type CreateEngineContextOptions,
  createEngineContext,
  stubEnvironmentReport,
} from "./core/context.js";
export * from "./core/errors.js";
export { createEventBus, type TypedEventBus } from "./core/events.js";
export * from "./core/evidence/schemas.js";
export {
  type CreateFindingInput,
  createEvidenceStore,
  createFinding,
  defaultFingerprint,
  type EvidenceStoreEx,
} from "./core/evidence/store.js";
export { createLogger, createMemoryLogger, type LoggerOptions, silentLogger } from "./core/log/logger.js";
export {
  createRedactor,
  DEFAULT_REDACT_HEADERS,
  type Redactor,
  type RedactorOptions,
  type RedactPattern,
  redactionMarker,
  shannonEntropy,
} from "./core/log/redact.js";
export { planWorkflow, runWorkflow, type WorkflowResult, type WorkflowStep } from "./core/orchestrator.js";
export { type DoctorCheck, doctorChecks, type ProbeOptions, probeEnvironment } from "./core/probe/probe.js";
export { createRegistry, type EngineLoader, type EngineRegistry } from "./core/registry.js";
export { createRng } from "./core/rng.js";
export { Gcra, type GcraDecision, type GcraOptions } from "./core/safety/gcra.js";
export {
  type AuditEntry,
  classifyHost,
  createSafetyGuard,
  DEFAULT_SAFETY,
  hostMatches,
  type SafetyConfig,
  type SafetyGuardEx,
  type SafetyGuardOptions,
  type SafetyLease,
  type TargetClass,
  verifyAuditLog,
} from "./core/safety/guard.js";
export type * from "./core/types.js";
export {
  buildPerformanceInput,
  type CreateWorldOptions,
  createWorld,
  type EngineHandle,
  type RunOptions,
  type RunRef,
  type World,
  type WorldHistory,
  type WorldReport,
} from "./core/world.js";

// Reporting public API (docs/09 §2–3): render / write / compare reports outside a World.
export {
  type CombinedReport,
  combineResults,
  computeExitCode,
  type FailOn,
  REPORT_FORMATS,
  type ReportFormat,
  type ReportMeta,
  renderComparison,
  renderReport,
  writeReports,
} from "./engines/reporting/index.js";
