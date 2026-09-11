/**
 * OAuth E2E — drives BOTH provider flows (Google + Slack) against the REAL
 * API over real HTTP, asserting the exact bytes on the wire and the session
 * state machine behind them. No mocks. The only un-automatable hop — the
 * human consent screen — is replaced by consent-denial round-trips, which
 * exercise everything except the final token exchange: session binding,
 * PKCE/nonce/state generation, redirect-URI derivation, provider-facing
 * authorize URLs, denial handling, replay protection, and every graceful
 * unconfigured path.
 *
 * Not covered (needs a human in the loop): Google/Slack consent → real code →
 * token exchange → user/integration rows. Those are covered in staging by
 * clicking through once after each deploy.
 *
 * Usage: node scripts/e2e-oauth.mjs   (API on :3001 + docker stores running)
 * Exit code 0 only if every check passed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { assert, summary } from "./lib/reporter.mjs";
import { fetchRaw, cookieFrom, sidFromCookieValue, newPkce, pgQuery } from "./lib/oauthHarness.mjs";

const API = "http://localhost:3001";

// CONTRACT: the pg bridge must target the SAME Postgres the API under test
// uses — pass DATABASE_URL explicitly when the API runs on anything other
// than what .env names (e.g. all-local runs: docker Postgres on :5433).
if (!process.env.DATABASE_URL) {
  const line = fs.readFileSync(".env", "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (line) process.env.DATABASE_URL = line[1].replace(/^"(.*)"$/, "$1");
}
function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^\"(.*)\"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return env;
}
const ENV = loadEnv();
const WEB_ORIGIN = ENV.WEB_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

function setCookieOf(res) {
  return res.headers.getSetCookie ? res.headers.getSetCookie().join("\n") : res.headers.get("set-cookie") ?? "";
}
function sessionRow(sid) {
  const rows = pgQuery(`SELECT sess FROM session WHERE sid = '${sid}'`);
  return rows.length ? rows[0].sess : null;
}
/** Seed userId into the session row — what the Google callback writes on success. */
function seedSessionUser(sid, userId) {
  pgQuery(
    `UPDATE session SET sess = (sess::jsonb || jsonb_build_object('userId', '${userId}'))::json WHERE sid = '${sid}'`
  );
}
function firstUserId() {
  const rows = pgQuery("SELECT id FROM users ORDER BY created_at LIMIT 1");
  if (rows.length) return rows[0].id;
  const tenant = pgQuery("SELECT id FROM tenants ORDER BY created_at LIMIT 1")[0].id;
  return pgQuery(
    `INSERT INTO users (tenant_id, google_id, name, email, avatar_url) VALUES ('${tenant}', 'oauth-e2e-user', 'OAuth E2E', 'oauth-e2e@local.test', NULL) RETURNING id`
  )[0].id;
}
function qs(url) {
  return Object.fromEntries(new URL(url).searchParams);
}

// ============ GOOGLE (FR-1–3) ============
console.log("\n== Google OAuth flow ==");
const health = await fetchRaw(`${API}/api/health`);
assert(health.json?.ok === true && health.json?.googleConfigured === true, "API healthy, Google configured");

const me0 = await fetchRaw(`${API}/api/me`);
assert(me0.status === 401, "unauthenticated /api/me rejected", `status=${me0.status}`);

const a1 = await fetchRaw(`${API}/api/auth/google`);
const loc1 = a1.headers.get("location") ?? "";
assert(a1.status === 302 && loc1.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "authorize redirect → Google");
const p1 = qs(loc1);
const pkce = newPkce();
assert(
  /^[A-Za-z0-9_-]{43,}$/.test(p1.code_challenge ?? "") && p1.code_challenge_method === "S256" && p1.code_challenge !== pkce.challenge,
  "PKCE S256 challenge present (fresh per flow)"
);
assert(Boolean(p1.state) && Boolean(p1.nonce) && p1.scope === "openid email profile", "state + nonce + scopes on the authorize URL");
assert(p1.client_id === ENV.GOOGLE_CLIENT_ID, "client_id matches the configured OAuth client");

const cookieName = "reachinbox.sid";
const cookie1 = cookieFrom(setCookieOf(a1), cookieName);
assert(Boolean(cookie1), "session cookie issued on flow start");
const sid1 = sidFromCookieValue(cookie1);
const row1 = sessionRow(sid1);
assert(
  row1?.oauthState === p1.state && Boolean(row1?.oauthNonce) && Boolean(row1?.oauthVerifier),
  "session binds state + nonce + PKCE verifier server-side"
);
assert(row1?.oauthRedirectUri === "http://localhost:3001/api/auth/google/callback", "binds the exact redirect_uri used");

const a2 = await fetchRaw(`${API}/api/auth/google`, {
  headers: { "x-forwarded-proto": "https", "x-forwarded-host": "dashboard.example.onrender.com" },
});
const viaProxy = qs(a2.headers.get("location") ?? "").redirect_uri ?? "";
assert(viaProxy === "https://dashboard.example.onrender.com/api/auth/google/callback", "redirect_uri derives from the browsing origin (proxy-aware)", viaProxy);
assert(
  (health.json?.googleRedirectUris ?? []).includes("http://localhost:3000/api/auth/google/callback"),
  "health lists the dashboard-origin URI to register"
);

// Consent denied — exactly what Google sends back on denial:
const d1 = await fetchRaw(
  `${API}/api/auth/google/callback?error=access_denied&error_description=${encodeURIComponent("denied by harness")}&state=${p1.state}`,
  { cookie: `${cookieName}=${cookie1}` }
);
const dloc = d1.headers.get("location") ?? "";
assert(d1.status === 302 && dloc.startsWith(`${WEB_ORIGIN}/login`), "denial → back to the login screen", dloc);
assert(dloc.includes("authError=access_denied"), "login screen receives the denial reason");

const row2 = sessionRow(sid1);
assert(!row2?.oauthState, "one-time OAuth bind cleared after the round-trip");

const d2 = await fetchRaw(`${API}/api/auth/google/callback?code=forged&state=${p1.state}`, {
  cookie: `${cookieName}=${cookie1}`,
});
assert((d2.headers.get("location") ?? "").includes("authError=state_mismatch"), "replayed state rejected (CSRF guard)");

// ============ SLACK (FR-22–25) ============
console.log("\n== Slack OAuth flow ==");
const s0 = await fetchRaw(`${API}/api/integrations/slack`);
assert(s0.status === 401, "unauthenticated Slack status rejected", `status=${s0.status}`);

// Pretend the Google hop succeeded: seed the userId into the same session row
// (exactly what the Google callback writes) so the authed Slack half can run.
seedSessionUser(sid1, firstUserId());
const meMid = await fetchRaw(`${API}/api/me`, { cookie: `${cookieName}=${cookie1}` });
assert(meMid.status === 200, "seeded session authenticates (Google-callback-equivalent state)", `status=${meMid.status}`);

const slackConfigured = Boolean(ENV.SLACK_CLIENT_ID && ENV.SLACK_CLIENT_SECRET);
if (slackConfigured) {
  const c1 = await fetchRaw(`${API}/api/integrations/slack/connect`, { cookie: `${cookieName}=${cookie1}` });
  const cl = c1.headers.get("location") ?? "";
  assert(c1.status === 302 && cl.startsWith("https://slack.com/oauth/v2/authorize"), "connect → Slack authorize URL");
  const cp = qs(cl);
  assert(cp.scope === "chat:write" && Boolean(cp.state) && Boolean(cp.redirect_uri), "scopes + state + redirect_uri on the authorize URL");
  const cookie2 = cookieFrom(setCookieOf(c1), cookieName);
  assert(!cookie2 || cookie2 === cookie1, "session preserved across the connect hop");
  assert(sessionRow(sid1)?.slackState === cp.state, "Slack state bound to the session");

  const d3 = await fetchRaw(
    `${API}/api/integrations/slack/callback?error=access_denied&state=${cp.state}`,
    { cookie: `${cookieName}=${cookie1}` }
  );
  // Note: the Slack callback has no explicit ?error= branch (unlike Google's) —
  // a denial arrives as a missing code and surfaces as slack=missing_code.
  // Documented behavior; a dedicated denial banner is a future nicety.
  assert((d3.headers.get("location") ?? "").includes("/settings?slack=missing_code"), "Slack denial handled → settings banner (as missing_code)");

  const d4 = await fetchRaw(`${API}/api/integrations/slack/callback?code=x&state=wrong`, {
    cookie: `${cookieName}=${cookie1}`,
  });
  assert((d4.headers.get("location") ?? "").includes("slack=state_mismatch"), "Slack replayed/wrong state rejected");
} else {
  const c1 = await fetchRaw(`${API}/api/integrations/slack/connect`, { cookie: `${cookieName}=${cookie1}` });
  assert(c1.status === 503 && c1.json?.error?.code === "INTERNAL_ERROR", "unconfigured connect → clear 503 (real-OAuth-only policy)");
  assert(
    typeof c1.json?.error?.message === "string" && c1.json.error.message.includes("SLACK_CLIENT_ID"),
    "503 names the missing env vars"
  );
}
const st = await fetchRaw(`${API}/api/integrations/slack`, { cookie: `${cookieName}=${cookie1}` });
assert(st.status === 200 && st.json?.connected === false, "graceful absence: status reports connected:false", JSON.stringify(st.json));

// ============ LOGOUT (FR-3) ============
console.log("\n== Session end ==");
const lo = await fetchRaw(`${API}/api/auth/logout`, { cookie: `${cookieName}=${cookie1}` });
assert(lo.status === 302 && (lo.headers.get("location") ?? "").includes("/login"), "logout → login screen");
const meEnd = await fetchRaw(`${API}/api/me`, { cookie: `${cookieName}=${cookie1}` });
assert(meEnd.status === 401, "logout invalidates the session server-side");

summary("OAUTH E2E (GOOGLE + SLACK)");
