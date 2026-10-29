// @ts-nocheck — fixture
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { chargeWithRetry } from "./payments.js";

const redis = new Redis();
const emails = new Queue("emails");

export default async function ordersPlugin(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);
  fastify.get("/orders/:id", async (req) => {
    const cached = await redis.get(`order:${req.params.id}`);
    return cached ? JSON.parse(cached) : null;
  });
  fastify.post("/orders", async (req) => {
    const charge = await chargeWithRetry(req.body);
    await redis.set(`order:${charge.id}`, JSON.stringify(charge));
    await emails.add("order-confirmation", { id: charge.id });
    return charge;
  });
}
