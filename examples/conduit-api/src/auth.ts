/**
 * Authentication: scrypt password hashes (async, libuv thread pool) and opaque bearer tokens stored
 * in the sessions table. `Authorization: Token <t>` (RealWorld) and `Authorization: Bearer <t>` are
 * both accepted.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { type Request, unauthorized } from "./http.js";
import type { UserRepository, UserRow } from "./repositories/users.js";

export function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
  });
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

export async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
  const derived = Buffer.from(await hashPassword(password, user.salt), "hex");
  const stored = Buffer.from(user.hash, "hex");
  return derived.length === stored.length && timingSafeEqual(derived, stored);
}

/** undefined = no Authorization header; null = present but not a Token/Bearer credential. */
function tokenOf(req: Request): string | null | undefined {
  const h = req.headers.authorization;
  if (h === undefined) return undefined;
  const m = /^(?:Token|Bearer) +(\S+)$/i.exec(h.trim());
  return m ? (m[1] as string) : null;
}

/** The caller, if any. A header with a bad or unknown token is rejected even on public routes. */
export async function optionalUser(req: Request, users: UserRepository): Promise<UserRow | undefined> {
  const token = tokenOf(req);
  if (token === undefined) return undefined;
  if (token === null) throw unauthorized();
  const user = await users.byToken(token);
  if (!user) throw unauthorized();
  return user;
}

export async function requireUser(req: Request, users: UserRepository): Promise<UserRow> {
  const user = await optionalUser(req, users);
  if (!user) throw unauthorized();
  return user;
}
