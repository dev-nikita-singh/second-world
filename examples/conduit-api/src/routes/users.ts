/** /api/users, /api/user and /api/profiles routes. */
import { hashPassword, newSalt, optionalUser, requireUser, verifyPassword } from "../auth.js";
import { HttpError, invalid, type Router, send, str, wrapper } from "../http.js";
import type { UserRepository, UserRow } from "../repositories/users.js";

/** Same rules as openapi.yaml (`format: email` is ajv-formats' full email format). */
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const USERNAME = /^[A-Za-z0-9_-]+$/;

const userBody = (u: UserRow, token: string) => ({
  user: { email: u.email, token, username: u.username, bio: u.bio, image: u.image },
});

function nullableStr(o: Record<string, unknown>, key: string, max: number): string | null | undefined {
  if (o[key] === null) return null;
  return str(o, key, { required: false, max });
}

export function userRoutes(r: Router, users: UserRepository): void {
  r.post("/api/users/login", async (req, res) => {
    const u = wrapper(req.body, "user");
    const email = str(u, "email", { required: true, max: 254, pattern: EMAIL }) as string;
    const password = str(u, "password", { required: true, min: 1, max: 72 }) as string;
    const user = await users.byEmail(email);
    if (!user || !(await verifyPassword(password, user)))
      throw new HttpError(401, "credentials", "are invalid");
    send(res, 200, userBody(user, await users.newSession(user.id)));
  });

  r.post("/api/users", async (req, res) => {
    const u = wrapper(req.body, "user");
    const username = str(u, "username", { required: true, min: 1, max: 40, pattern: USERNAME }) as string;
    const email = str(u, "email", { required: true, max: 254, pattern: EMAIL }) as string;
    const password = str(u, "password", { required: true, min: 8, max: 72 }) as string;
    const salt = newSalt();
    const created = await users.create({ username, email, salt, hash: await hashPassword(password, salt) });
    send(res, 201, userBody(created.user, created.token));
  });

  r.get("/api/user", async (req, res) => {
    const user = await requireUser(req, users);
    send(res, 200, userBody(user, tokenOf(req)));
  });

  r.put("/api/user", async (req, res) => {
    const user = await requireUser(req, users);
    const u = wrapper(req.body, "user");
    const patch: Parameters<UserRepository["update"]>[1] = {};
    const username = str(u, "username", { required: false, min: 1, max: 40, pattern: USERNAME });
    const email = str(u, "email", { required: false, max: 254, pattern: EMAIL });
    const password = str(u, "password", { required: false, min: 8, max: 72 });
    const bio = nullableStr(u, "bio", 1000);
    const image = nullableStr(u, "image", 2048);
    if (username !== undefined) patch.username = username;
    if (email !== undefined) patch.email = email;
    if (bio !== undefined) patch.bio = bio;
    if (image !== undefined) patch.image = image;
    if (password !== undefined) {
      patch.salt = newSalt();
      patch.hash = await hashPassword(password, patch.salt);
    }
    const updated = await users.update(user.id, patch);
    send(res, 200, userBody(updated, tokenOf(req)));
  });

  r.get("/api/profiles/:username", async (req, res) => {
    const viewer = await optionalUser(req, users);
    send(res, 200, { profile: await users.profile(param(req.params, "username"), viewer?.id) });
  });

  r.post("/api/profiles/:username/follow", async (req, res) => {
    const viewer = await requireUser(req, users);
    send(res, 200, { profile: await users.setFollowing(viewer.id, param(req.params, "username"), true) });
  });

  r.delete("/api/profiles/:username/follow", async (req, res) => {
    const viewer = await requireUser(req, users);
    send(res, 200, { profile: await users.setFollowing(viewer.id, param(req.params, "username"), false) });
  });
}

function tokenOf(req: { headers: { authorization?: string | undefined } }): string {
  return (req.headers.authorization ?? "").trim().split(/ +/)[1] ?? "";
}

export function param(params: Record<string, string>, name: string): string {
  const v = params[name];
  if (v === undefined) throw invalid(name, "is required");
  return v;
}
