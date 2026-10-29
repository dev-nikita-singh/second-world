/**
 * Cross-report summary (`sw analyze`): purely deterministic, no network, no model.
 * Everything in the output is counted or copied from the input results.
 */
export { type DeterministicSummary, deterministicSummary } from "./deterministic.js";
export { loadReports, resultsFromJson } from "./sources.js";
