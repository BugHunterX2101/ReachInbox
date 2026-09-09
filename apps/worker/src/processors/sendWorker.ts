import type { Job } from "bullmq";
import { DelayedError } from "bullmq";
import { getPool, type DbEmailJob, type DbSender } from "@reachinbox/db-schema";
import {
  getConfig,
  checkAndConsumeRateLimits,
  hourWindowKey,
  startOfNextHour,
  peekRateLimitCounters,
  getQueueConnection,
  enqueueEmailIndex,
  classifySmtpFailure,
  type RateCounter,
} from "@reachinbox/queues";
import type { MailTransport } from "../mailer/etherealTransport.js";
import { createEtherealTransport } from "../mailer/etherealTransport.js";
import { rateLimitBreachMessage, notifySlack } from "../slack/notifySlack.js";

const WORKER_INSTANCE_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export type TransportFactory = (sender: DbSender) => MailTransport;

let transportFactory: TransportFactory = createEtherealTransport;

/** Test seam — inject a fake transport. */
export function setTransportFactory(factory: TransportFactory): void {
  transportFactory = factory;
}

/** Structured transition log (Observability NFR, §14 shape). */
function logTransition(entry: {
  jobId: string;
  dbJobId: string;
  batchId: string;
  tenantId: string;
  senderId: string;
  fromStatus: string;
  toStatus: string;
  attempt: number;
  latencyMs: number;
}): void {
  console.log(
    JSON.stringify({ event: "job_transition", timestamp: new Date().toISOString(), ...entry })
  );
}

interface JobRow extends DbEmailJob {
  subject: string;
  body: string;
  tenant_cap: number | null;
  batch_cap: number | null;
}

/**
 * Send Worker state machine (§6.2, FR-12–FR-21).
 *
 * Redelivery guard: DB status is re-read first — an already-`sent` job is
 * acked and skipped, so a crash mid-send can never cause a double-send.
 * The lease (`locked_at`/`locked_by`) marks `processing`; every terminal or
 * rollback transition is guarded on the lease holder so a reclaimed lease can
 * never be overwritten by a zombie worker.
 */
export async function processSendJob(job: Job, token?: string): Promise<void> {
  const pool = getPool();
  const cfg = getConfig();
  const started = Date.now();
  const emailJobId = (job.data as { emailJobId: string }).emailJobId;

  // ---- Load the job row with batch/tenant context ----
  const jobResult = await pool.query<JobRow>(
    `SELECT ej.*, b.subject, b.body,
            t.max_emails_per_hour AS tenant_cap, b.hourly_limit_override AS batch_cap
     FROM email_jobs ej
     JOIN batches b ON b.id = ej.batch_id
     JOIN tenants t ON t.id = ej.tenant_id
     WHERE ej.id = $1`,
    [emailJobId]
  );
  const row = jobResult.rows[0];
  if (!row) {
    return; // DB row gone — ack, nothing to do
  }

  // ---- Redelivery guard: the DB is the truth (FR-12) ----
  if (row.status === "sent" || row.status === "failed") {
    logTransition({
      jobId: job.id ?? "",
      dbJobId: row.id,
      batchId: row.batch_id,
      tenantId: row.tenant_id,
      senderId: row.sender_id,
      fromStatus: row.status,
      toStatus: row.status,
      attempt: job.attemptsMade + 1,
      latencyMs: Date.now() - started,
    });
    return; // terminal — ack and skip, never send again
  }

  // ---- Acquire the processing lease (FR-12) ----
  const lease = await pool.query(
    `UPDATE email_jobs
     SET status = 'processing', locked_at = now(), locked_by = $2, updated_at = now()
     WHERE id = $1 AND status = 'scheduled'
     RETURNING id`,
    [row.id, WORKER_INSTANCE_ID]
  );
  if (!lease.rowCount) {
    return; // another worker/reconciler owns it — ack, no send
  }

  // ---- Resolve the sender ----
  const senderResult = await pool.query<DbSender>(`SELECT * FROM senders WHERE id = $1`, [
    row.sender_id,
  ]);
  const sender = senderResult.rows[0];
  if (!sender) {
    await discardAndFail(job, row, "sender configuration missing");
    return;
  }

  // ---- Resolve caps: per-batch override → sender → tenant → env default (FR-19) ----
  const now = new Date();
  const tenantCap = row.tenant_cap ?? cfg.MAX_EMAILS_PER_HOUR;
  const senderCap = sender.max_emails_per_hour ?? cfg.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const counters: RateCounter[] = [
    { key: hourWindowKey("tenant", row.tenant_id, now), cap: tenantCap },
    { key: hourWindowKey("sender", sender.id, now), cap: senderCap },
  ];
  if (row.batch_cap) {
    counters.push({ key: hourWindowKey("batch", row.batch_id, now), cap: row.batch_cap });
  }

  // ---- Dual rate limit — atomic Redis Lua (FR-20) ----
  const allowed = await checkAndConsumeRateLimits(getQueueConnection(), counters, now);
  if (!allowed) {
    await deferJob(job, row, sender, token, { tenantCap, senderCap, started });
    return; // unreachable after DelayedError, but keeps TS control flow honest
  }

  // ---- Send via the injected transport (FR-13) ----
  let transport: MailTransport;
  try {
    transport = transportFactory(sender);
  } catch (err) {
    await discardAndFail(job, row, `transport init failed: ${(err as Error).message}`);
    return;
  }

  try {
    const att = await pool.query<{ filename: string; storage_url: string }>(
      `SELECT filename, storage_url FROM batch_attachments WHERE batch_id = $1`,
      [row.batch_id]
    );
    const attachments = att.rows.map((r) => ({ filename: r.filename, path: r.storage_url }));

    const info = await transport.send({
      from: sender.from_address,
      to: row.recipient,
      subject: row.subject,
      html: row.body,
      attachments,
    });

    if (info.rejected.length > 0) {
      await discardAndFail(job, row, `recipient rejected by SMTP: ${info.rejected.join(", ")}`);
      return;
    }

    // The `sent` write is the very next statement after SMTP returns (§6.5).
    const sent = await pool.query(
      `UPDATE email_jobs
       SET status = 'sent', sent_at = now(), attempts = $2, last_error = NULL,
           locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND locked_by = $3`,
      [row.id, job.attemptsMade + 1, WORKER_INSTANCE_ID]
    );
    if (!sent.rowCount) {
      throw new Error("lease lost before sent-write");
    }

    logTransition({
      jobId: job.id ?? "",
      dbJobId: row.id,
      batchId: row.batch_id,
      tenantId: row.tenant_id,
      senderId: row.sender_id,
      fromStatus: "processing",
      toStatus: "sent",
      attempt: job.attemptsMade + 1,
      latencyMs: Date.now() - started,
    });
    await enqueueEmailIndex(row.id);
  } catch (err) {
    const cls = classifySmtpFailure(err);
    if (cls.transient && job.attemptsMade + 1 < cfg.RETRY_MAX_ATTEMPTS) {
      // Transient failure with attempts left: back to `scheduled`; BullMQ's
      // custom backoff ladder (30s/60s/120s ±jitter) schedules the retry.
      // Guarded on the lease so a row another worker already finished is untouched.
      await pool.query(
        `UPDATE email_jobs
         SET status = 'scheduled', locked_at = NULL, locked_by = NULL,
             attempts = $2, last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND locked_by = $4`,
        [row.id, job.attemptsMade + 1, (err as Error).message.slice(0, 500), WORKER_INSTANCE_ID]
      );
      logTransition({
        jobId: job.id ?? "",
        dbJobId: row.id,
        batchId: row.batch_id,
        tenantId: row.tenant_id,
        senderId: row.sender_id,
        fromStatus: "processing",
        toStatus: "scheduled",
        attempt: job.attemptsMade + 1,
        latencyMs: Date.now() - started,
      });
      throw err; // BullMQ catches → applies backoff → retry
    }
    if (cls.transient) {
      await discardAndFail(job, row, `max attempts exceeded: ${(err as Error).message}`);
    } else {
      await discardAndFail(job, row, `${cls.code ?? "SMTP"} permanent failure: ${(err as Error).message}`);
    }
  } finally {
    transport.close();
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Rate-limit deferral (§6.6, FR-21): the job is deferred, never failed.
 * Status stays `scheduled` — no attempts increment, no last_error. The BullMQ
 * job moves to the delayed set at the next hour window via moveToDelayed +
 * DelayedError, which does not consume an attempt. Slack is notified
 * fire-and-forget if connected (FR-23/FR-24).
 */
async function deferJob(
  job: Job,
  row: JobRow,
  sender: DbSender,
  token: string | undefined,
  info: { tenantCap: number; senderCap: number; started: number }
): Promise<void> {
  const nextWindow = startOfNextHour(new Date());
  const pool = getPool();

  await pool.query(
    `UPDATE email_jobs
     SET status = 'scheduled', locked_at = NULL, locked_by = NULL,
         scheduled_at = $2, updated_at = now()
     WHERE id = $1 AND status = 'processing' AND locked_by = $3`,
    [row.id, nextWindow.toISOString(), WORKER_INSTANCE_ID]
  );

  logTransition({
    jobId: job.id ?? "",
    dbJobId: row.id,
    batchId: row.batch_id,
    tenantId: row.tenant_id,
    senderId: row.sender_id,
    fromStatus: "processing",
    toStatus: "scheduled",
    attempt: job.attemptsMade + 1,
    latencyMs: Date.now() - info.started,
  });

  // Fire-and-forget breach notification — never blocks the send path (FR-24).
  void (async () => {
    try {
      const counters = await peekRateLimitCounters(
        getQueueConnection(),
        { tenantId: row.tenant_id, senderId: sender.id },
        new Date()
      );
      await notifySlack(
        row.tenant_id,
        rateLimitBreachMessage({
          senderEmail: sender.from_address,
          senderCount: counters.senderCount,
          senderCap: info.senderCap,
          tenantCount: counters.tenantCount,
          tenantCap: info.tenantCap,
          nextWindowStart: nextWindow,
        })
      );
    } catch {
      // swallow — notification must never affect sending (FR-24)
    }
  })();

  await enqueueEmailIndex(row.id); // scheduledAt moved — refresh the search doc

  if (token) {
    await job.moveToDelayed(nextWindow.getTime(), token);
    throw new DelayedError("rate limited — deferred to next hour window");
  }
  // No token (direct invocation, e.g. tests): the row is safely back to
  // `scheduled`; reconciliation will re-enqueue it at the right time.
}

/** Mark `failed` permanently + discard so BullMQ doesn't burn a retry (§6.4). */
async function discardAndFail(job: Job, row: JobRow, reason: string): Promise<void> {
  const pool = getPool();
  try {
    await job.discard();
  } catch {
    // already moved to a terminal set — nothing to discard
  }
  await pool.query(
    `UPDATE email_jobs
     SET status = 'failed', last_error = $2, locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1 AND status = 'processing' AND locked_by = $3`,
    [row.id, reason.slice(0, 500), WORKER_INSTANCE_ID]
  );
  await enqueueEmailIndex(row.id);
}
