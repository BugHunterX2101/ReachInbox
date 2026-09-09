import { getPool, computeJobId, type DbEmailJob } from "@reachinbox/db-schema";
import {
  enqueueEmailSend,
  ensureEmailSendJob,
  getEmailSendQueue,
  type EmailSendJobData,
} from "./index.js";
export interface ExpandBatchParams {
  batchId: string;
  tenantId: string;
  senderId: string;
  recipients: string[];
  startTime: Date;
  delayBetweenSendsMs: number;
  maxAttempts: number;
}

/**
 * Async batch expansion (§6.1, FR-6): bulk-insert email_jobs (idempotent via the
 * (batch_id, recipient) unique index) and enqueue one delayed BullMQ job per row
 * with the deterministic jobId. Never blocks the schedule API response.
 *
 * Each row's scheduled_at is start_time + row_index * delay — sends are spread
 * out naturally, even before the hourly cap ever engages.
 */
export async function expandBatch(params: ExpandBatchParams): Promise<number> {
  const pool = getPool();
  const rows: Array<{
    jobId: string;
    recipient: string;
    scheduledAt: Date;
  }> = [];

  params.recipients.forEach((recipient, idx) => {
    const scheduledAt = new Date(params.startTime.getTime() + idx * params.delayBetweenSendsMs);
    rows.push({
      jobId: computeJobId(params.batchId, recipient),
      recipient,
      scheduledAt,
    });
  });

  // Chunked bulk INSERT ... ON CONFLICT DO NOTHING — idempotent re-run safe.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const base = j * 6;
      values.push(
        params.batchId,
        params.tenantId,
        params.senderId,
        r.recipient,
        r.scheduledAt.toISOString(),
        r.jobId
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    await pool.query(
      `INSERT INTO email_jobs (batch_id, tenant_id, sender_id, recipient, scheduled_at, bullmq_job_id)
       VALUES ${tuples.join(",")}
       ON CONFLICT (batch_id, recipient) DO NOTHING`,
      values
    );
  }

  // Fetch the actual rows (id + effective scheduled_at), then enqueue.
  const inserted = await pool.query<Pick<DbEmailJob, "id" | "recipient" | "scheduled_at" | "bullmq_job_id">>(
    `SELECT id, recipient, scheduled_at, bullmq_job_id
     FROM email_jobs
     WHERE batch_id = $1`,
    [params.batchId]
  );

  for (const row of inserted.rows) {
    await enqueueEmailSend(
      params.batchId,
      row.recipient,
      row.id,
      new Date(row.scheduled_at),
      params.maxAttempts
    );
  }

  await pool.query(`UPDATE batches SET scheduled_count = $1 WHERE id = $2`, [
    inserted.rows.length,
    params.batchId,
  ]);

  return inserted.rows.length;
}

/**
 * Reconciler helper (FR-11): re-enqueue `scheduled` rows that are missing from
 * Redis. Deterministic jobId makes this safe whether or not the job secretly
 * still existed. Returns the number of re-added jobs.
 */
export async function reconcileScheduledJobs(maxAttempts: number): Promise<{
  reconciled: number;
  alreadyHealthy: number;
}> {
  const pool = getPool();
  const result = await pool.query<DbEmailJob>(
    `SELECT * FROM email_jobs WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 20000`
  );

  let reconciled = 0;
  let alreadyHealthy = 0;

  for (const row of result.rows) {
    const reEnqueued = await ensureEmailSendJob(
      row.batch_id,
      row.recipient,
      row.id,
      new Date(row.scheduled_at),
      maxAttempts
    );
    if (reEnqueued) reconciled++;
    else alreadyHealthy++;
  }

  return { reconciled, alreadyHealthy };
}

/** Count send jobs in each BullMQ state — feeds the queue-stats endpoint. */
export async function getQueueCounts(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}> {
  const queue = getEmailSendQueue();
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "completed", "failed");
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}
