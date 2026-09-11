import { getConfig, retryLadderMs } from "@reachinbox/config";
import { computeBackoffMs } from "./backoff.js";
import { classifySmtpFailure } from "./smtpErrors.js";

/**
 * Send failure policy (§6.4, FR-12–FR-21) — the single owner of the question
 * "a send just failed: retry, defer, or give up?".
 *
 * Pure: classification, the retry ladder, jitter, and attempts arithmetic all
 * live here; the send engine (apps/worker sendWorker) only executes the answer
 * (SQL transitions, BullMQ re-throw, job.discard). The BullMQ backoff strategy
 * derives its delay from the same module, so ladder changes cannot desync the
 * engine's "should I retry" from Bull's "how long until the retry".
 */

export type SendNextAction =
  /** Transient failure with attempts left — back to `scheduled`, retry after delayMs. */
  | { kind: "retry"; delayMs: number; code: number | null; message: string }
  /** Attempts exhausted — mark `failed` permanently with this reason. */
  | { kind: "fail"; reason: string; code: number | null };

export interface SendNextActionInput {
  /** The thrown SMTP/transport error; classified here. */
  failure: unknown;
  /** Attempts consumed so far (BullMQ's attemptsMade: 0 on the first try). */
  attemptsMade: number;
  /** Total attempts allowed (cfg.RETRY_MAX_ATTEMPTS). */
  maxAttempts: number;
  /** Override the configured ladder (tests). Defaults to RETRY_BASE_DELAYS_MS. */
  ladderMs?: number[];
  /** Override the configured jitter fraction (tests). */
  jitterPct?: number;
  /** Inject the jitter source for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Decide the next action for a failed send attempt.
 *  - permanent failure → fail (one interface, same reason format as before)
 *  - transient, attempts left → retry after ladder[attemptsMade] ± jitter
 *  - transient, ladder exhausted → fail ("max attempts exceeded: …")
 */
export function nextAction(input: SendNextActionInput): SendNextAction {
  const { failure, attemptsMade, maxAttempts } = input;
  const cls = classifySmtpFailure(failure);

  if (!cls.transient) {
    return {
      kind: "fail",
      reason: `${cls.code ?? "SMTP"} permanent failure: ${cls.message}`,
      code: cls.code,
    };
  }

  if (attemptsMade + 1 >= maxAttempts) {
    return {
      kind: "fail",
      reason: `max attempts exceeded: ${cls.message}`,
      code: cls.code,
    };
  }

  const cfg = getConfig();
  const ladder = input.ladderMs ?? retryLadderMs(cfg);
  const jitterPct = input.jitterPct ?? cfg.RETRY_JITTER_PCT;
  const random = input.random ?? Math.random;

  // Attempts are 0-based in BullMQ; the ladder indexes the *upcoming* attempt.
  const delayMs = computeBackoffWithSource(attemptsMade + 1, ladder, jitterPct, random);
  return { kind: "retry", delayMs, code: cls.code, message: cls.message };
}

function computeBackoffWithSource(
  upcomingAttempt: number,
  ladderMs: number[],
  jitterPct: number,
  random: () => number
): number {
  const idx = Math.min(Math.max(upcomingAttempt - 1, 0), ladderMs.length - 1);
  const base = ladderMs[idx] ?? 0;
  const jitter = base * jitterPct * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * BullMQ custom backoff strategy (§6.4) — derives from nextAction's ladder
 * arithmetic so the engine's retry decision and Bull's scheduling delay share
 * one source of truth.
 */
export function retryDelayForAttempt(attemptsMade: number): number {
  const cfg = getConfig();
  return computeBackoffWithSource(
    attemptsMade,
    retryLadderMs(cfg),
    cfg.RETRY_JITTER_PCT,
    Math.random
  );
}
