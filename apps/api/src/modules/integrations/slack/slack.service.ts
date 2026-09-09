import { getPool, encryptSecret } from "@reachinbox/db-schema";
import { getConfig } from "@reachinbox/config";
import { ApiError } from "../../../middleware/errorHandler.js";

/**
 * Slack OAuth v2 (FR-22). Scopes limited to exactly what one notification
 * needs — chat:write (§10). The user token is AES-GCM encrypted at rest (§11).
 */
const SLACK_SCOPES = "chat:write";

export function isSlackConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.SLACK_CLIENT_ID && cfg.SLACK_CLIENT_SECRET);
}

export function buildSlackAuthorizeUrl(state: string, redirectUri: string): string {
  const cfg = getConfig();
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", cfg.SLACK_CLIENT_ID);
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface SlackTokenResponse {
  ok: boolean;
  access_token?: string;
  team?: { id?: string; name?: string };
  authed_user?: { id?: string };
  error?: string;
}

/** Exchange the OAuth code for a bot token (FR-22) — exact redirect_uri round-trip. */
export async function exchangeSlackCode(code: string, redirectUri: string): Promise<SlackTokenResponse> {
  const cfg = getConfig();
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.SLACK_CLIENT_ID,
      client_secret: cfg.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await resp.json()) as SlackTokenResponse;
  return data;
}

/** Upsert the integration row; absence of a row means "not connected" (FR-24). */
export async function storeSlackIntegration(
  tenantId: string,
  connectedBy: string,
  token: SlackTokenResponse
): Promise<void> {
  if (!token.ok || !token.access_token) {
    throw new ApiError("VALIDATION_ERROR", token.error ?? "Slack authorization failed");
  }
  const pool = getPool();
  await pool.query(
    `INSERT INTO slack_integrations (tenant_id, access_token_encrypted, connected_by, connected_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET access_token_encrypted = $2, connected_by = $3, connected_at = now()`,
    [tenantId, encryptSecret(token.access_token), connectedBy]
  );
}

export interface SlackStatus {
  connected: boolean;
  connectedAt: string | null;
  teamName: string | null;
}

export async function getSlackStatus(tenantId: string): Promise<SlackStatus> {
  const pool = getPool();
  const result = await pool.query<{ connected_at: Date }>(
    `SELECT connected_at FROM slack_integrations WHERE tenant_id = $1`,
    [tenantId]
  );
  return {
    connected: result.rows.length > 0,
    connectedAt: result.rows[0]?.connected_at
      ? new Date(result.rows[0].connected_at).toISOString()
      : null,
    teamName: null,
  };
}

export async function disconnectSlack(tenantId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM slack_integrations WHERE tenant_id = $1`, [tenantId]);
}
