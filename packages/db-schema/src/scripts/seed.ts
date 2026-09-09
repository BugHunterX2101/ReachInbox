import crypto from "node:crypto";
import { getPool, closePool, encryptSecret } from "../index.js";
import { loadRootEnv } from "../loadRootEnv.js";

loadRootEnv();

/**
 * Seeds the default tenant (FR-14 — multiple configured senders come from
 * `seed:ethereal`, which provisions REAL Ethereal accounts). Deterministic
 * placeholder senders (fake creds, for fully-offline dev) are opt-in via
 * SEED_PLACEHOLDER_SENDERS=1 so deployments never accumulate rows that
 * would fail SMTP auth.
 */
async function main(): Promise<void> {
  const pool = getPool();

  const tenantResult = await pool.query<{ id: string }>(
    `SELECT id FROM tenants ORDER BY created_at LIMIT 1`
  );
  let tenantId: string;
  if (tenantResult.rows.length > 0) {
    tenantId = tenantResult.rows[0].id;
  } else {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, max_emails_per_hour) VALUES ($1, $2) RETURNING id`,
      ["ReachInbox Default", parseInt(process.env.MAX_EMAILS_PER_HOUR ?? "500", 10)]
    );
    tenantId = inserted.rows[0].id;
  }

  const seedSenders = [
    {
      name: process.env.SEED_SENDER_1_NAME ?? "Sender One",
      email: (process.env.SEED_SENDER_1_EMAIL ?? "sender.one@ethereal.email").toLowerCase(),
      pass: process.env.SEED_SENDER_1_PASSWORD ?? "seed-one-password",
    },
    {
      name: process.env.SEED_SENDER_2_NAME ?? "Sender Two",
      email: (process.env.SEED_SENDER_2_EMAIL ?? "sender.two@ethereal.email").toLowerCase(),
      pass: process.env.SEED_SENDER_2_PASSWORD ?? "seed-two-password",
    },
  ];

  if (process.env.SEED_PLACEHOLDER_SENDERS === "1") {
    for (const s of seedSenders) {
      await pool.query(
        `INSERT INTO senders (tenant_id, name, from_address, smtp_host, smtp_port, smtp_user, smtp_pass_encrypted, max_emails_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, from_address) DO NOTHING`,
        [
          tenantId,
          s.name,
          s.email,
          process.env.SEED_SMTP_HOST ?? "smtp.ethereal.email",
          587,
          s.email,
          encryptSecret(s.pass),
          parseInt(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER ?? "100", 10),
        ]
      );
    }
  }

  const count = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM senders`);
  console.log(`[seed] tenant ready, senders: ${count.rows[0].c}` + (process.env.SEED_PLACEHOLDER_SENDERS === "1" ? "" : " (placeholders off — run db:seed:ethereal for real senders)"));
  await closePool();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
