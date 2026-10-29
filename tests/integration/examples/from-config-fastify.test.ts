/** shop-fastify: every planted defect is found from examples/shop-fastify/sw.config.ts (see from-config.suite.ts). */
import { fromConfigSuite } from "./from-config.suite.js";

fromConfigSuite("shop-fastify", [
  "sw inspect",
  "sw reliability run dependency-5xx",
  "sw bugs",
  "sw reliability run dependency-latency",
]);
