/**
 * Payment job queue + worker pool. Jobs are rows in the `jobs` table (status survives in the
 * database); the ids waiting to run are kept in FIFO order in memory. `workers` loops take the
 * oldest queued job, charge the order at the provider and record the outcome. Clients can
 * long-poll a job until it finishes (`waitFor`).
 */
import type { Db } from "./db.js";
import { MAX_ATTEMPTS, PermanentProviderError, type ProviderClient } from "./provider-client.js";

export interface JobRow {
  id: number;
  order_id: number;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

export class JobQueue {
  /** Ids of queued jobs, oldest first. */
  private readonly pending: number[] = [];
  /** Long-poll waiters per job id (removed on finish or timeout). */
  private readonly waiters = new Map<number, Set<() => void>>();
  /** Wakes one idle worker. */
  private readonly idle: (() => void)[] = [];
  private running = 0;
  private stopped = false;
  private readonly loops: Promise<void>[] = [];

  constructor(
    private readonly db: Db,
    private readonly provider: ProviderClient,
    private readonly now: () => string,
  ) {}

  /** Insert a queued job for the order and hand it to a worker. */
  enqueue(orderId: number): JobRow {
    const at = this.now();
    const id = this.db.run(
      "INSERT INTO jobs (order_id, created_at) VALUES (?, ?)",
      orderId,
      at,
    ).lastInsertRowid;
    // SEEDED-DEFECT:unbounded-queue — the backlog is never checked: no maximum depth, no 503 + Retry-After, so under load the queue (and every job's wait) grows without bound while the API keeps answering 201.
    this.pending.push(id);
    this.idle.shift()?.();
    return this.get(id) as JobRow;
  }

  get(id: number): JobRow | undefined {
    return this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
  }

  get depth(): number {
    return this.pending.length;
  }

  get busy(): number {
    return this.running;
  }

  /** Resolves when the job has finished or after `ms`, whichever comes first. */
  waitFor(id: number, ms: number): Promise<void> {
    const job = this.get(id);
    if (!job || job.status === "succeeded" || job.status === "failed" || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      const s = set;
      const done = () => {
        clearTimeout(timer);
        s.delete(done);
        if (s.size === 0 && this.waiters.get(id) === s) this.waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      s.add(done);
    });
  }

  /** Start `n` worker loops. */
  start(n: number): void {
    for (let i = 0; i < n; i++) this.loops.push(this.loop());
  }

  /** Drop queued work and wake every waiter (POST /__test/reset). */
  clear(): void {
    this.pending.length = 0;
    for (const set of [...this.waiters.values()]) for (const w of [...set]) w();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.idle.splice(0)) w();
    this.clear();
    await Promise.all(this.loops);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const id = this.pending.shift();
      if (id === undefined) {
        await new Promise<void>((resolve) => this.idle.push(resolve));
        continue;
      }
      this.running++;
      try {
        await this.process(id);
      } finally {
        this.running--;
        this.notify(id);
      }
    }
  }

  private async process(id: number): Promise<void> {
    const job = this.get(id);
    if (job?.status !== "queued") return;
    const order = this.db.get<{ id: number; total: number; created_at: string }>(
      "SELECT id, total, created_at FROM orders WHERE id = ?",
      job.order_id,
    );
    if (!order) {
      this.finish(id, "failed", 0, "order no longer exists");
      return;
    }
    this.db.run("UPDATE jobs SET status = 'running' WHERE id = ?", id);
    try {
      const { charge, attempts } = await this.provider.createCharge(
        order.id,
        order.total,
        `order-${order.id}-${Date.parse(order.created_at)}`,
      );
      this.db.run("UPDATE orders SET charge_id = ? WHERE id = ? AND charge_id IS NULL", charge.id, order.id);
      this.finish(id, "succeeded", attempts, null);
    } catch (e) {
      this.db.run(
        "UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'pending'",
        order.id,
      );
      const attempts = e instanceof PermanentProviderError ? 1 : MAX_ATTEMPTS;
      this.finish(id, "failed", attempts, e instanceof Error ? e.message : String(e));
    }
  }

  private finish(id: number, status: "succeeded" | "failed", attempts: number, error: string | null): void {
    this.db.run(
      `UPDATE jobs SET status = ?, attempts = CASE WHEN ? > 0 THEN ? ELSE attempts END, last_error = ?, finished_at = ?
       WHERE id = ?`,
      status,
      attempts,
      attempts,
      error,
      this.now(),
      id,
    );
  }

  private notify(id: number): void {
    const set = this.waiters.get(id);
    if (set) for (const w of [...set]) w();
  }
}
