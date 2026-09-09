/**
 * Test suite for shared parsing utilities (run against compiled JS via node --test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecipients, normalizeEmail, isValidEmail, formatDelay } from "../index.js";

test("parseRecipients handles newline-separated lists", () => {
  const r = parseRecipients("a@example.com\nb@example.com\nc@example.com");
  assert.equal(r.valid.length, 3);
  assert.equal(r.invalid.length, 0);
});

test("parseRecipients handles CSV with quoted display names", () => {
  const r = parseRecipients('"Doe, Jane" <jane@example.com>,john@example.com;sam@example.com');
  assert.deepEqual(r.valid, ["jane@example.com", "john@example.com", "sam@example.com"]);
});

test("parseRecipients deduplicates case-insensitively and reports skips", () => {
  const r = parseRecipients("A@Example.com\na@example.com\nb@example.com");
  assert.deepEqual(r.valid, ["a@example.com", "b@example.com"]);
  assert.equal(r.duplicatesSkipped, 1);
});

test("parseRecipients collects invalid samples", () => {
  const r = parseRecipients("ok@example.com\nnot-an-email\n@bad\n\n");
  assert.deepEqual(r.valid, ["ok@example.com"]);
  assert.deepEqual(r.invalid, ["not-an-email", "@bad"]);
});

test("normalizeEmail strips mailto and angle brackets", () => {
  assert.equal(normalizeEmail("mailto:Foo@Example.COM"), "foo@example.com");
  assert.equal(normalizeEmail("Foo Bar <foo@x.io>"), "foo@x.io");
});

test("isValidEmail rejects obvious junk", () => {
  assert.equal(isValidEmail("nope"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(isValidEmail("a@b.co"), true);
});

test("formatDelay renders human units", () => {
  assert.equal(formatDelay(500), "500ms");
  assert.equal(formatDelay(3000), "3s");
  assert.equal(formatDelay(90_000), "1m 30s");
});
