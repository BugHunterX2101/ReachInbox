import { getPool } from "@reachinbox/db-schema";
import type { GoogleProfile } from "./googleOauth.js";

export interface AuthedUser {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

/**
 * Upsert the user on Google login. A tenant is created automatically on first
 * login — one tenant per first-login user this phase (design §4.2 assumption;
 * multi-tenant onboarding is a PRD non-goal).
 */
export async function upsertUserFromGoogle(profile: GoogleProfile): Promise<AuthedUser> {
  const pool = getPool();

  const existing = await pool.query<AuthedUserRow>(
    `SELECT id, tenant_id, name, email, avatar_url FROM users WHERE google_id = $1`,
    [profile.googleId]
  );
  if (existing.rows.length > 0) {
    const u = existing.rows[0];
    // Refresh name/avatar on every login so the header stays current.
    await pool.query(`UPDATE users SET name = $1, avatar_url = $2 WHERE id = $3`, [
      profile.name,
      profile.avatarUrl,
      u.id,
    ]);
    return { id: u.id, tenantId: u.tenant_id, name: profile.name, email: u.email, avatarUrl: profile.avatarUrl };
  }

  // First login — create tenant + user atomically.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, max_emails_per_hour) VALUES ($1, $2) RETURNING id`,
      [`${profile.name}'s Workspace`, parseInt(process.env.MAX_EMAILS_PER_HOUR ?? "500", 10)]
    );
    const user = await client.query<{ id: string; tenant_id: string }>(
      `INSERT INTO users (tenant_id, google_id, name, email, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id`,
      [tenant.rows[0].id, profile.googleId, profile.name, profile.email, profile.avatarUrl]
    );
    await client.query("COMMIT");
    return {
      id: user.rows[0].id,
      tenantId: user.rows[0].tenant_id,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface AuthedUserRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  avatar_url: string | null;
}
