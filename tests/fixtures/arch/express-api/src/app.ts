// @ts-nocheck — fixture for the Architecture Inspector (never executed)
import express from "express";
import { usersRouter } from "./routes/users.js";

export const app = express();
app.use(express.json());
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/api", usersRouter());
