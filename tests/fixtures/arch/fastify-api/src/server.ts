// @ts-nocheck — fixture for the Architecture Inspector (never executed)
import Fastify from "fastify";
import ordersPlugin from "./orders.js";

const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));
app.register(ordersPlugin, { prefix: "/v1" });
export default app;
