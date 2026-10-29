/** Fault injectors (Reliability Lab). See docs/03-engines/reliability-lab.md §1. */
export {
  BuiltinFaultProxy,
  type BuiltinProxyOptions,
  type ProxyStats,
  startFaultProxy,
} from "./builtin-proxy.js";
export {
  armTtl,
  type CleanupAllResult,
  type CleanupFn,
  CleanupStack,
  cleanupAll,
  cleanupHooksInstalled,
  defaultLedgerPath,
  type LedgerEntry,
  pendingGlobalCleanups,
  type RevertAction,
  readLedger,
  registerGlobalCleanup,
  runRevertAction,
  spawnWatchdog,
} from "./cleanup.js";
export {
  createDockerInjector,
  DockerInjector,
  type DockerInjectorOptions,
  dockerServerVersion,
} from "./docker.js";
export { type Action, ExternalInjectorBase, type ExternalInjectorOptions } from "./external.js";
export { createToxiproxyInjector, ToxiproxyInjector, type ToxiproxyOptions } from "./toxiproxy.js";
export {
  ALL_FAULT_TYPES,
  type AppliedFault,
  describeFault,
  type Fault,
  type FaultInjector,
  type FaultInput,
  FaultSchema,
  type FaultType,
  flapActive,
  type InjectorCapabilities,
  parseFault,
  selectByCounter,
} from "./types.js";
