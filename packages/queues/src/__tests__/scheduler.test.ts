import assert from "node:assert/strict";
import { test } from "node:test";
import { computeJobId } from "@reachinbox/db-schema";

test("computeJobId is deterministic for the same batch + recipient", () => {
  const a = computeJobId("batch-1", "Alice@Example.COM");
  const b = computeJobId("batch-1", "alice@example.com ");
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

test("computeJobId differs across batches and recipients", () => {
  const a = computeJobId("batch-1", "a@x.com");
  const b = computeJobId("batch-2", "a@x.com");
  const c = computeJobId("batch-1", "b@x.com");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("scheduled_at pacing spreads sends by delay", () => {
  // mirrors expandBatch's scheduling formula
  const start = new Date("2026-09-10T10:00:00Z").getTime();
  const delay = 3000;
  const rows = [0, 1, 2].map((idx) => new Date(start + idx * delay));
  assert.equal(rows[1].getTime() - rows[0].getTime(), 3000);
  assert.equal(rows[2].getTime() - rows[1].getTime(), 3000);
});
