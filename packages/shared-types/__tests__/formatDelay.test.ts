import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDelay } from "../../dist/index.js";





test("formatDelay: 0ms → '0ms'", () => {
  assert.equal(formatDelay(0), "0ms");
});

test("formatDelay: 500ms → '500ms'", () => {
  assert.equal(formatDelay(500), "500ms");
});

test("formatDelay: 999ms → '999ms'", () => {
  assert.equal(formatDelay(999), "999ms");
});

test("formatDelay: 1000ms → '1s'", () => {
  assert.equal(formatDelay(1000), "1s");
});

test("formatDelay: 1500ms → '1.5s'", () => {
  assert.equal(formatDelay(1500), "1.5s");
});

test("formatDelay: 2900ms → '2.9s'", () => {
  assert.equal(formatDelay(2900), "2.9s");
});test("formatDelay: 59000ms → '59s'", () => {
  assert.equal(formatDelay(59000), "59s");
});

test("formatDelay: 60000ms → '1m 0s'", () => {
  assert.equal(formatDelay(60000), "1m 0s");
});

test("formatDelay: 90000ms → '1m 30s' (verification of E2E expectation)", () => {
  assert.equal(formatDelay(90_000), "1m 30s");
});

test("formatDelay: 90001ms → '1m 30s' (rounded-down — floors fraction of a second)", () => {
  assert.equal(formatDelay(90_001), "1m 30s");
});

test("formatDelay: 92345ms → '1m 32s'", () => {
  assert.equal(formatDelay(92_345), "1m 32s");
});

test("formatDelay: 120000ms → '2m 0s'", () => {
  assert.equal(formatDelay(120_000), "2m 0s");
});
