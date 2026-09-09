import { getPool } from "@reachinbox/db-schema";
import { getConfig } from "@reachinbox/config";
import { getQueueConnection, ensureEmailSendJob } from "./index.js";

export interface ReconcileResult {
  reconciled: number;
  alreadyHealthy: number;
  reclaimed: number;
}

/**
 * Boot reconciliation (FR-9, FR-10, FR-11; §6.5). Two passes, two failure modes:
 *  1. `scheduled` rows missing from Redis → re-enqueue (deterministic jobId makes
 *     this safe whether or not the job secretly still existed).
 *  2. `processing` rows with an expired lease → reclaim to `scheduled` and
 *     re-enqueue with delay 0 (a fresh lease is left alone — another instance
 *     may legitimately still be mid-send).
 * A Redis mutex (`lock:reconcile`) keeps concurrent boot instances from double-running.
 */
export async function runReconciler(): Promise<ReconcileResult> {
  const cfg = getConfig();
  const redis = getQueueConnection();
  const LOCK_KEY = "lock:reconcile";
  const LOCK_TTL_S = 60;

  const gotLock = await redis.set(LOCK_KEY, "locked", "EX", LOCK_TTL_S, "NX");
  if (!gotLock) {
    console.log("[reconciler] another instance holds the lock — skipping");
    return { reconciled: 0, alreadyHealthy: 0, reclaimed: 0 };
  }

  try {
    // Pass 1: scheduled rows missing from Redis.
    const pool = getPool();
    const scheduled = await pool.query<{
      id: string;
      batch_id: string;
      recipient: string;
      scheduled_at: Date;
    }>(
      `SELECT id, batch_id, recipient, scheduled_at FROM email_jobs
       WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 20000`
    );

    let reconciled = 0;
    let alreadyHealthy = 0;
    for (const row of scheduled.rows) {
      const reEnqueued = await ensureEmailSendJob(
        row.batch_id,
        row.recipient,
        row.id,
        new Date(row.scheduled_at),
        cfg.RETRY_MAX_ATTEMPTS
      );
      if (reEnqueued) reconciled++;
      else alreadyHealthy++;
    }

    // Pass 2: stale processing leases (worker died mid-send).
    const stale = await pool.query<{ id: string; batch_id: string; recipient: string }>(
      `SELECT id, batch_id, recipient FROM email_jobs
       WHERE status = 'processing' AND locked_at < now() - ($1::text || ' milliseconds')::interval
       LIMIT 10000`,
      [String(cfg.RECONCILE_LEASE_TIMEOUT_MS)]
    );
    let reclaimed = 0;
    for (const row of stale.rows) {
      const updated = await pool.query(
        `UPDATE email_jobs
         SET status = 'scheduled', locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE id = $1 AND status = 'processing'
           AND locked_at < now() - ($2::text || ' milliseconds')::interval`,
        [row.id, String(cfg.RECONCILE_LEASE_TIMEOUT_MS)]
      );
      if (updated.rowCount && updated.rowCount > 0) {
        await ensureEmailSendJob(row.batch_id, row.recipient, row.id, new Date(), cfg.RETRY_MAX_ATTEMPTS);
        reclaimed++;
      }
    }

    console.log(
      `[reconciler] done: ${reconciled} re-enqueued, ${alreadyHealthy} already healthy, ${reclaimed} leases reclaimed`
    );
    return { reconciled, alreadyHealthy, reclaimed };
  } finally {
    await redis.del(LOCK_KEY);
  }
}
