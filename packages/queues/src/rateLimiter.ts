import type { Redis } from "ioredis";

/**
 * Atomic multi-cap rate limiter (§6.3, Q2) — per-sender AND per-tenant hourly
 * caps (plus an optional per-batch override), checked and incremented in ONE
 * Lua execution so two workers racing the same boundary can never both pass
 * (PRD edge case). Rejecting before incrementing anything means a denied
 * attempt never partially consumes one quota without the others.
 */
const MULTI_RATE_LIMIT_LUA = `
local n = tonumber(ARGV[1])
for i = 1, n do
  local c = tonumber(redis.call('GET', KEYS[i]) or '0')
  if c >= tonumber(ARGV[1 + i]) then
    return 0 -- reject: caller defers the job
  end
end
for i = 1, n do
  redis.call('INCR', KEYS[i])
  redis.call('EXPIRE', KEYS[i], ARGV[n + 2])
end
return 1 -- allow: caller proceeds to SMTP send
`;

/** Hour window key: rate:{scope}:{id}:{YYYYMMDDHH} — TTL'd past the hour boundary. */
export function hourWindowKey(scope: "tenant" | "sender" | "batch", id: string, at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const h = String(at.getUTCHours()).padStart(2, "0");
  return `rate:${scope}:${id}:${y}${m}${d}${h}`;
}

/** Seconds until the top of the next hour, +5s buffer (§5 Redis key table). */
export function secondsUntilNextHour(at: Date): number {
  const next = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    at.getUTCHours() + 1,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000) + 5);
}

/** Start of the next hour window (deferral target, §6.6). */
export function startOfNextHour(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours() + 1, 0, 0, 0)
  );
}

export interface RateCounter {
  key: string;
  cap: number;
}

/** Returns true when allowed (all counters incremented), false when over any cap (nothing touched). */
export async function checkAndConsumeRateLimits(
  redis: Redis,
  counters: RateCounter[],
  now: Date = new Date()
): Promise<boolean> {
  if (counters.length === 0) return true;
  const keys = counters.map((c) => c.key);
  const args: Array<string | number> = [counters.length, ...counters.map((c) => c.cap), secondsUntilNextHour(now)];
  const result = (await redis.eval(MULTI_RATE_LIMIT_LUA, keys.length, ...keys, ...args)) as number;
  return result === 1;
}

/** Read-only peek at current window counts — used by the queue-stats endpoint. */
export async function peekRateLimitCounters(
  redis: Redis,
  params: { tenantId: string; senderId: string },
  now: Date = new Date()
): Promise<{ tenantCount: number; senderCount: number; window: string }> {
  const window = hourWindowKey("sender", params.senderId, now).split(":").pop() ?? "";
  const tenantCount = parseInt(
    (await redis.get(hourWindowKey("tenant", params.tenantId, now))) ?? "0",
    10
  );
  const senderCount = parseInt(
    (await redis.get(hourWindowKey("sender", params.senderId, now))) ?? "0",
    10
  );
  return { tenantCount, senderCount, window };
}
