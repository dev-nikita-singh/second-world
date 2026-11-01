/**
 * Helpers for the orders-jobs-api system tests (owner: sw-real2-w8, wave 8).
 * docs/12-testing-and-quality.md §3 (ground truth, recall/precision).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type RunningProvider, startProvider } from "../../../examples/orders-jobs-api/provider/server.js";
import type { RunningOrdersApp } from "../../../examples/orders-jobs-api/src/server.js";
import {
  type EngineReport,
  type GroundTruth,
  type Score,
  scoreCommand,
} from "../../integration/examples/from-config.js";
import { EXAMPLES_DIR } from "../helpers.js";

export { engineResult } from "../conduit/helpers.js";

export const ORDERS_DIR = path.join(EXAMPLES_DIR, "orders-jobs-api");
/** Demo tokens of the seeded accounts: must never appear in CLI output or reports. */
export const ORDERS_TOKENS = ["alice-token", "bob-token"];

export function ordersTruth(): GroundTruth {
  return JSON.parse(readFileSync(path.join(ORDERS_DIR, "expected-findings.json"), "utf8")) as GroundTruth;
}

/** The payment provider fake + the app, wired together (webhooks go to the app). */
export interface OrdersStack {
  url: string;
  provider: RunningProvider;
  app: RunningOrdersApp;
  close(): Promise<void>;
}

/**
 * Start the provider (≈300 ms per charge, like a real PSP) and the app on 127.0.0.1:0. With
 * `proxyPort`, the app calls the provider through that port (the Reliability Lab's fault proxy,
 * whose upstream is `provider.url`).
 */
export async function startOrdersStack(
  opts: { proxyPort?: number; latencyMs?: number } = {},
): Promise<OrdersStack> {
  const provider = await startProvider({ latencyMs: opts.latencyMs ?? 300 });
  try {
    const m = await import("../../../examples/orders-jobs-api/src/server.js");
    const providerUrl = opts.proxyPort === undefined ? provider.url : `http://127.0.0.1:${opts.proxyPort}`;
    const app = await m.start(0, { providerUrl });
    provider.setWebhookUrl(`${app.url}/webhooks/payments`);
    let closing: Promise<void> | undefined;
    return {
      url: app.url,
      provider,
      app,
      close: () => {
        closing ??= Promise.all([app.close(), provider.close()]).then(() => undefined);
        return closing;
      },
    };
  } catch (e) {
    await provider.close();
    throw e;
  }
}

/**
 * Copy examples/orders-jobs-api to `dest` (the user's project) and point its sw.config.ts at a
 * running stack: the app (replaces http://127.0.0.1:3200), the provider (replaces
 * http://127.0.0.1:4020) and the reliability proxy port (replaces 4021). A `.git` folder stops
 * config discovery at the copy.
 */
export function copyOrders(dest: string, stack: OrdersStack, proxyPort: number): string {
  cpSync(ORDERS_DIR, dest, { recursive: true });
  const cfgPath = path.join(dest, "sw.config.ts");
  const cfg = readFileSync(cfgPath, "utf8")
    .split("http://127.0.0.1:3200")
    .join(stack.url)
    .split("http://127.0.0.1:4020")
    .join(stack.provider.url)
    .replace(/\b4021\b/g, String(proxyPort));
  writeFileSync(cfgPath, cfg);
  if (!existsSync(path.join(dest, ".git"))) mkdirSync(path.join(dest, ".git"));
  return cfgPath;
}

export function score(command: string, report: EngineReport): Score {
  return scoreCommand(ordersTruth(), command, report.findings);
}

export function describeScore(command: string, s: Score, report: EngineReport): string {
  const lines = report.findings.map(
    (f) =>
      `  ${f.classification} ${f.severity} ${f.ruleId} ${f.affected[0] ?? ""} ${f.locations[0] ? `${f.locations[0].file}:${f.locations[0].line}` : ""} :: ${f.title}`,
  );
  return `[orders-jobs] ${command}: recall ${s.matched.length}/${s.expected.length} precision ${s.precision.toFixed(2)} missed ${JSON.stringify(s.missed)} FP ${JSON.stringify(s.falsePositives)}\n${lines.join("\n")}`;
}
