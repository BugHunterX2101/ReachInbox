/**
 * ONE owner of OAuth wire mechanics for E2E harnesses — the parts that must
 * match what the browser really does:
 *   - a redirect-manual fetch that SURFACES response headers (set-cookie,
 *     location) — the JSON-only api() clients hide exactly the headers an
 *     OAuth flow is made of;
 *   - set-cookie parsing for the single session cookie;
 *   - a real PKCE S256 pair (verifier/challenge), same algorithm as the API;
 *   - authorize-URL parsing for assertions on what the server actually sent.
 * Scenario selection lives in consumers (e2e-oauth.mjs); mechanics live here.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Query whatever Postgres DATABASE_URL points at (local docker OR Neon) —
 * the API's session store is wherever its DATABASE_URL goes, so harness
 * assertions on session rows MUST use the same DB. Runs `pg` from
 * packages/db-schema so the dependency resolves; returns rows as objects.
 */
export function pgQuery(sql) {
  const helper = `import pg from "pg";const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query(process.env.QUERY_SQL);console.log(JSON.stringify(r.rows));await c.end();`;
  const out = execFileSync("node", ["--input-type=module", "--eval", helper], {
    encoding: "utf8",
    cwd: "packages/db-schema",
    timeout: 60_000,
    env: { ...process.env, QUERY_SQL: sql },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out || "[]");
}

/** Fetch that keeps the response raw: status + headers + parsed-json best effort. */
export async function fetchRaw(url, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: h, body: payload, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (redirects, html) */ }
  return { status: res.status, headers: res.headers, text, json };
}

/** Extract a cookie's value from a fetch `set-cookie` header. */
export function cookieFrom(setCookie, name) {
  const m = setCookie?.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

/** Decode a connect-pg-simple cookie value back to the bare session id. */
export function sidFromCookieValue(value) {
  return decodeURIComponent(value).split(".")[0].replace(/^s:/, "");
}

/** PKCE S256 pair — identical algorithm to apps/api oauthRedirect consumers. */
export function newPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
