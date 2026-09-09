import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { getPool, closePool, encryptSecret } from "../index.js";
import { loadRootEnv } from "../loadRootEnv.js";

loadRootEnv();

/**
 * Provisions REAL Ethereal test accounts via Nodemailer's official account
 * API (api.nodemailer.com) and upserts them as senders (FR-13, FR-14).
 * Ethereal mail never reaches the public internet, but the SMTP handshake,
 * auth, and message acceptance are genuine — every message is viewable at
 * https://ethereal.email/login with the returned credentials.
 * Credentials are cached at the repo root so re-runs reuse them.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE_FILE = path.join(ROOT, ".ethereal-accounts.json");

interface CachedAccount {
  user: string;
  pass: string;
  name: string;
}

function readLegacyCache(): CachedAccount[] {
  const candidates = [CACHE_FILE, path.join(ROOT, "packages", ".ethereal-accounts.json")];
  for (const f of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as CachedAccount[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* missing or unreadable — try next */
    }
  }
  return [];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function createDistinctAccount(existing: Set<string>): Promise<CachedAccount> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const acc = await withTimeout(nodemailer.createTestAccount(), 30_000, "createTestAccount");
      if (!existing.has(acc.user)) {
        console.log(`[seed-ethereal] created account: ${acc.user}`);
        return { user: acc.user, pass: acc.pass, name: "" };
      }
      console.log(`[seed-ethereal] duplicate account returned, retrying (${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.error(`[seed-ethereal] attempt ${attempt}/${MAX_ATTEMPTS} failed:`, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("could not provision a distinct Ethereal account after 5 attempts");
}

async function getAccounts(count: number): Promise<CachedAccount[]> {
  // Dedupe by user — earlier runs could cache the same account twice.
  const seen = new Set<string>();
  const accounts: CachedAccount[] = [];
  for (const a of readLegacyCache()) {
    if (a.user && a.pass && !seen.has(a.user)) {
      seen.add(a.user);
      accounts.push(a);
    }
  }
  while (accounts.length < count) {
    const acc = await createDistinctAccount(seen);
    seen.add(acc.user);
    acc.name = `Ethereal Sender ${accounts.length + 1}`;
    accounts.push(acc);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(accounts, null, 2));
  }
  // Normalize names so cached entries pick up stable numbering.
  accounts.forEach((a, i) => (a.name = `Ethereal Sender ${i + 1}`));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(accounts, null, 2));
  return accounts.slice(0, count);
}

async function main(): Promise<void> {
  const pool = getPool();
  const tenant = await pool.query<{ id: string }>(
    `SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  );
  if (tenant.rows.length === 0) {
    throw new Error("no tenant found — run the regular seed first");
  }
  const tenantId = tenant.rows[0].id;

  // Deployments run this on every boot: if the tenant already has real
  // Ethereal senders, keep them and skip provisioning entirely.
  const existing = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM senders
     WHERE tenant_id = $1 AND smtp_host = 'smtp.ethereal.email'
       AND from_address NOT IN ('sender.one@ethereal.email', 'sender.two@ethereal.email')`,
    [tenantId],
  );
  if (parseInt(existing.rows[0]?.c ?? "0", 10) >= 2) {
    console.log(`[seed-ethereal] ${existing.rows[0].c} real Ethereal sender(s) already configured — nothing to do`);
    await closePool();
    return;
  }

  const accounts = await getAccounts(2);
  for (const acc of accounts) {
    await pool.query(
      `INSERT INTO senders (tenant_id, name, from_address, smtp_host, smtp_port, smtp_user, smtp_pass_encrypted, max_emails_per_hour)
       VALUES ($1, $2, $3, 'smtp.ethereal.email', 587, $4, $5, $6)
       ON CONFLICT (tenant_id, from_address) DO UPDATE
         SET smtp_user = $4, smtp_pass_encrypted = $5, name = $2`,
      [tenantId, acc.name, acc.user, acc.user, encryptSecret(acc.pass), 100],
    );
  }

  const count = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM senders`);
  console.log(`[seed-ethereal] done — ${count.rows[0].c} sender(s) configured with real Ethereal credentials`);
  await closePool();
}

main().catch((err) => {
  console.error("[seed-ethereal] failed:", err);
  process.exitCode = 1;
  void closePool().finally(() => process.exit(1));
});
