// @ts-nocheck — fixture
import { Worker } from "bullmq";
import { sendMail } from "./mailer.js";

export const worker = new Worker("emails", async (job) => {
  await sendMail(job.data);
});
