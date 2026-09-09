import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySmtpFailure, extractSmtpCode } from "../smtpErrors.js";

test("extractSmtpCode finds 4xx/5xx codes", () => {
  assert.equal(extractSmtpCode("450 mailbox busy"), 450);
  assert.equal(extractSmtpCode("550 user unknown"), 550);
  assert.equal(extractSmtpCode("no code here"), null);
});

test("4xx codes classify as transient", () => {
  for (const code of [421, 450, 451, 452]) {
    const r = classifySmtpFailure({ responseCode: code, message: `${code} busy` });
    assert.equal(r.transient, true, `${code} should be transient`);
  }
});

test("5xx mailbox codes classify as permanent", () => {
  for (const code of [550, 551, 553, 554]) {
    const r = classifySmtpFailure({ responseCode: code, message: `${code} nope` });
    assert.equal(r.transient, false, `${code} should be permanent`);
  }
});

test("connection errors classify as transient", () => {
  const r = classifySmtpFailure({ code: "ECONNRESET", message: "socket hang up" });
  assert.equal(r.transient, true);
});

test("auth errors classify as permanent", () => {
  const r = classifySmtpFailure({ code: "EAUTH", message: "535 authentication failed" });
  assert.equal(r.transient, false);
});

test("unknown errors default to transient so the ladder is exhausted", () => {
  const r = classifySmtpFailure(new Error("something odd"));
  assert.equal(r.transient, true);
});
