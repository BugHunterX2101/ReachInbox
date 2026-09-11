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
 * Env:   E2E_CLOUD_API, DATABASE_URL (Neon external), SESSION_SECRET (deployed)
 */
import {
  API, assert, summary, api, waitFor, createSession, batchCounts, psql,
} from "./lib/cloudHarness.mjs";

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
  // Deferral contract (FR-21): deferred rows keep attempts=0, no error, and are
  // pushed past the current hour window. How many OTHER jobs consumed the
  // sender's cap before batch B is environment-dependent — assert the rows
  // that exist, not the number that got through.
  const deferred = psql(`SELECT count(*) FROM email_jobs WHERE batch_id = '${batchB}' AND status = 'scheduled' AND attempts = 0 AND last_error IS NULL AND scheduled_at > now()`);
  assert(parseInt(deferred, 10) >= 1, "deferred rows: no attempts burned, no error, pushed to next window", `rows=${deferred}`);

  console.log("== 9. Query APIs over the PG-fallback read path (FR-27–29, FR-31–32)");
  const sent = await api("/api/emails/sent?pageSize=100", { cookie });
  assert(sent.status === 200 && sent.json?.items?.filter((i) => i.batchId === batchA)?.length === 4, "sent list shows batch A", `total=${sent.json?.total}`);
  const search = await api(`/api/emails/sent?q=${encodeURIComponent(marker)}`, { cookie });
  assert(search.status === 200 && search.json?.items?.length === 4, "search by subject marker (PG fallback)", `hits=${search.json?.items?.length}`);
  // 3 deferred rows exist but other scheduled rows may also fill the list.
  const scheduledList = await api("/api/emails/scheduled?pageSize=100", { cookie });
  assert(scheduledList.status === 200 && scheduledList.json?.items?.some((i) => i.batchId === batchB), "scheduled list shows deferred batch B rows");
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
  assert(false, "harness crashed", String(err?.stack ?? err).split("\n")[0]);
  console.error(err);
  summary();
});
