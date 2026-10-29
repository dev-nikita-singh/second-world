/**
 * Error hierarchy and exit codes. See docs/02-architecture.md §4.5 and
 * docs/03-engines/evidence-and-history.md §A.6.
 */

export const ExitCode = {
  Ok: 0,
  Failures: 1,
  ConfigInvalid: 2,
  SafetyBlocked: 3,
  CapabilityMissing: 4,
  TargetUnreachable: 5,
  Internal: 70,
  Cancelled: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface SecondWorldErrorOptions {
  hint?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class SecondWorldError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, exitCode: ExitCode, opts: SecondWorldErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

export class ConfigError extends SecondWorldError {
  constructor(code: `SW_CONFIG_${string}`, message: string, opts?: SecondWorldErrorOptions) {
    super(code, message, ExitCode.ConfigInvalid, opts);
  }
}

export class SafetyError extends SecondWorldError {
  constructor(code: `SW_SAFETY_${string}`, message: string, opts?: SecondWorldErrorOptions) {
    super(code, message, ExitCode.SafetyBlocked, opts);
  }
}

export class CapabilityError extends SecondWorldError {
  constructor(code: `SW_CAP_${string}`, message: string, opts?: SecondWorldErrorOptions) {
    super(code, message, ExitCode.CapabilityMissing, opts);
  }
}

export class TargetError extends SecondWorldError {
  constructor(code: `SW_TARGET_${string}`, message: string, opts?: SecondWorldErrorOptions) {
    super(code, message, ExitCode.TargetUnreachable, opts);
  }
}

export class EngineError extends SecondWorldError {
  constructor(code: `SW_ENGINE_${string}`, message: string, opts?: SecondWorldErrorOptions) {
    super(code, message, ExitCode.Internal, opts);
  }
}

export class InternalError extends SecondWorldError {
  constructor(message: string, opts?: SecondWorldErrorOptions) {
    super("SW_INTERNAL", message, ExitCode.Internal, opts);
  }
}

export function isSecondWorldError(e: unknown): e is SecondWorldError {
  return e instanceof SecondWorldError;
}
