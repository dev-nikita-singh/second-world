/**
 * node:sqlite storage for orders-jobs-api: users, orders, payment jobs, the payment ledger and
 * received webhook events. One in-memory database per app instance; statements are cached.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  total INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  shipping_address TEXT NOT NULL,
  payment_job_id INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  amount_paid INTEGER NOT NULL DEFAULT 0,
  charge_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX orders_user ON orders(user_id, id);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  charge_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX webhook_events_key ON webhook_events(idempotency_key);
`;

const TABLES = ["webhook_events", "jobs", "orders", "users"];

export class Db {
  private readonly sql: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor() {
    this.sql = new DatabaseSync(":memory:");
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(SCHEMA);
    this.seed();
  }

  private stmt(q: string): StatementSync {
    let s = this.stmts.get(q);
    if (!s) {
      s = this.sql.prepare(q);
      this.stmts.set(q, s);
    }
    return s;
  }

  get<T = Row>(q: string, ...params: Param[]): T | undefined {
    return this.stmt(q).get(...params) as T | undefined;
  }

  all<T = Row>(q: string, ...params: Param[]): T[] {
    return this.stmt(q).all(...params) as T[];
  }

  run(q: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(q).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Runs `body` in one IMMEDIATE transaction (synchronous: nothing else interleaves). */
  tx<T>(body: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const out = body();
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }

  /** Back to the seed data (POST /__test/reset). */
  reset(): void {
    this.tx(() => {
      // AUTOINCREMENT: ids of deleted orders/jobs are never reused (sqlite_sequence is reset with the data).
      this.sql.exec([...TABLES.map((t) => `DELETE FROM ${t};`), "DELETE FROM sqlite_sequence;"].join("\n"));
    });
    this.seed();
  }

  close(): void {
    this.sql.close();
  }

  private seed(): void {
    const at = "2026-01-01T00:00:00.000Z";
    this.tx(() => {
      this.run(
        "INSERT INTO users (id, username, token) VALUES (1, 'alice', 'alice-token'), (2, 'bob', 'bob-token')",
      );
      // Order 1 (alice): 2 x TEA-001, paid with charge ch_seed_1. Order 2 (bob): pending.
      this.run(
        `INSERT INTO orders (id, user_id, sku, quantity, total, note, shipping_address, payment_job_id,
           payment_status, amount_paid, charge_id, created_at)
         VALUES (1, 1, 'TEA-001', 2, 2500, 'leave at the door', '1 Main St', 1, 'paid', 2500, 'ch_seed_1', ?),
                (2, 2, 'MUG-002', 1, 900, '', '2 High St', 2, 'pending', 0, NULL, ?)`,
        at,
        at,
      );
      this.run(
        `INSERT INTO jobs (id, order_id, status, attempts, created_at, finished_at)
         VALUES (1, 1, 'succeeded', 1, ?, ?), (2, 2, 'failed', 3, ?, ?)`,
        at,
        at,
        at,
        at,
      );
      this.run(
        `INSERT INTO webhook_events (idempotency_key, type, order_id, charge_id, amount, received_at)
         VALUES ('evt_seed_1', 'charge.succeeded', 1, 'ch_seed_1', 2500, ?)`,
        at,
      );
    });
  }
}
