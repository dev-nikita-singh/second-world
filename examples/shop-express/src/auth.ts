/** Authentication: two test customers + one admin, bearer tokens, password login. */
import { pbkdf2Sync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface User {
  id: string;
  username: string;
  role: "customer" | "admin";
  token: string;
  salt: string;
  /** pbkdf2(sha256, 100k iterations, 32 bytes) of the password, hex. */
  hash: string;
}

/** Test users. Passwords: alice-pass, bob-pass, admin-pass. */
export const USERS: readonly User[] = [
  {
    id: "u_alice",
    username: "alice",
    role: "customer",
    token: "alice-token",
    salt: "sw-salt-alice",
    hash: "ce2d2bfe4fc564902571c7d3b9cf6e3fcaab01676c0a49202cf374a565a3249d",
  },
  {
    id: "u_bob",
    username: "bob",
    role: "customer",
    token: "bob-token",
    salt: "sw-salt-bob",
    hash: "492947b8f0d658e367184df636b394fd3ee8a78da793cbf9d91d8a7f41f839ca",
  },
  {
    id: "u_admin",
    username: "admin",
    role: "admin",
    token: "admin-token",
    salt: "sw-salt-admin",
    hash: "432a08e37ce0713f0b6fc13fe05e7b1627e67a0b93b0d1c3704246d0e756899b",
  },
];

export function login(username: string, password: string): User | undefined {
  const user = USERS.find((u) => u.username === username);
  if (!user) return undefined;
  // SEEDED-DEFECT:sync-crypto-login — blocks the event loop ~20-50 ms per login (use async crypto.pbkdf2).
  const derived = pbkdf2Sync(password, user.salt, 100_000, 32, "sha256");
  return timingSafeEqual(derived, Buffer.from(user.hash, "hex")) ? user : undefined;
}

/** Bearer-token middleware: sets res.locals.user or responds 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const user = USERS.find((u) => u.token === token);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.locals.user = user;
  next();
}

/** Admin-only middleware (correctly implemented). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if ((res.locals.user as User).role !== "admin") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  });
}

export function currentUser(res: Response): User {
  return res.locals.user as User;
}
