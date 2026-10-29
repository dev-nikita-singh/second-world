/** Telemetry adapters (wire formats only; no OpenTelemetry SDK). docs/03-engines/system-model.md §1. */
export * from "./gzip.js";
export * from "./otlp.js";
export * from "./otlp-proto.js";
export * from "./prometheus.js";
export * from "./receiver.js";
