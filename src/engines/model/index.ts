/**
 * System Model (Digital Twin) — docs/03-engines/system-model.md.
 * Public API: modelEngine, buildModel, diffModels, exports (DOT/Mermaid/canonical JSON), snapshots,
 * telemetry ingestion (ingestOtlp, parseOtlpProtobuf, parsePrometheus, startOtlpReceiver).
 */
import type { Engine } from "../../core/types.js";
import { buildModel, MODEL_ENGINE_VERSION, type ModelDataWithGraph } from "./build.js";
import { type ModelInput, ModelInputSchema } from "./schema.js";

export {
  type Attributes,
  type AttrValue,
  histogramQuantile,
  type NormalizedMetric,
  type NormalizedSpan,
  type OtlpParseResult,
  parseOtlp,
  parseOtlp as ingestOtlp,
} from "../../adapters/telemetry/otlp.js";
export {
  decodeOtlpProtobuf,
  detectOtlpSignal,
  isOtlpProtobufFile,
  OtlpProtobufError,
  type OtlpSignal,
  parseOtlpProtobuf,
} from "../../adapters/telemetry/otlp-proto.js";
export {
  histogramSeries,
  type PromFamily,
  type PromParseResult,
  parsePrometheus,
  promHistogramQuantile,
} from "../../adapters/telemetry/prometheus.js";
export {
  type OtlpReceiver,
  type OtlpReceiverOptions,
  startOtlpReceiver,
} from "../../adapters/telemetry/receiver.js";
export {
  attachFindings,
  buildModel,
  MODEL_ENGINE_VERSION,
  type ModelDataWithGraph,
  type ModelDeps,
  parseModelInput,
} from "./build.js";
export { combineConfidence, DEFAULT_CONFIDENCE, noisyOr } from "./confidence.js";
export { diffModels, type ModelDiff, type ModelDiffOptions } from "./diff.js";
export { dotEscape, mermaidEscape, modelToDot, modelToMermaid, toCanonicalJson } from "./export.js";
export { ModelGraph, type Neighbourhood, withGraph } from "./graph.js";
export { kindsCompatible, resolveEntities } from "./resolve.js";
export * from "./schema.js";
export { jaro, jaroWinkler, normalizeName } from "./similarity.js";
export { loadModelSnapshot, saveModelSnapshot } from "./snapshot.js";
export { buildTraceTrees, criticalPath, peerOf } from "./traces.js";
export * from "./types.js";

export const modelEngine: Engine<ModelInput, ModelDataWithGraph> = {
  id: "model",
  version: MODEL_ENGINE_VERSION,
  inputSchema: ModelInputSchema as unknown as Engine<ModelInput, ModelDataWithGraph>["inputSchema"],
  requires: [{ cap: "fs.read" }, { cap: "telemetry.otlp", optional: true }],
  run: (input, ctx) => buildModel(input, ctx),
};
