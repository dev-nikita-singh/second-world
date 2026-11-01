/** Bearer-token authentication (demo tokens are seeded in src/db.ts). */
import type { Db } from "./db.js";
import { type Request, unauthorized } from "./http.js";

export interface User {
  id: number;
  username: string;
}

export function requireUser(req: Request, db: Db): User {
  const h = req.headers.authorization;
  const m = h === undefined ? null : /^Bearer +(\S+)$/i.exec(h.trim());
  if (!m) throw unauthorized();
  const user = db.get<User>("SELECT id, username FROM users WHERE token = ?", m[1] as string);
  if (!user) throw unauthorized();
  return user;
}
