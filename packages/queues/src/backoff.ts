/**
 * Backoff for transient SMTP failures (§6.4 / Q4): 4 total attempts,
 * waits of 30s → 60s → 120s with ±jitter spread so a batch that fails
 * together doesn't retry in lockstep.
 */
export function computeBackoffMs(
  attemptsMade: number,
  ladderMs: number[],
  jitterPct: number
): number {
  const idx = Math.min(Math.max(attemptsMade - 1, 0), ladderMs.length - 1);
  const base = ladderMs[idx] ?? 0;
  const jitter = base * jitterPct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** True when another retry is still available after `attemptsMade` attempts. */
export function hasAttemptsLeft(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade < maxAttempts;
}
