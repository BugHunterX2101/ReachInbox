/**
 * End-to-end verification harness — drives the REAL HTTP API (no mocks):
 * session auth, CSV + attachment upload, batch scheduling, SMTP send via real
 * Ethereal accounts, per-batch rate-limit deferral, Elasticsearch search,
 * Bull Board gate, Slack-unconfigured path, logout, and Redis-loss recovery.
 *
 * Usage: node scripts/e2e.mjs   (API + worker + docker stores must be running)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const API = "http://localhost:3001";
const PG = ["docker", "exec", "email_automation-postgres-1", "psql", "-U", "reachinbox", "-t", "-A", "-q", "-c"];
const REDIS = ["docker", "exec", "email_automation-redis-1", "redis-cli"];
const results = [];

// ---------- tiny harness ----------
function pass(name, detail = "") {
  results.push({ ok: true, name });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ ok: false, name });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond, name, detail = "") {
  cond ? pass(name, detail) : fail(name, detail);
  return Boolean(cond);
}
function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== E2E SUMMARY: ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length) {
    console.log("Failed checks:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

// ---------- env / db helpers ----------
function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const ENV = loadEnv();

function psql(sql) {
  return execFileSync(PG[0], [...PG.slice(1), sql], { encoding: "utf8" }).trim();
}
function redis(...args) {
  return execFileSync(REDIS[0], [...REDIS.slice(1), ...args], { encoding: "utf8" }).trim();
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
  // redirect:"manual" — logout redirects to the web UI (not running in the
  // harness), and following it would surface as a confusing ECONNREFUSED.
  const res = await fetch(`${API}${pathname}`, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (html etc.) */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function waitFor(label, fn, { timeoutMs = 90_000, intervalMs = 2000 } = {}) {
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

// ---------- session bootstrap ----------
async function createSession() {
  // Touch the OAuth entry route once: it saves a session (oauthState), which
  // makes connect-pg-simple create its `session` table if missing.
  await api("/api/auth/google");
  const tenantId = psql("SELECT id FROM tenants ORDER BY created_at LIMIT 1");
  let userId = psql("SELECT id FROM users WHERE google_id = 'e2e-local-user'");
  if (!userId) {
    userId = psql(
      `INSERT INTO users (tenant_id, google_id, name, email, avatar_url)
       VALUES ('${tenantId}', 'e2e-local-user', 'E2E Verifier', 'e2e-verifier@local.test', NULL)
       RETURNING id`
    );
  }
  // Real server-side session row (connect-pg-simple) — the same kind of
  // session the Google OAuth callback creates. OAuth itself stays real-only.
  const sid = crypto.randomUUID().replace(/-/g, "").repeat(2).slice(0, 32);
  psql(
    `INSERT INTO session (sid, sess, expire) VALUES ('${sid}', '{"cookie":{"originalMaxAge":604800000},"userId":"${userId}"}', now() + interval '7 days')`
  );
  // express-session cookie value: "s:<sid>.<hmac(secret, sid)>" (cookie-signature format)
  const sig = crypto.createHmac("sha256", ENV.SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, "");
  return { cookie: `reachinbox.sid=s%3A${sid}.${encodeURIComponent(sig)}`, userId, tenantId };
}

// ---------- batch status from the DB (source of truth) ----------
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
  console.log("== 1. Session bootstrap (server-side PG session, real requireAuth path)");
  const { cookie } = await createSession();
  const me = await api("/api/me", { cookie });
  assert(me.status === 200 && me.json?.email === "e2e-verifier@local.test", "authenticated /api/me", `status=${me.status}`);
  const anon = await api("/api/me");
  assert(anon.status === 401, "unauthenticated request rejected", `status=${anon.status}`);

  console.log("== 2. Senders + Bull Board gate + Slack unconfigured path");
  const senders = await api("/api/emails/senders", { cookie });
  assert(senders.status === 200 && senders.json?.items?.length >= 2, "sender dropdown (FR-14)", `${senders.json?.items?.length} senders`);
  const sender = senders.json.items[0];

  const bb = await api("/admin/queues", { cookie });
  const bbAnon = await api("/admin/queues");
  assert(bb.status === 200, "Bull Board with session (FR-26)", `status=${bb.status}`);
  assert(bbAnon.status === 401, "Bull Board blocked without session (FR-26)", `status=${bbAnon.status}`);

  const slack = await api("/api/integrations/slack", { cookie });
  assert(slack.status === 200 && slack.json?.connected === false, "Slack status: unconfigured is graceful (FR-22–25)", JSON.stringify(slack.json));

  console.log("== 3. CSV upload with dupes + invalid rows (FR-30)");
  const csv = "alice+1@example.com\nalice+1@example.com\nbad-at-example.com\nBob <bob@example.com>\n\ncarol@example.com;dave@sub.example.com";
  const upForm = new FormData();
  upForm.append("file", new Blob([csv], { type: "text/csv" }), "recipients.csv");
  const up = await api("/api/emails/upload-recipients", { method: "POST", cookie, form: upForm });
  assert(up.status === 201 && up.json?.validCount === 4 && up.json?.invalidCount === 1, "upload parse feedback", JSON.stringify({ valid: up.json?.validCount, invalid: up.json?.invalidCount }));
  const uploadId = up.json.uploadId;

  console.log("== 4. Attachment upload (signed URL for the worker)");
  const attForm = new FormData();
  attForm.append("file", new Blob(["E2E attachment payload " + Date.now()], { type: "text/plain" }), "e2e-attachment.txt");
  const att = await api("/api/attachments", { method: "POST", cookie, form: attForm });
  assert(att.status === 201 && att.json?.storageUrl, "attachment upload", `status=${att.status}`);
  const attachment = { filename: "e2e-attachment.txt", storageUrl: att.json.storageUrl, contentType: "text/plain" };

  console.log("== 5. Schedule batch A (4 recipients via uploadId, attachments) — 202 async (FR-4–6)");
  // Single-token marker (no hyphen — ES would tokenize "E2E-123" into two).
  const markerA = `e2emarker${Date.now()}x`;
  const startA = new Date(Date.now() + 1000).toISOString();
  const resA = await api("/api/emails/schedule", {
    method: "POST", cookie,
    body: { senderId: sender.id, subject: `${markerA} hello from batch A`, body: "<p>Batch A body</p>", recipientListUploadId: uploadId, startTime: startA, delayBetweenSendsMs: 1000, attachments: [attachment] },
  });
  assert(resA.status === 202 && resA.json?.batchId && resA.json?.requestedCount === 4, "schedule response 202 + counts", JSON.stringify(resA.json));
  const batchA = resA.json.batchId;

  console.log("== 6. Schedule batch B (5 recipients, hourlyLimit=2) to force rate-limit deferral (FR-20/21)");
  const resB = await api("/api/emails/schedule", {
    method: "POST", cookie,
    body: { senderId: sender.id, subject: "Batch B rate-limit probe", body: "<p>Batch B body</p>", recipients: ["r1@probe.test", "r2@probe.test", "r3@probe.test", "r4@probe.test", "r5@probe.test"], startTime: new Date(Date.now() + 2000).toISOString(), delayBetweenSendsMs: 1000, hourlyLimit: 2 },
  });
  assert(resB.status === 202 && resB.json?.requestedCount === 5, "batch B accepted", JSON.stringify(resB.json));
  const batchB = resB.json.batchId;

  console.log("== 7. Batch A delivers over real SMTP (FR-12/13)");
  await waitFor("batch A all sent", async () => {
    const c = batchCounts(batchA);
    return c["sent"] === 4;
  }, { timeoutMs: 240_000 });
  const ca = batchCounts(batchA);
  assert(ca["sent"] === 4 && !ca["failed"], "batch A: 4/4 sent, 0 failed", JSON.stringify(ca));

  console.log("== 8. Batch B: 2 sent, 3 deferred to next hour window (FR-20/21)");
  await waitFor("batch B stable (2 sent, 3 deferred)", async () => {
    const c = batchCounts(batchB);
    return c["sent"] === 2 && c["scheduled"] === 3;
  }, { timeoutMs: 90_000 });
  const cb = batchCounts(batchB);
  assert(cb["sent"] === 2 && cb["scheduled"] === 3 && !cb["failed"], "batch B counts", JSON.stringify(cb));
  // Deferral contract (FR-21): deferred rows keep attempts=0, no error, and are
  // pushed past the current hour window. How many OTHER jobs consumed the
  // sender's cap before batch B is environment-dependent — assert the rows
  // that exist, not the number that got through.
  const deferred = psql(`SELECT count(*) FROM email_jobs WHERE batch_id = '${batchB}' AND status = 'scheduled' AND attempts = 0 AND last_error IS NULL AND scheduled_at > now()`);
  assert(parseInt(deferred, 10) >= 1, "deferred rows: no attempts burned, no error, pushed to next window", `rows=${deferred}`);

  console.log("== 9. Query APIs: lists, search, detail, nav-counts (FR-27–29, FR-31–32)");
  const sent = await api("/api/emails/sent?pageSize=100", { cookie });
  assert(sent.status === 200 && sent.json?.items?.filter((i) => i.batchId === batchA)?.length === 4, "sent list shows batch A", `total=${sent.json?.total}`);
  const search = await api(`/api/emails/sent?q=${encodeURIComponent(markerA)}`, { cookie });
  assert(search.status === 200 && search.json?.items?.length === 4, "Elasticsearch search by subject marker", `hits=${search.json?.items?.length}`);
  const searchRecipient = await api("/api/emails/sent?q=alice%2B1%40example.com", { cookie });
  assert(searchRecipient.json?.items?.some((i) => i.batchId === batchA), "search by recipient hits too");
  // 3 deferred rows exist but other scheduled rows may also fill the list.
  const scheduledList = await api("/api/emails/scheduled?pageSize=100", { cookie });
  assert(scheduledList.status === 200 && scheduledList.json?.items?.some((i) => i.batchId === batchB), "scheduled list shows deferred batch B rows");
  const oneSent = sent.json.items.find((i) => i.batchId === batchA);
  const detail = await api(`/api/emails/${oneSent.id}`, { cookie });
  assert(detail.status === 200 && detail.json?.body?.includes("Batch A body"), "detail view returns body (screenshot 4)");
  const nav = await api("/api/emails/nav-counts", { cookie });
  assert(nav.status === 200 && nav.json?.scheduled >= 3 && nav.json?.sent >= 6, "nav-counts badges", JSON.stringify(nav.json));
  const qstats = await api("/api/emails/queue-stats", { cookie });
  assert(qstats.status === 200 && qstats.json?.queue?.completed >= 6, "queue-stats exposes BullMQ counts", JSON.stringify(qstats.json?.queue));

  console.log("== 10. Redis-loss recovery (FR-9/10/11): flush → PG still serves → reconciler re-enqueues");
  redis("FLUSHALL");
  const afterFlush = await api("/api/emails/sent?pageSize=5", { cookie });
  assert(afterFlush.status === 200, "lists still served from Postgres after Redis loss", `status=${afterFlush.status}`);
  const recon = execFileSync("node", ["scripts/reconcile-once.mjs"], { encoding: "utf8", timeout: 120_000 }).trim();
  const reconJson = JSON.parse(recon.split("\n").pop());
  assert(reconJson.reconciled >= 3, "reconciler re-enqueued deferred jobs into fresh Redis", JSON.stringify(reconJson));

  console.log("== 11. Pipeline still healthy post-recovery: batch C sends end-to-end");
  const resC = await api("/api/emails/schedule", {
    method: "POST", cookie,
    body: { senderId: sender.id, subject: "Batch C after recovery", body: "<p>Batch C body</p>", recipients: ["c1@recovery.test", "c2@recovery.test"], startTime: new Date(Date.now() + 1000).toISOString(), delayBetweenSendsMs: 3000 },
  });
  assert(resC.status === 202, "batch C accepted");
  const batchC = resC.json.batchId;
  // Post-recovery the reconciler re-fires every pending job, so a second batch
  // may itself hit the sender's remaining cap and defer — both outcomes are
  // correct; what must never happen is a permanent failure.
  await waitFor("batch C settles (all sent or deferred)", async () => {
    const c = batchCounts(batchC);
    return (c["sent"] ?? 0) + (c["scheduled"] ?? 0) === 2;
  }, { timeoutMs: 180_000 });
  const cc = batchCounts(batchC);
  assert(!cc["failed"] && (cc["sent"] ?? 0) + (cc["scheduled"] ?? 0) === 2, "batch C settles with zero failures after recovery", JSON.stringify(cc));

  console.log("== 12. Logout invalidates the session (FR-3)");
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
