/** shop-express: every planted defect is found from examples/shop-express/sw.config.ts (see from-config.suite.ts). */
import { fromConfigSuite } from "./from-config.suite.js";

fromConfigSuite("shop-express", [
  "sw inspect",
  "sw reliability run dependency-timeout",
  "sw bugs",
  "sw reliability run dependency-5xx",
]);
