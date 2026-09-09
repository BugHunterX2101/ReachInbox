import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBackoffMs, hasAttemptsLeft } from "../backoff.js";
import { hourWindowKey, secondsUntilNextHour } from "../rateLimiter.js";

test("backoff ladder picks base delays in order", () => {
  const ladder = [30_000, 60_000, 120_000];
  // jitter is ±20%, so results must be within bounds
  for (const [made, base] of [[1, 30_000], [2, 60_000], [3, 120_000], [4, 120_000]] as const) {
    const v = computeBackoffMs(made, ladder, 0.2);
    assert.ok(v >= base * 0.8 && v <= base * 1.2, `attempt ${made}: ${v} within ±20% of ${base}`);
  }
});

test("backoff with zero jitter is exact", () => {
  const ladder = [30_000, 60_000, 120_000];
  assert.equal(computeBackoffMs(1, ladder, 0), 30_000);
  assert.equal(computeBackoffMs(3, ladder, 0), 120_000);
});

test("attempts beyond the ladder clamp to the last delay", () => {
  const ladder = [30_000];
  assert.equal(computeBackoffMs(9, ladder, 0), 30_000);
});

test("hasAttemptsLeft", () => {
  assert.equal(hasAttemptsLeft(1, 4), true);
  assert.equal(hasAttemptsLeft(4, 4), false);
});

test("hourWindowKey format", () => {
  const d = new Date("2026-09-09T07:05:00Z");
  assert.equal(hourWindowKey("sender", "abc", d), "rate:sender:abc:2026090907");
  assert.equal(hourWindowKey("tenant", "t1", d), "rate:tenant:t1:2026090907");
});

test("secondsUntilNextHour", () => {
  const d = new Date("2026-09-09T07:59:30Z");
  const s = secondsUntilNextHour(d);
  // 30s to the boundary + 5s buffer
  assert.ok(s >= 35 && s <= 36, `got ${s}`);
});
