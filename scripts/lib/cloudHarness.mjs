/**
 * Shared plumbing for the cloud E2E harnesses — ONE owner of:
 *   - the Neon psql bridge (subprocess so `pg` resolves from workspace deps)
 *   - the deployed-API client (JSON + multipart forms, redirect-manual)
 *   - session bootstrap that mirrors exactly what the OAuth callback writes
 *   - the results reporter (PASS/FAIL lines + summary + exit code)
 *   - batch status polling helpers against the Neon DB
 *
 * Consumers: e2e-cloud.mjs (full, includes SMTP delivery) and
 * e2e-cloud-nosmtp.mjs (every surface except SMTP delivery, for provider
 * outages). Scenario selection lives in the consumers; the mechanics live here.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const API = process.env.E2E_CLOUD_API ?? "https://reachinbox-api-1187.onrender.com";
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!DATABASE_URL || !SESSION_SECRET) {
  throw new Error("set DATABASE_URL (Neon external) and SESSION_SECRET (the deployed one)");
}

// ---------- results reporter ----------
const results = [];
function pass(name, detail = "") { results.push({ ok: true, name, detail }); console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
function fail(name, detail = "") { results.push({ ok: false, name, detail }); console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
export function assert(cond, name, detail = "") { (cond ? pass : fail)(name, detail); }
export function summary(label = "CLOUD E2E") {
  const p = results.filter((r) => r.ok).length;
  console.log(`\n==== ${label} SUMMARY: ${p}/${results.length} checks passed ====`);
  if (p !== results.length) process.exitCode = 1;
}

// ---------- DB access (Neon, reachable from anywhere) ----------
const QUERY_HELPER = `import pg from "pg";const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query(process.env.QUERY_SQL);for(const row of r.rows)console.log(Object.values(row)[0]);await c.end();`;
export function psql(sql) {
  return execFileSync("node", ["--input-type=module", "--eval", QUERY_HELPER], {
    encoding: "utf8",
    cwd: "packages/db-schema", // `pg` resolves from this package's deps
    timeout: 60_000,
    env: { ...process.env, QUERY_SQL: sql },
    stdio: ["ignore", "pipe", "ignore"], // silence pg's SSL warning noise
  }).trim();
}

// ---------- deployed-API client ----------
export async function api(pathname, { method = "GET", cookie, body, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${pathname}`, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

export async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------- session bootstrap (same shape the OAuth callback writes) ----------
export async function createSession() {
  await api("/api/auth/google"); // triggers session-table creation server-side
  const tenantId = psql("SELECT id FROM tenants ORDER BY created_at LIMIT 1");
  let userId = psql("SELECT id FROM users WHERE google_id = 'e2e-cloud-user'");
  if (!userId) {
    userId = psql(
      `INSERT INTO users (tenant_id, google_id, name, email, avatar_url) VALUES ('${tenantId}', 'e2e-cloud-user', 'Cloud E2E', 'e2e-cloud@local.test', NULL) RETURNING id`
    );
  }
  const sid = crypto.randomUUID().replace(/-/g, "").repeat(2).slice(0, 32);
  psql(
    `INSERT INTO session (sid, sess, expire) VALUES ('${sid}', '{"cookie":{"originalMaxAge":604800000},"userId":"${userId}"}', now() + interval '7 days')`
  );
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, "");
  return { cookie: `reachinbox.sid=s%3A${sid}.${encodeURIComponent(sig)}`, tenantId };
}

// ---------- batch polling (DB truth, not the read API) ----------
export function batchCounts(batchId) {
  const out = {};
  for (const line of psql(`SELECT status || '|' || count(*) FROM email_jobs WHERE batch_id = '${batchId}' GROUP BY status`).split("\n")) {
    if (!line) continue;
    const [status, count] = line.split("|");
    out[status] = parseInt(count, 10);
  }
  return out;
}
