import assert from "node:assert/strict";
import { test } from "node:test";
import { nextAction } from "../sendPolicy.js";

// Ladder/jitter are injected so these tests need no config, Redis, or DB.
const LADDER = [30_000, 60_000, 120_000];

const base = {
  ladderMs: LADDER,
  jitterPct: 0,
  random: () => 0.5, // mid-range random → zero jitter contribution
};

test("permanent SMTP failure fails immediately regardless of attempts", () => {
  for (const attemptsMade of [0, 1, 3]) {
    const r = nextAction({ ...base, failure: { responseCode: 550, message: "550 user unknown" }, attemptsMade, maxAttempts: 4 });
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.match(r.reason, /550 permanent failure/);
      assert.equal(r.code, 550);
    }
  }
});

test("transient failure with attempts left retries up the ladder", () => {
  const cases: Array<[number, number]> = [
    [0, 30_000], // upcoming attempt 1 → ladder[0]
    [1, 60_000],
    [2, 120_000],
  ];
  for (const [attemptsMade, expected] of cases) {
    const r = nextAction({ ...base, failure: { responseCode: 450, message: "450 busy" }, attemptsMade, maxAttempts: 4 });
    assert.deepEqual(r, { kind: "retry", delayMs: expected, code: 450, message: "450 busy" });
  }
});

test("transient failure at the last attempt fails with max-attempts reason", () => {
  const r = nextAction({ ...base, failure: { responseCode: 451, message: "451 overloaded" }, attemptsMade: 3, maxAttempts: 4 });
  assert.equal(r.kind, "fail");
  if (r.kind === "fail") assert.match(r.reason, /^max attempts exceeded: 451 overloaded$/);
});

test("connection errors retry like other transient failures", () => {
  const r = nextAction({ ...base, failure: { code: "ECONNRESET", message: "socket hang up" }, attemptsMade: 0, maxAttempts: 4 });
  assert.equal(r.kind, "retry");
  if (r.kind === "retry") assert.equal(r.delayMs, 30_000);
});

test("auth errors fail immediately (retrying can't fix them)", () => {
  const r = nextAction({ ...base, failure: { code: "EAUTH", message: "535 auth failed" }, attemptsMade: 0, maxAttempts: 4 });
  assert.equal(r.kind, "fail");
  if (r.kind === "fail") assert.match(r.reason, /permanent failure/);
});

test("unknown errors default to transient so the ladder is exhausted", () => {
  const r = nextAction({ ...base, failure: new Error("something odd"), attemptsMade: 0, maxAttempts: 4 });
  assert.equal(r.kind, "retry");
});

test("one attempt allowed means first transient failure is terminal", () => {
  const r = nextAction({ ...base, failure: { responseCode: 421, message: "421 down" }, attemptsMade: 0, maxAttempts: 1 });
  assert.equal(r.kind, "fail");
  if (r.kind === "fail") assert.match(r.reason, /^max attempts exceeded:/);
});

test("retry delay clamps to the last ladder rung", () => {
  const r = nextAction({ ...base, ladderMs: [30_000], failure: { responseCode: 450, message: "450" }, attemptsMade: 9, maxAttempts: 20 });
  assert.equal(r.kind, "retry");
  if (r.kind === "retry") assert.equal(r.delayMs, 30_000);
});

test("jitter stays within ±jitterPct of the rung", () => {
  const r = nextAction({
    ...base,
    jitterPct: 0.2,
    random: () => 1, // +20%
    failure: { responseCode: 450, message: "450" },
    attemptsMade: 0,
    maxAttempts: 4,
  });
  assert.equal(r.kind, "retry");
  if (r.kind === "retry") assert.equal(r.delayMs, 36_000);
});
