import { getPool } from "@reachinbox/db-schema";
import { indexEmailJob, ensureEmailJobsIndex } from "@reachinbox/search";
import { enqueueEmailIndex } from "@reachinbox/queues";

/**
 * Reindex Worker (§7.4): periodic drift correction between Postgres and ES as
 * a BullMQ repeatable job — still Redis-backed, satisfying "no cron, anywhere"
 * (FR-7). Re-indexes recently-updated rows so a missed dual-write heals.
 */
export async function processReindexJob(limit = 200): Promise<{ indexed: number }> {
  await ensureEmailJobsIndex();
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM email_jobs
     WHERE updated_at > now() - interval '1 hour'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  for (const row of result.rows) {
    await enqueueEmailIndex(row.id);
  }
  return { indexed: result.rows.length };
}
