/**
 * node:sqlite storage for conduit-api. One in-memory database per app instance.
 *
 * Every async call is one simulated network round trip to the database (`queryDelayMs`, default 1 ms)
 * followed by the statement, so the number of queries a request makes shows up as latency, the way
 * it does with a real database server. A transaction (`tx`) is one round trip followed by a
 * synchronous BEGIN IMMEDIATE … COMMIT body: no other request can run in between.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { seed } from "./seed.js";

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

/** Synchronous statement access, used inside a transaction body. */
export interface Tx {
  get<T = Row>(sql: string, ...params: Param[]): T | undefined;
  all<T = Row>(sql: string, ...params: Param[]): T[];
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number };
}

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  bio TEXT,
  image TEXT
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, followed_id)
);
CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorites_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX articles_author ON articles(author_id);
CREATE TABLE article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (article_id, tag)
);
CREATE INDEX article_tags_tag ON article_tags(tag);
CREATE TABLE favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, article_id)
);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX comments_article ON comments(article_id);
`;

const TABLES = ["comments", "favorites", "article_tags", "articles", "follows", "sessions", "users"];

export class Db {
  /** Queries (round trips) since the last reset; GET /__test/stats. */
  queries = 0;
  private readonly sql: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly queryDelayMs: number;
  private readonly txApi: Tx;

  constructor(queryDelayMs = 1) {
    this.queryDelayMs = queryDelayMs;
    this.sql = new DatabaseSync(":memory:");
    this.sql.exec("PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
    this.txApi = {
      get: (sql, ...params) => this.stmt(sql).get(...params) as never,
      all: (sql, ...params) => this.stmt(sql).all(...params) as never,
      run: (sql, ...params) => {
        const r = this.stmt(sql).run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
    };
    this.reset();
  }

  /** Back to the seed data (POST /__test/reset). */
  reset(): void {
    this.transaction((tx) => {
      for (const t of TABLES) tx.run(`DELETE FROM ${t}`);
      seed(tx);
    });
    this.queries = 0;
  }

  close(): void {
    this.sql.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.sql.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private async roundTrip(): Promise<void> {
    this.queries++;
    if (this.queryDelayMs > 0) await new Promise((r) => setTimeout(r, this.queryDelayMs));
  }

  async get<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined> {
    await this.roundTrip();
    return this.txApi.get<T>(sql, ...params);
  }

  async all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
    await this.roundTrip();
    return this.txApi.all<T>(sql, ...params);
  }

  async run(sql: string, ...params: Param[]): Promise<{ changes: number; lastInsertRowid: number }> {
    await this.roundTrip();
    return this.txApi.run(sql, ...params);
  }

  /** One round trip, then `body` atomically (BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw). */
  async tx<T>(body: (tx: Tx) => T): Promise<T> {
    await this.roundTrip();
    return this.transaction(body);
  }

  private transaction<T>(body: (tx: Tx) => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const out = body(this.txApi);
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
}
