/** GET /jobs/{id}?wait=<ms>: a payment job, optionally long-polled until it finishes. */
import type { ServerResponse } from "node:http";
import { requireUser } from "../auth.js";
import type { Db } from "../db.js";
import { idParam, intParam, notFound, type Request, type Route, send } from "../http.js";
import type { JobQueue, JobRow } from "../queue.js";

/** Longest long-poll a client may ask for (ms). */
export const MAX_WAIT_MS = 5_000;

function view(j: JobRow) {
  return {
    id: j.id,
    orderId: j.order_id,
    status: j.status,
    attempts: j.attempts,
    lastError: j.last_error,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
  };
}

export function jobRoutes(db: Db, queue: JobQueue): Route[] {
  /** The caller's job (a job belongs to the owner of its order). */
  function ownJob(userId: number, rawId: string | undefined): JobRow {
    const id = idParam(rawId, "job");
    const j = db.get<JobRow>(
      "SELECT jobs.* FROM jobs JOIN orders ON orders.id = jobs.order_id WHERE jobs.id = ? AND orders.user_id = ?",
      id,
      userId,
    );
    if (!j) throw notFound("job");
    return j;
  }

  async function getJob(req: Request, res: ServerResponse): Promise<void> {
    const user = requireUser(req, db);
    const wait = intParam(req.query, "wait", 0, MAX_WAIT_MS, 0);
    const before = ownJob(user.id, req.params.id);
    if (wait > 0) await queue.waitFor(before.id, wait);
    send(res, 200, view(queue.get(before.id) ?? before));
  }

  return [{ method: "GET", pattern: /^\/jobs\/(?<id>[^/]+)$/, handler: getJob }];
}
