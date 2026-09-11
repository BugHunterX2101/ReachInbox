import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { browserOrigin, redirectUriFor, expectedUrisFor } from "../oauthRedirect.js";

// Minimal env so getConfig() parses once for the whole file (it caches) —
// env is therefore fixed here and NOT mutated per test. Use the production
// shape (Render external URL + https dashboard) so the derived-set test can
// assert the exact URIs a deployed service must register.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WEB_URL = "https://web.example.onrender.com";
process.env.RENDER_EXTERNAL_URL = "https://api.example.onrender.com";
process.env.GOOGLE_REDIRECT_URI = "";
process.env.SLACK_REDIRECT_URI = "";

function reqFrom(headers: Record<string, string>, secure = false): Request {
  return { headers, secure, host: headers.host } as unknown as Request;
}

const PATH = "/cb";

test("browserOrigin prefers X-Forwarded-Host/Proto (dashboard proxy case)", () => {
  const req = reqFrom({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "web.example.onrender.com",
    host: "api.internal:3001",
  });
  assert.equal(browserOrigin(req), "https://web.example.onrender.com");
});

test("browserOrigin takes the first entry of comma lists", () => {
  const req = reqFrom({
    "x-forwarded-proto": "https,http",
    "x-forwarded-host": "a.example.com,b.example.com",
  });
  assert.equal(browserOrigin(req), "https://a.example.com");
});

test("browserOrigin falls back to Host, then to localhost:3001", () => {
  assert.equal(browserOrigin(reqFrom({ host: "localhost:3000" })), "http://localhost:3000");
  const secureNoHost = { headers: {}, secure: true } as unknown as Request;
  assert.equal(browserOrigin(secureNoHost), "https://localhost:3001");
  assert.equal(browserOrigin(reqFrom({})), "http://localhost:3001");
});

test("redirectUriFor: explicit config wins over the browsing origin", () => {
  const req = reqFrom({ host: "localhost:3000" });
  assert.equal(redirectUriFor(req, PATH, "https://fixed.example.com/cb"), "https://fixed.example.com/cb");
});

test("redirectUriFor: derives from the browsing origin when unconfigured", () => {
  const req = reqFrom({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "web.example.onrender.com",
    host: "api.internal:3001",
  });
  assert.equal(redirectUriFor(req, PATH, ""), "https://web.example.onrender.com/cb");
});

test("expectedUrisFor: configured => exactly that URI (no localhost noise)", () => {
  assert.deepEqual(expectedUrisFor(PATH, "https://fixed.example.com/cb"), ["https://fixed.example.com/cb"]);
});

test("expectedUrisFor: derives RENDER_EXTERNAL_URL + WEB_URL + local dev", () => {
  assert.deepEqual(expectedUrisFor("/api/auth/google/callback", ""), [
    "https://api.example.onrender.com/api/auth/google/callback",
    "https://web.example.onrender.com/api/auth/google/callback",
    "http://localhost:3000/api/auth/google/callback",
    "http://localhost:3001/api/auth/google/callback",
  ]);
});
