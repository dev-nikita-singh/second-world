// @ts-nocheck — fixture
import { Router } from "express";
import { requireAuth } from "../auth.js";
import { deleteUser, getUser, listUsersWithTeams } from "../services/user-service.js";

export function usersRouter() {
  const r = Router();
  r.get("/users", requireAuth, async (_req, res) => {
    res.json(await listUsersWithTeams());
  });
  r.get("/users/:id", requireAuth, async (req, res) => {
    res.json(await getUser(req.params.id));
  });
  // SEEDED: ARCH007 (siblings have requireAuth)
  r.delete("/users/:id", async (req, res) => {
    await deleteUser(req.params.id);
    res.status(204).end();
  });
  return r;
}
