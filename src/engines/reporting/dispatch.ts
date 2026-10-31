/**
 * Picks the block renderer for an engine payload (EngineResult.data). Performance keeps its
 * hand-tuned tty/markdown layout and is not handled here (html uses perfBlocks directly).
 */
import type { EngineResult } from "../../core/evidence/schemas.js";
import { agentBlocks, isAgentData } from "./agent.js";
import { type Block, comparisonBlocks, isRunComparison, isStressData, stressBlocks } from "./blocks.js";
import { bugsBlocks, isBugsData } from "./bugs.js";
import { evolutionBlocks, experimentBlocks, isEvolutionData, isExperimentData } from "./experiments.js";
import { isModelData, isModelDiff, modelBlocks, modelDiffBlocks } from "./model-render.js";
import { isReliabilityData, reliabilityBlocks } from "./reliability.js";

export function dataBlocks(r: EngineResult): Block[] | undefined {
  const d = r.data;
  if (isStressData(d)) return stressBlocks(d);
  if (isAgentData(d)) return agentBlocks(d);
  if (isBugsData(d)) return bugsBlocks(d);
  if (isReliabilityData(d)) return reliabilityBlocks(d, r.findings);
  if (isEvolutionData(d)) return evolutionBlocks(d);
  if (isExperimentData(d)) return experimentBlocks(d);
  if (isRunComparison(d)) return comparisonBlocks(d);
  if (isModelData(d)) return modelBlocks(d, r.limitations);
  if (isModelDiff(d)) return modelDiffBlocks(d);
  return undefined;
}
