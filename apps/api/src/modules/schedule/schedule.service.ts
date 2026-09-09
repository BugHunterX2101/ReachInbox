import { getPool } from "@reachinbox/db-schema";
import { getConfig } from "@reachinbox/config";
import type { ScheduleRequest, ScheduleResponse } from "@reachinbox/shared-types";
import { expandBatch } from "@reachinbox/queues";
import { ApiError } from "../../middleware/errorHandler.js";

/**
 * Schedule flow (§6.1): insert the batch row and respond immediately (FR-6);
 * job expansion runs asynchronously so the caller never blocks on 1,000+
 * inserts. The fan-out itself is idempotent (§6.1) — a re-run is a safe no-op.
 */
export async function scheduleBatch(
  tenantId: string,
  userId: string,
  input: ScheduleRequest
): Promise<ScheduleResponse> {
  const pool = getPool();
  const cfg = getConfig();

  // Resolve the sender (tenant-scoped).
  const sender = await pool.query<{ id: string }>(
    `SELECT id FROM senders WHERE id = $1 AND tenant_id = $2`,
    [input.senderId, tenantId]
  );
  if (sender.rows.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "unknown senderId for this workspace");
  }

  // Resolve recipients — direct list or uploaded list (mutually exclusive, §10.2).
  let recipients: string[] = [];
  let invalidCount = 0;
  let invalidSamples: string[] = [];
  if (input.recipientListUploadId) {
    const upload = await pool.query<{
      recipients: string[];
      invalid_count: number;
      invalid_samples: string[];
    }>(
      `SELECT recipients, invalid_count, invalid_samples FROM recipient_uploads WHERE id = $1 AND tenant_id = $2`,
      [input.recipientListUploadId, tenantId]
    );
    if (upload.rows.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "unknown recipientListUploadId for this workspace");
    }
    const u = upload.rows[0];
    recipients = u.recipients;
    invalidCount = u.invalid_count;
    invalidSamples = u.invalid_samples;
  } else if (input.recipients) {
    // Recipients arrive pre-normalized/deduped client-side, but enforce here too.
    const seen = new Set<string>();
    for (const r of input.recipients) {
      const norm = r.trim().toLowerCase();
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        recipients.push(norm);
      }
    }
  }

  if (recipients.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "no valid recipients provided");
  }

  // Start time not in the past (FR-5) — small skew tolerance.
  const startTime = new Date(input.startTime);
  if (startTime.getTime() < Date.now() - 60_000) {
    throw new ApiError("VALIDATION_ERROR", "startTime must not be in the past");
  }

  const requestedCount = recipients.length;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO batches
       (tenant_id, created_by, sender_id, subject, body, start_time, delay_between_sends_ms, hourly_limit_override, requested_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      tenantId,
      userId,
      input.senderId,
      input.subject,
      input.body,
      startTime.toISOString(),
      input.delayBetweenSendsMs,
      input.hourlyLimit ?? null,
      requestedCount,
    ]
  );
  const batchId = inserted.rows[0].id;

  // Async fan-out (FR-6): never block the response on large batches.
  void expandBatch({
    batchId,
    tenantId,
    senderId: input.senderId,
    recipients,
    startTime,
    delayBetweenSendsMs: input.delayBetweenSendsMs,
    maxAttempts: cfg.RETRY_MAX_ATTEMPTS,
  }).catch((err) => {
    console.error(`[schedule] async expansion failed for batch ${batchId}:`, err);
  });

  return { batchId, requestedCount, invalidCount, invalidSamples };
}
