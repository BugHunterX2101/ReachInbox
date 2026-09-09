import rateLimit from "express-rate-limit";

/**
 * API-level throttling (§11) — per-IP guard against endpoint abuse. Distinct
 * from, and layered on top of, the per-sender/per-tenant email rate limiting.
 */
export function createApiRateLimiter(): ReturnType<typeof rateLimit> {
  const max = parseInt(process.env.API_RATE_LIMIT_MAX ?? "600", 10);
  const windowMs = parseInt(process.env.API_RATE_LIMIT_WINDOW_MS ?? "60000", 10);
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "too many requests, slow down" } },
  });
}
