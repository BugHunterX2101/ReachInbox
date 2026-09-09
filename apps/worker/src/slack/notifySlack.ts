import { getPool, decryptSecret } from "@reachinbox/db-schema";
import { getConfig } from "@reachinbox/config";

/**
 * Rate-limit breach notification (FR-23, FR-24, FR-25):
 *  - Token is read at CALL TIME, not process start — connecting Slack
 *    mid-session starts working immediately, no redeploy (FR-25).
 *  - No row for the tenant → return immediately, no error, no log noise (FR-24).
 *  - Any failure is logged at warn and swallowed — never thrown into the send
 *    path (FR-24, PRD risk: "Slack API downtime… failures never block").
 */
export async function notifySlack(tenantId: string, message: string): Promise<void> {
  try {
    const pool = getPool();
    const result = await pool.query<{ access_token_encrypted: string | null; webhook_url: string | null }>(
      `SELECT access_token_encrypted, webhook_url FROM slack_integrations WHERE tenant_id = $1`,
      [tenantId]
    );
    const row = result.rows[0];
    if (!row || (!row.access_token_encrypted && !row.webhook_url)) {
      return; // not connected — skip silently (FR-24)
    }

    if (row.webhook_url) {
      await fetch(row.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      return;
    }

    const token = decryptSecret(row.access_token_encrypted!);
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: "general",
        text: message,
      }),
    });
  } catch (err) {
    // Revoked token, Slack downtime — logged, never thrown (FR-24).
    console.warn("[slack] notification failed (swallowed):", (err as Error).message);
  }
}

export function rateLimitBreachMessage(params: {
  senderEmail: string;
  senderCount: number;
  senderCap: number;
  tenantCount: number;
  tenantCap: number;
  nextWindowStart: Date;
}): string {
  const { senderEmail, senderCount, senderCap, tenantCount, tenantCap, nextWindowStart } = params;
  const cfg = getConfig();
  return [
    ":hourglass_flowing_sand: *ReachInbox rate limit hit*",
    `Sender \`${senderEmail}\` hit its hourly cap (${senderCount}/${senderCap}); tenant usage ${tenantCount}/${tenantCap}.`,
    `Affected emails are being deferred to the next hour window (${nextWindowStart.toISOString().slice(0, 13)}:00 UTC) — nothing is dropped.`,
    `_env defaults: MAX_EMAILS_PER_HOUR=${cfg.MAX_EMAILS_PER_HOUR}, MAX_EMAILS_PER_HOUR_PER_SENDER=${cfg.MAX_EMAILS_PER_HOUR_PER_SENDER}_`,
  ].join("\n");
}
