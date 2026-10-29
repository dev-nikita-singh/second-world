/**
 * Start an example app in-process on 127.0.0.1:0, together with its payments-fake
 * dependency. docs/12-testing-and-quality.md §3.
 */
import { type PaymentsFake, startPaymentsFake } from "../../examples/payments-fake/src/server.js";

export type ExampleName = "shop-express" | "shop-fastify";

export interface StartExampleOptions {
  /** Artificial delay per DB query (ms). Default 1. */
  queryDelayMs?: number;
  /** shop-fastify only: start the "fixed" variant (FIXED=1 behaviour). */
  fixed?: boolean;
}

export interface RunningExample {
  name: ExampleName;
  url: string;
  port: number;
  /** The payments-fake dependency (control latency/failures, read attempt stats). */
  payments: PaymentsFake;
  close(): Promise<void>;
}

export async function startExample(name: ExampleName, opts: StartExampleOptions = {}): Promise<RunningExample> {
  const payments = await startPaymentsFake();
  try {
    let app: { url: string; port: number; close(): Promise<void> };
    if (name === "shop-express") {
      const m = await import("../../examples/shop-express/src/server.js");
      app = await m.start(0, { paymentsUrl: payments.url, queryDelayMs: opts.queryDelayMs ?? 1 });
    } else {
      const m = await import("../../examples/shop-fastify/src/server.js");
      app = await m.start(0, {
        paymentsUrl: payments.url,
        queryDelayMs: opts.queryDelayMs ?? 1,
        fixed: opts.fixed ?? false,
      });
    }
    let closing: Promise<void> | undefined;
    return {
      name,
      url: app.url,
      port: app.port,
      payments,
      close: () => {
        closing ??= Promise.all([app.close(), payments.close()]).then(() => undefined);
        return closing;
      },
    };
  } catch (e) {
    await payments.close();
    throw e;
  }
}
