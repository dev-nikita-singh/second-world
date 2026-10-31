/**
 * Workflow runner: DAG of engine steps. See docs/02-architecture.md §4.2.
 * Steps are validated with Kahn's topological sort (sw-shared topoSort), then executed as soon as
 * their dependencies finish, with a concurrency limit. A failed step skips its dependants unless
 * it is `optional` or `continueOnError`. Upstream results are passed downstream.
 */
import { DiGraph } from "../shared/graph/digraph.js";
import { CycleError, topoSort } from "../shared/graph/toposort.js";
import { ConfigError } from "./errors.js";
import type { EngineResult } from "./evidence/schemas.js";

export interface WorkflowStep {
  engine: string;
  after?: string[];
  optional?: boolean;
  continueOnError?: boolean;
  input?: Record<string, unknown>;
}

export type StepOutcome =
  | { status: "ok"; result: EngineResult }
  | { status: "failed"; error: unknown; result?: EngineResult }
  | { status: "skipped"; reason: string };

export interface WorkflowResult {
  order: string[];
  steps: Record<string, StepOutcome>;
  /** False if any non-optional step failed or was skipped. */
  ok: boolean;
}

export type StepRunner = (
  id: string,
  step: WorkflowStep,
  upstream: Record<string, EngineResult>,
  signal: AbortSignal,
) => Promise<EngineResult>;

const FAILED_STATUS = new Set(["error", "cancelled"]);

/** Validates and returns a deterministic topological order. Throws ConfigError on unknown deps or cycles. */
export function planWorkflow(steps: Record<string, WorkflowStep>): string[] {
  const g = new DiGraph();
  for (const id of Object.keys(steps)) g.addNode(id);
  for (const [id, s] of Object.entries(steps)) {
    for (const dep of s.after ?? []) {
      if (!(dep in steps)) {
        throw new ConfigError(
          "SW_CONFIG_WORKFLOW",
          `Workflow step "${id}" depends on unknown step "${dep}"`,
          {
            hint: `Known steps: ${Object.keys(steps).join(", ")}`,
          },
        );
      }
      g.addEdge(dep, id);
    }
  }
  try {
    return topoSort(g);
  } catch (e) {
    if (e instanceof CycleError) {
      throw new ConfigError(
        "SW_CONFIG_WORKFLOW",
        `Workflow has a dependency cycle: ${[...e.cycle, e.cycle[0]].join(" -> ")}`,
        {
          hint: "Remove one of the `after` edges in the cycle",
        },
      );
    }
    throw e;
  }
}

export async function runWorkflow(
  steps: Record<string, WorkflowStep>,
  run: StepRunner,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<WorkflowResult> {
  const order = planWorkflow(steps);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const signal = opts.signal ?? new AbortController().signal;
  const outcomes: Record<string, StepOutcome> = {};
  const pendingDeps = new Map<string, number>();
  const dependants = new Map<string, string[]>();
  for (const id of order) {
    pendingDeps.set(id, (steps[id]?.after ?? []).length);
    for (const d of steps[id]?.after ?? []) dependants.set(d, [...(dependants.get(d) ?? []), id]);
  }
  const ready: string[] = order.filter((id) => pendingDeps.get(id) === 0);
  const blocked = new Set<string>();
  let running = 0;

  return new Promise<WorkflowResult>((resolve) => {
    const finish = (): void => {
      const ok = order.every((id) => {
        const o = outcomes[id];
        return o?.status === "ok" || steps[id]?.optional === true;
      });
      resolve({ order, steps: outcomes, ok });
    };

    const complete = (id: string, outcome: StepOutcome): void => {
      outcomes[id] = outcome;
      const step = steps[id] as WorkflowStep;
      const failed = outcome.status !== "ok";
      const passOn = !failed || step.optional === true || step.continueOnError === true;
      for (const dep of dependants.get(id) ?? []) {
        if (!passOn) blocked.add(dep);
        const n = (pendingDeps.get(dep) ?? 1) - 1;
        pendingDeps.set(dep, n);
        if (n === 0) ready.push(dep);
      }
    };

    const pump = (): void => {
      while (ready.length > 0 && running < concurrency) {
        const id = ready.shift() as string;
        const step = steps[id] as WorkflowStep;
        if (blocked.has(id)) {
          complete(id, { status: "skipped", reason: "an upstream step failed" });
          continue;
        }
        if (signal.aborted) {
          complete(id, { status: "skipped", reason: "cancelled" });
          continue;
        }
        const upstream: Record<string, EngineResult> = {};
        for (const d of step.after ?? []) {
          const o = outcomes[d];
          if (o && "result" in o && o.result) upstream[d] = o.result;
        }
        running++;
        Promise.resolve()
          .then(() => run(id, step, upstream, signal))
          .then(
            (result) =>
              complete(
                id,
                FAILED_STATUS.has(result.status)
                  ? { status: "failed", error: new Error(`status ${result.status}`), result }
                  : { status: "ok", result },
              ),
            (error: unknown) => complete(id, { status: "failed", error }),
          )
          .finally(() => {
            running--;
            pump();
          });
      }
      if (running === 0 && ready.length === 0) finish();
    };
    pump();
  });
}
