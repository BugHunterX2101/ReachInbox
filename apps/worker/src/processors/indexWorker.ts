import { getPool } from "@reachinbox/db-schema";
import { indexEmailJob } from "@reachinbox/search";

/**
 * Index Worker (§7.2, FR-27): consume { emailJobId }, read the current row
 * from Postgres, upsert into ES by id. Idempotent — replaying the same index
 * job twice just overwrites with the same data. Deliberately NOT inline in
 * the send path: a slow/unavailable ES never adds latency to sending.
 */
export async function processIndexJob(emailJobId: string): Promise<void> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    batch_id: string;
    tenant_id: string;
    sender_id: string;
    recipient: string;
    status: string;
    scheduled_at: Date;
    sent_at: Date | null;
    created_at: Date;
    last_error: string | null;
    attempts: number;
    from_address: string;
    subject: string;
  }>(
    `SELECT ej.id, ej.batch_id, ej.tenant_id, ej.sender_id, ej.recipient, ej.status,
            ej.scheduled_at, ej.sent_at, ej.created_at, ej.last_error, ej.attempts,
            s.from_address, b.subject
     FROM email_jobs ej
     JOIN senders s ON s.id = ej.sender_id
     JOIN batches b ON b.id = ej.batch_id
     WHERE ej.id = $1`,
    [emailJobId]
  );

  const row = result.rows[0];
  if (!row) return; // row deleted — nothing to index

  await indexEmailJob({
    id: row.id,
    batchId: row.batch_id,
    tenantId: row.tenant_id,
    senderId: row.sender_id,
    senderEmail: row.from_address,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status,
    scheduledAt: new Date(row.scheduled_at),
    sentAt: row.sent_at ? new Date(row.sent_at) : null,
    createdAt: new Date(row.created_at),
    error: row.last_error,
    attempts: row.attempts,
  });
}
