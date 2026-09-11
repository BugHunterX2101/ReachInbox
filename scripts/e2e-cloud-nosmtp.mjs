/**
 * Cloud E2E minus SMTP delivery — verifies every surface of the DEPLOYED API
 * that does not depend on reaching an SMTP server: session auth against Neon
 * sessions, CSV/attachment upload, async scheduling, queue processing,
 * PG-fallback read paths, Slack graceful path, Bull Board gate, logout.
 *
 * Use this when the SMTP path is degraded by an upstream/provider outage —
 * as of 2026-09-11, Render free instances cannot reach any Ethereal port
 * (25/465/587 platform-blocked; 2525 accepts TCP but never banners) even
 * though the same harness delivered real mail on 2026-09-09.
 *
 * Usage: E2E_CLOUD_API=… DATABASE_URL=… SESSION_SECRET=… node scripts/e2e-cloud-nosmtp.mjs
 */
import {
  API, assert, summary, api, createSession,
} from "./lib/cloudHarness.mjs";

async function main() {
  console.log(`== 0. Deployed API is awake: ${API}`);
  const health = await api("/api/health");
  assert(health.status === 200 && health.json?.ok === true, "/api/health ok", JSON.stringify(health.json?.googleRedirectUris ?? health.json));

  console.log("== 1. Session bootstrap + auth gate (Neon sessions)");
  const { cookie } = await createSession();
  const me = await api("/api/me", { cookie });
  assert(me.status === 200 && me.json?.email === "e2e-cloud@local.test", "authenticated /api/me (Neon session)", `status=${me.status}`);
  assert((await api("/api/me")).status === 401, "unauthenticated rejected");

  console.log("== 2. Senders, gates, Slack graceful path");
  const senders = await api("/api/emails/senders", { cookie });
  assert(senders.status === 200 && senders.json?.items?.length >= 2, "sender dropdown (FR-14)", `${senders.json?.items?.length} senders`);
  assert((await api("/admin/queues")).status === 401, "Bull Board gated (FR-26)");
  const slack = await api("/api/integrations/slack", { cookie });
  assert(slack.status === 200 && slack.json?.connected === false, "Slack unconfigured graceful (FR-22–25)");

  console.log("== 3. Uploads (CSV parse + signed attachment)");
  const upForm = new FormData();
  upForm.append("file", new Blob(["a@example.com\nbad-at-example.com\nb@example.com"], { type: "text/csv" }), "r.csv");
  const up = await api("/api/emails/upload-recipients", { method: "POST", cookie, form: upForm });
  assert(up.status === 201 && up.json?.validCount === 2, "CSV upload parse (FR-30)", JSON.stringify({ v: up.json?.validCount, i: up.json?.invalidCount }));
  const attForm = new FormData();
  attForm.append("file", new Blob(["attachment " + Date.now()]), "a.txt");
  const att = await api("/api/attachments", { method: "POST", cookie, form: attForm });
  assert(att.status === 201 && att.json?.storageUrl, "attachment upload (signed URL)");

  console.log("== 4. Schedule accepted 202 async (FR-4–6)");
  const sender = senders.json.items[0];
  const res = await api("/api/emails/schedule", {
    method: "POST", cookie,
    body: { senderId: sender.id, subject: "outage-probe " + Date.now(), body: "<p>probe</p>", recipients: ["p1@probe.test", "p2@probe.test"], startTime: new Date(Date.now() + 1000).toISOString(), delayBetweenSendsMs: 1000 },
  });
  assert(res.status === 202 && res.json?.requestedCount === 2, "schedule accepted 202 async (FR-4–6)");

  console.log("== 5. Read paths (PG fallback), badges, queue stats");
  await new Promise((r) => setTimeout(r, 20000)); // let the worker take the jobs (SMTP may fail during an outage — that's the point)
  const sent = await api("/api/emails/sent?pageSize=50", { cookie });
  assert(sent.status === 200 && Array.isArray(sent.json?.items), "sent list (PG fallback read path)", `total=${sent.json?.total}`);
  const sched = await api("/api/emails/scheduled?pageSize=50", { cookie });
  assert(sched.status === 200 && sched.json?.items?.length >= 1, "scheduled list shows deferred rows", `items=${sched.json?.items?.length}`);
  const nav = await api("/api/emails/nav-counts", { cookie });
  assert(nav.status === 200 && typeof nav.json?.sent === "number", "nav-counts (FR-31/32)", JSON.stringify(nav.json));
  const qs = await api("/api/emails/queue-stats", { cookie });
  assert(qs.status === 200 && qs.json?.queue, "queue-stats BullMQ counts", JSON.stringify(qs.json?.queue));
  const one = (sent.json?.items ?? [])[0] ?? (sched.json?.items ?? [])[0];
  if (one) {
    const d = await api(`/api/emails/${one.id}`, { cookie });
    assert(d.status === 200 && d.json?.body, "detail view returns body");
  }

  console.log("== 6. Logout invalidates the session (FR-3)");
  const out = await api("/api/auth/logout", { cookie });
  assert((out.status === 302 || out.status === 200) && (await api("/api/me", { cookie })).status === 401, "logout invalidates session (FR-3)");

  summary("PARTIAL CLOUD E2E");
}

main().catch((err) => {
  assert(false, "harness crashed", String(err?.stack ?? err).split("\n")[0]);
  console.error(err);
  summary("PARTIAL CLOUD E2E");
});
