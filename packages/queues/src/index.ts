import { Queue } from "bullmq";
import { Redis as IORedis, type Redis } from "ioredis";
import { computeJobId } from "@reachinbox/db-schema";
import { getConfig, retryLadderMs } from "@reachinbox/config";

export { getConfig, retryLadderMs } from "@reachinbox/config";
import { computeBackoffMs } from "./backoff.js";
import { retryDelayForAttempt } from "./sendPolicy.js";
import { classifySmtpFailure, extractSmtpCode } from "./smtpErrors.js";

export { computeBackoffMs, hasAttemptsLeft } from "./backoff.js";
export { classifySmtpFailure, extractSmtpCode } from "./smtpErrors.js";
export {
  checkAndConsumeRateLimits,
  hourWindowKey,
  secondsUntilNextHour,
  startOfNextHour,
  peekRateLimitCounters,
  type RateCounter,
} from "./rateLimiter.js";
export { runReconciler, type ReconcileResult } from "./reconciler.js";
export { expandBatch, reconcileScheduledJobs, getQueueCounts } from "./scheduler.js";
export { nextAction, retryDelayForAttempt, type SendNextAction, type SendNextActionInput } from "./sendPolicy.js";

export const EMAIL_SEND_QUEUE = "email-send";
export const EMAIL_INDEX_QUEUE = "email-index";
export const REINDEX_QUEUE = "reindex";

export interface EmailSendJobData {
  emailJobId: string;
}

export interface EmailIndexJobData {
  emailJobId: string;
}

export interface ReindexJobData {
  trigger: "repeatable" | "manual";
}

let connection: Redis | null = null;
let blockingConnection: Redis | null = null;

/** Shared connection for queues (BullMQ requires maxRetriesPerRequest: null). */
export function getQueueConnection(): Redis {
  if (!connection) {
    const cfg = getConfig();
    connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

/**
 * Blocking connection for workers (kept separate from the producer connection
 * so a slow non-blocking command never delays BZPOPMIN).
 */
export function getBlockingConnection(): Redis {
  if (!blockingConnection) {
    const cfg = getConfig();
    blockingConnection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return blockingConnection;
}

export async function closeRedis(): Promise<void> {
  const jobs = [connection?.quit(), blockingConnection?.quit()];
  connection = null;
  blockingConnection = null;
  await Promise.allSettled(jobs);
}

let emailSendQueueSingleton: Queue<EmailSendJobData> | null = null;
let emailIndexQueueSingleton: Queue<EmailIndexJobData> | null = null;
let reindexQueueSingleton: Queue<ReindexJobData> | null = null;

/** All queue construction is singleton: one owner of queue state per process. */
export function getEmailSendQueue(): Queue<EmailSendJobData> {
  if (!emailSendQueueSingleton) {
    const cfg = getConfig();
    emailSendQueueSingleton = new Queue<EmailSendJobData>(EMAIL_SEND_QUEUE, {
      connection: getQueueConnection(),
      prefix: cfg.QUEUE_PREFIX,
    });
  }
  return emailSendQueueSingleton;
}

export function getEmailIndexQueue(): Queue<EmailIndexJobData> {
  if (!emailIndexQueueSingleton) {
    const cfg = getConfig();
    emailIndexQueueSingleton = new Queue<EmailIndexJobData>(EMAIL_INDEX_QUEUE, {
      connection: getQueueConnection(),
      prefix: cfg.QUEUE_PREFIX,
    });
  }
  return emailIndexQueueSingleton;
}

export function getReindexQueue(): Queue<ReindexJobData> {
  if (!reindexQueueSingleton) {
    const cfg = getConfig();
    reindexQueueSingleton = new Queue<ReindexJobData>(REINDEX_QUEUE, {
      connection: getQueueConnection(),
      prefix: cfg.QUEUE_PREFIX,
    });
  }
  return reindexQueueSingleton;
}

/**
 * BullMQ custom backoff strategy (§6.4) — single source of retry policy.
 * Derived from the send-policy module: the send engine asks nextAction() and
 * BullMQ schedules with the same ladder via retryDelayForAttempt.
 */
export function backoffStrategy(attemptsMade: number): number {
  return retryDelayForAttempt(attemptsMade);
}

const SEND_JOB_OPTS = (delay: number, maxAttempts: number) =>
  ({
    delay,
    attempts: maxAttempts,
    backoff: { type: "custom" },
    removeOnComplete: { age: 24 * 3600, count: 5000 },
    removeOnFail: false,
  }) as const;

/**
 * Enqueue one delayed send job (FR-8). Deterministic jobId makes re-adding a
 * safe no-op: BullMQ ignores an add() when a job with the same id already
 * exists in a non-terminal state.
 */
export async function enqueueEmailSend(
  batchId: string,
  recipient: string,
  emailJobId: string,
  scheduledAt: Date,
  maxAttempts: number
): Promise<void> {
  const queue = getEmailSendQueue();
  const jobId = computeJobId(batchId, recipient);
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  await queue.add("send", { emailJobId }, { jobId, ...SEND_JOB_OPTS(delay, maxAttempts) });
}

/**
 * Boot reconciliation re-enqueue helper (FR-11). Re-adds the job only when it
 * is genuinely absent from the queue: a stalled-completed job is re-added (it
 * paired with a DB row an expired-lease reclaim flipped back to scheduled),
 * while waiting/active/delayed jobs are left untouched.
 */
export async function ensureEmailSendJob(
  batchId: string,
  recipient: string,
  emailJobId: string,
  scheduledAt: Date,
  maxAttempts: number
): Promise<boolean> {
  const queue = getEmailSendQueue();
  const jobId = computeJobId(batchId, recipient);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "completed") return false; // waiting/active/delayed/failed — leave untouched
    // completed: only dangerous pairing is a DB row an expired-lease reclaim
    // flipped back to scheduled — re-add (idempotent by jobId) and let the
    // worker's sent-check no-op if it wasn't actually sent.
  }

  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  await queue.add("send", { emailJobId }, { jobId, ...SEND_JOB_OPTS(delay, maxAttempts) });
  return true; // was missing and is now re-added
}

export async function enqueueEmailIndex(emailJobId: string): Promise<void> {
  const q = getEmailIndexQueue();
  await q.add(
    "index",
    { emailJobId },
    {
      attempts: 5,
      backoff: { type: "fixed", delay: 2000 },
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: false,
    }
  );
}
