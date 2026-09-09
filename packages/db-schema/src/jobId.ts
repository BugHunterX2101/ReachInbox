import crypto from "node:crypto";

/**
 * Deterministic BullMQ jobId (FR-8): sha256(batchId + ":" + recipient).slice(0, 32).
 * Re-adding a job in Redis with the same batchId + recipient resolves to the same
 * BullMQ job, so double-enqueueing is safe by construction.
 */
export function computeJobId(batchId: string, recipient: string): string {
  return crypto
    .createHash("sha256")
    .update(`${batchId}:${recipient.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}
