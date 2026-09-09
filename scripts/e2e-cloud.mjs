/**
 * Cloud E2E — drives the DEPLOYED Render stack end-to-end (no mocks):
 * real session auth against Neon-backed sessions, CSV/attachment upload,
 * live batch scheduling, real Ethereal SMTP delivery by the in-process
 * worker, rate-limit deferral, PG-fallback search, and logout invalidation.
 *
 * The Redis-loss recovery scenario is covered by scripts/e2e.mjs against the
 * local stack (the cloud Redis is shared/durable and must not be flushed).
 *
 * Usage: node scripts/e2e-cloud.mjs
 * Env:   E2E_CLOUD_API (default https://reachinbox-api-2dfp.onrender.com)
 *        DATABASE_URL  (Neon external string — for session bootstrap + DB truth)
 *        SESSION_SECRET (must match the deployed service)
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const API = process.env.E2E_CLOUD_API ?? "https://reachinbox-api-2dfp.onrender.com";
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!DATABASE_URL || !SESSION_SECRET) {
  throw new Error("set DATABASE_URL (Neon external) and SESSION_SECRET (the deployed one)");
}

// ---------- results ----------
const results = [];
function pass(name, detail = "") { results.push({ ok: true, name, detail }); console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
function fail(name, detail = "") { results.push({ ok: false, name, detail }); console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
function assert(cond, name, detail = "") { (cond ? pass : fail)(name, detail); }
function summary() {
  const p = results.filter((r) => r.ok).length;
  console.log(`\n==== CLOUD E2E SUMMARY: ${p}/${results.length} checks passed ====`);
  if (p !== results.length) process.exitCode = 1;
}

// ---------- DB access (Neon, reachable from anywhere) ----------
const QUERY_HELPER = `
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(process.env.QUERY_SQL);
for (const row of r.rows) console.log(Object.values(row)[0]);
await c.end();
`;
function psql(sql) {
  return execFileSync("node", ["--input-type=module", "--eval", QUERY_HELPER], {
    encoding: "utf8",
    cwd: "packages/db-schema", // `pg` resolves from this package's deps
    timeout: 60_000,
    env: { ...process.env, QUERY_SQL: sql },
    stdio: ["ignore", "pipe", "ignore"], // silence pg's SSL warning noise
  }).trim();
}

async function api(pathname, { method = "GET", cookie, body, form } = {}) {
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

async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
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
async function createSession() {
  await api("/api/auth/google"); // triggers session-table creation server-side
  const tenantId = psql("SELECT id FROM tenants ORDER BY created_at LIMIT 1");
  let userId = psql("SELECT id FROM users WHERE google_id = 'e2e-cloud-user'");
  if (!userId) {
    userId = psql(
      `INSERT INTO users (tenant_id, google_id, name, email, avatar_url)
       VALUES ('${tenantId}', 'e2e-cloud-user', 'Cloud E2E', 'e2e-cloud@local.test', NULL)
       RETURNING id`
    );
  }
  const sid = crypto.randomUUID().replace(/-/g, "").repeat(2).slice(0, 32);
  psql(
    `INSERT INTO session (sid, sess, expire) VALUES ('${sid}', '{"cookie":{"originalMaxAge":604800000},"userId":"${userId}"}', now() + interval '7 days')`
  );
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, "");
  return { cookie: `reachinbox.sid=s%3A${sid}.${encodeURIComponent(sig)}`, tenantId };
}

function batchCounts(batchId) {
  const out = {};
  for (const line of psql(`SELECT status || '|' || count(*) FROM email_jobs WHERE batch_id = '${batchId}' GROUP BY status`).split("\n")) {
    if (!line) continue;
    const [status, count] = line.split("|");
    out[status] = parseInt(count, 10);
  }
  return out;
}

// ===========================================================================
async function main() {
  console.log(`== 0. Deployed API is awake: ${API}`);
  const health = await api("/api/health");
  assert(health.status === 200 && health.json?.ok === true, "/api/health ok", JSON.stringify(health.json?.googleRedirectUris ?? health.json));

  console.log("== 1. Session bootstrap + auth gate");
  const { cookie } = await createSession();
  const me = await api("/api/me", { cookie });
  assert(me.status === 200 && me.json?.email === "e2e-cloud@local.test", "authenticated /api/me", `status=${me.status}`);
  const anon = await api("/api/me");
  assert(anon.status === 401, "unauthenticated request rejected", `status=${anon.status}`);

  console.log("== 2. Senders + Bull Board gate + Slack graceful path");
  const senders = await api("/api/emails/senders", { cookie });
  assert(senders.status === 200 && senders.json?.items?.length >= 2, "sender dropdown (FR-14)", `${senders.json?.items?.length} senders`);
  const sender = senders.json.items[0];
  const bbAnon = await api("/admin/queues");
  assert(bbAnon.status === 401, "Bull Board blocked without session (FR-26)", `status=${bbAnon.status}`);
  const slack = await api("/api/integrations/slack", { cookie });
  assert(slack.status === 200 && slack.json?.connected === false, "Slack unconfigured is graceful (FR-22–25)", JSON.stringify(slack.json));

  console.log("== 3. CSV upload with dupes + invalid rows (FR-30)");
  const csv = "cloude2e+1@example.com\ncloude2e+1@example.com\nbad-at-example.com\nBob <bob@example.com>\n\ncarol@example.com;dave@sub.example.com";
  const upForm = new FormData();
  upForm.append("file", new Blob([csv], { type: "text/csv" }), "recipients.csv");
  const up = await api("/api/emails/upload-recipients", { method: "POST", cookie, form: upForm });
  assert(up.status === 201 && up.json?.validCount === 4 && up.json?.invalidCount === 1, "upload parse feedback", JSON.stringify({ valid: up.json?.validCount, invalid: up.json?.invalidCount }));
  const uploadId = up.json.uploadId;

  console.log("== 4. Attachment upload");
  const attForm = new FormData();
  attForm.append("file", new Blob(["cloud E2E attachment " + Date.now()], { type: "text/plain" }), "cloud-attachment.txt");
  const att = await api("/api/attachments", { method: "POST", cookie, form: attForm });
  assert(att.status === 201 && att.json?.storageUrl, "attachment upload", `status=${att.status}`);
  const attachment = { filename: "cloud-attachment.txt", storageUrl: att.json.storageUrl, contentType: "text/plain" };

  console.log("== 5. Schedule batch A (4 recipients, attachment) — 202 async (FR-4–6)");
  const marker = `cloudmarker${Date.now()}x`;
  const resA = await api("/api/emails/schedule", {
    method: "POST", cookie,
    body: { senderId: sender.id, subject: `${marker} hello from the cloud`, body: "<p>Cloud batch A body</p>", recipientListUploadId: uploadId, startTime: new Date(Date.now() + 1000).toISOString(), delayBetweenSendsMs: 1000, attachments: [attachment] },
  });
  assert(resA.status === 202 && resA.json?.batchId && resA.json?.requestedCount === 4, "schedule response 202 + counts", JSON.stringify(resA.json));
  const batchA = resA.json.batchId;

  console.log("== 6. Schedule batch B (5 recipients, hourlyLimit=2) → rate-limit deferral (FR-20/21)");
  const resB = await api("/api/emails/schedule", {
    method: "POST", cookie,
    body: { senderId: sender.id, subject: "Cloud batch B rate-limit probe", body: "<p>Batch B body</p>", recipients: ["r1@probe.test", "r2@probe.test", "r3@probe.test", "r4@probe.test", "r5@probe.test"], startTime: new Date(Date.now() + 2000).toISOString(), delayBetweenSendsMs: 1000, hourlyLimit: 2 },
  });
  assert(resB.status === 202 && resB.json?.requestedCount === 5, "batch B accepted", JSON.stringify(resB.json));
  const batchB = resB.json.batchId;

  console.log("== 7. Batch A delivers over real SMTP (FR-12/13)");
  await waitFor("batch A all sent", () => batchCounts(batchA)["sent"] === 4, { timeoutMs: 150_000 });
  const ca = batchCounts(batchA);
  assert(ca["sent"] === 4 && !ca["failed"], "batch A: 4/4 sent, 0 failed", JSON.stringify(ca));

  console.log("== 8. Batch B: 2 sent, 3 deferred to next hour window (FR-20/21)");
  await waitFor("batch B stable (2 sent, 3 deferred)", () => {
    const c = batchCounts(batchB);
    return c["sent"] === 2 && c["scheduled"] === 3;
  }, { timeoutMs: 90_000 });
  const cb = batchCounts(batchB);
  assert(cb["sent"] === 2 && cb["scheduled"] === 3 && !cb["failed"], "batch B counts", JSON.stringify(cb));
  const deferred = psql(`SELECT count(*) FROM email_jobs WHERE batch_id = '${batchB}' AND status = 'scheduled' AND attempts = 0 AND last_error IS NULL AND scheduled_at > now()`);
  assert(deferred === "3", "deferred rows: no attempts burned, no error, pushed to next window", `rows=${deferred}`);

  console.log("== 9. Query APIs over the PG-fallback read path (FR-27–29, FR-31–32)");
  const sent = await api("/api/emails/sent?pageSize=100", { cookie });
  assert(sent.status === 200 && sent.json?.items?.filter((i) => i.batchId === batchA)?.length === 4, "sent list shows batch A", `total=${sent.json?.total}`);
  const search = await api(`/api/emails/sent?q=${encodeURIComponent(marker)}`, { cookie });
  assert(search.status === 200 && search.json?.items?.length === 4, "search by subject marker (PG fallback)", `hits=${search.json?.items?.length}`);
  const scheduledList = await api("/api/emails/scheduled?pageSize=100", { cookie });
  assert(scheduledList.status === 200 && scheduledList.json?.items?.filter((i) => i.batchId === batchB)?.length === 3, "scheduled list shows deferred batch B rows");
  const oneSent = sent.json.items.find((i) => i.batchId === batchA);
  const detail = await api(`/api/emails/${oneSent.id}`, { cookie });
  assert(detail.status === 200 && detail.json?.body?.includes("Cloud batch A body"), "detail view returns body");
  const nav = await api("/api/emails/nav-counts", { cookie });
  assert(nav.status === 200 && nav.json?.scheduled >= 3 && nav.json?.sent >= 6, "nav-counts badges", JSON.stringify(nav.json));
  const qstats = await api("/api/emails/queue-stats", { cookie });
  assert(qstats.status === 200 && qstats.json?.queue?.completed >= 6, "queue-stats exposes BullMQ counts", JSON.stringify(qstats.json?.queue));

  console.log("== 10. Logout invalidates the session (FR-3)");
  const out = await api("/api/auth/logout", { cookie });
  assert(out.status === 302 || out.status === 200, "logout responds", `status=${out.status}`);
  const meAfter = await api("/api/me", { cookie });
  assert(meAfter.status === 401, "session dead after logout", `status=${meAfter.status}`);

  summary();
}

main().catch((err) => {
  fail("harness crashed", String(err?.stack ?? err).split("\n")[0]);
  console.error(err);
  summary();
});
