/**
 * Deterministic seed data: six users with fixed demo tokens, 60 articles, tags, follows,
 * favorites and comments. Passwords: <username>-pass (scrypt, see auth.ts).
 */
import type { Tx } from "./db.js";

export interface SeedUser {
  username: string;
  token: string;
  salt: string;
  hash: string;
}

/** Demo accounts. Tokens are fixed so tests and sw.config.ts can use them. */
export const SEED_USERS: readonly SeedUser[] = [
  {
    username: "alice",
    token: "alice-token",
    salt: "conduit-salt-alice",
    hash: "8554bf75c50fc6093c3faf55788007ccb62f725cdf5a6b7af77fd33ab884e0e9",
  },
  {
    username: "bob",
    token: "bob-token",
    salt: "conduit-salt-bob",
    hash: "e81a11674bd88b63cafad37b4e255f81fef55813773a7f5c105fb4cf15cb7936",
  },
  {
    username: "carol",
    token: "carol-token",
    salt: "conduit-salt-carol",
    hash: "7f8f70529b47fd70de35515c64ddfb462ec65c67d910b1351ba3d6d77a9c835c",
  },
  {
    username: "dave",
    token: "dave-token",
    salt: "conduit-salt-dave",
    hash: "0b745ffef6cbcb8ce7099af88929984c0e4e71fef9d6ab578e8cc36cfc5eb2f7",
  },
  {
    username: "erin",
    token: "erin-token",
    salt: "conduit-salt-erin",
    hash: "d17679b6aee39cc056d7aba5d269bc1e46e8cfb1a2e7acae0e53bb02c1ec878f",
  },
  {
    username: "frank",
    token: "frank-token",
    salt: "conduit-salt-frank",
    hash: "fb772feecfb354ac75f820ae5f097b55f5864bcc5d5a85c56d0542c592a4e7e6",
  },
];

export const SEED_ARTICLES = 60;
const TAGS = ["welcome", "dragons", "training", "node", "sqlite", "testing"] as const;
const TOPICS = ["How to train your dragon", "Node streams", "SQLite tips", "Testing APIs", "Pagination"];
const EPOCH = Date.UTC(2026, 0, 1);

const iso = (minutes: number): string => new Date(EPOCH + minutes * 60_000).toISOString();

export function seed(tx: Tx): void {
  SEED_USERS.forEach((u, i) => {
    tx.run(
      "INSERT INTO users (id, username, email, salt, hash, bio, image) VALUES (?, ?, ?, ?, ?, ?, ?)",
      i + 1,
      u.username,
      `${u.username}@conduit.test`,
      u.salt,
      u.hash,
      `I am ${u.username}`,
      null,
    );
    tx.run("INSERT INTO sessions (token, user_id) VALUES (?, ?)", u.token, i + 1);
  });
  // alice follows bob and carol; bob follows alice.
  for (const [a, b] of [
    [1, 2],
    [1, 3],
    [2, 1],
  ] as const)
    tx.run("INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)", a, b);

  // Article 1 is alice's "welcome-to-conduit" (no favorites: used by the favorites race test).
  tx.run(
    "INSERT INTO articles (id, slug, title, description, body, author_id, favorites_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
    1,
    "welcome-to-conduit",
    "Welcome to Conduit",
    "Start here",
    "Conduit is a place to share articles.",
    1,
    iso(0),
    iso(0),
  );
  tx.run("INSERT INTO article_tags (article_id, tag) VALUES (1, 'welcome')");
  for (let id = 2; id <= SEED_ARTICLES; id++) {
    const author = ((id - 1) % SEED_USERS.length) + 1;
    const title = `${TOPICS[id % TOPICS.length]} part ${id}`;
    const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.toString(36)}`;
    tx.run(
      "INSERT INTO articles (id, slug, title, description, body, author_id, favorites_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      id,
      slug,
      title,
      `About ${title}`,
      `Body of ${title}.`,
      author,
      iso(id * 10),
      iso(id * 10),
    );
    tx.run("INSERT INTO article_tags (article_id, tag) VALUES (?, ?)", id, TAGS[id % TAGS.length] as string);
    if (id % 4 === 0)
      tx.run(
        "INSERT INTO article_tags (article_id, tag) VALUES (?, ?)",
        id,
        TAGS[(id + 1) % TAGS.length] as string,
      );
    // Every third article is favorited by the users after its author (count kept consistent).
    if (id % 3 === 0) {
      const fans = [(author % 6) + 1, ((author + 1) % 6) + 1];
      for (const f of fans) tx.run("INSERT INTO favorites (user_id, article_id) VALUES (?, ?)", f, id);
      tx.run("UPDATE articles SET favorites_count = ? WHERE id = ?", fans.length, id);
    }
    if (id % 5 === 0)
      tx.run(
        "INSERT INTO comments (article_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        id,
        (author % 6) + 1,
        `Nice article about ${title}`,
        iso(id * 10 + 1),
        iso(id * 10 + 1),
      );
  }
}
