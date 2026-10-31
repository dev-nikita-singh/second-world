/** Users, sessions (bearer tokens) and follows. */
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { conflict, notFound } from "../http.js";

export interface UserRow {
  id: number;
  username: string;
  email: string;
  salt: string;
  hash: string;
  bio: string | null;
  image: string | null;
}

export interface Profile {
  username: string;
  bio: string | null;
  image: string | null;
  following: boolean;
}

export class UserRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  byToken(token: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>(
      "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
      token,
    );
  }

  byEmail(email: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
  }

  byId(id: number): Promise<UserRow | undefined> {
    return this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
  }

  /** Insert the user and a first session atomically. Duplicate username/email → 409. */
  create(u: {
    username: string;
    email: string;
    salt: string;
    hash: string;
  }): Promise<{ user: UserRow; token: string }> {
    const token = randomBytes(24).toString("hex");
    return this.db.tx((tx) => {
      if (tx.get("SELECT 1 FROM users WHERE username = ?", u.username)) throw conflict("username");
      if (tx.get("SELECT 1 FROM users WHERE email = ?", u.email)) throw conflict("email");
      const { lastInsertRowid: id } = tx.run(
        "INSERT INTO users (username, email, salt, hash) VALUES (?, ?, ?, ?)",
        u.username,
        u.email,
        u.salt,
        u.hash,
      );
      tx.run("INSERT INTO sessions (token, user_id) VALUES (?, ?)", token, id);
      return { user: tx.get<UserRow>("SELECT * FROM users WHERE id = ?", id) as UserRow, token };
    });
  }

  newSession(userId: number): Promise<string> {
    const token = randomBytes(24).toString("hex");
    return this.db
      .run("INSERT INTO sessions (token, user_id) VALUES (?, ?)", token, userId)
      .then(() => token);
  }

  /** Partial update; username/email stay unique (409). */
  update(
    id: number,
    patch: Partial<Pick<UserRow, "username" | "email" | "salt" | "hash" | "bio" | "image">>,
  ): Promise<UserRow> {
    return this.db.tx((tx) => {
      if (
        patch.username !== undefined &&
        tx.get("SELECT 1 FROM users WHERE username = ? AND id <> ?", patch.username, id)
      )
        throw conflict("username");
      if (
        patch.email !== undefined &&
        tx.get("SELECT 1 FROM users WHERE email = ? AND id <> ?", patch.email, id)
      )
        throw conflict("email");
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        // k is one of the fixed column names above, never user input.
        tx.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, id);
      }
      return tx.get<UserRow>("SELECT * FROM users WHERE id = ?", id) as UserRow;
    });
  }

  async profile(username: string, viewerId: number | undefined): Promise<Profile> {
    const row = await this.db.get<UserRow & { following: number }>(
      `SELECT u.*, EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followed_id = u.id) AS following
       FROM users u WHERE u.username = ?`,
      viewerId ?? -1,
      username,
    );
    if (!row) throw notFound("profile");
    return { username: row.username, bio: row.bio, image: row.image, following: row.following === 1 };
  }

  /** Author profile by id (used when assembling article views). */
  async profileById(id: number, viewerId: number | undefined): Promise<Profile> {
    const row = await this.db.get<UserRow & { following: number }>(
      `SELECT u.*, EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followed_id = u.id) AS following
       FROM users u WHERE u.id = ?`,
      viewerId ?? -1,
      id,
    );
    if (!row) throw notFound("profile");
    return { username: row.username, bio: row.bio, image: row.image, following: row.following === 1 };
  }

  /** Follow / unfollow are idempotent. Following yourself is allowed (RealWorld does not forbid it). */
  async setFollowing(viewerId: number, username: string, follow: boolean): Promise<Profile> {
    await this.db.tx((tx) => {
      const target = tx.get<{ id: number }>("SELECT id FROM users WHERE username = ?", username);
      if (!target) throw notFound("profile");
      if (follow)
        tx.run("INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)", viewerId, target.id);
      else tx.run("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?", viewerId, target.id);
    });
    return this.profile(username, viewerId);
  }
}
