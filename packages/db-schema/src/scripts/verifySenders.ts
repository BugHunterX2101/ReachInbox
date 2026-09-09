import nodemailer from "nodemailer";
import { getPool, closePool, decryptSecret } from "../index.js";
import { loadRootEnv } from "../loadRootEnv.js";

loadRootEnv();

/**
 * Verifies every configured sender by performing a REAL SMTP handshake +
 * AUTH against its server (FR-13/FR-14). Exits 1 if any sender fails.
 */
async function main(): Promise<void> {
  const pool = getPool();
  const res = await pool.query<{
    name: string;
    from_address: string;
    smtp_host: string;
    smtp_port: number;
    smtp_user: string;
    smtp_pass_encrypted: string;
  }>(`SELECT name, from_address, smtp_host, smtp_port, smtp_user, smtp_pass_encrypted FROM senders ORDER BY from_address`);

  let failures = 0;
  for (const s of res.rows) {
    const transport = nodemailer.createTransport({
      host: s.smtp_host,
      port: s.smtp_port,
      secure: false,
      auth: { user: s.smtp_user, pass: decryptSecret(s.smtp_pass_encrypted) },
    });
    try {
      await transport.verify();
      console.log(`[verify] OK    ${s.name} <${s.from_address}> -> ${s.smtp_host}:${s.smtp_port}`);
    } catch (err) {
      failures++;
      console.error(`[verify] FAIL  ${s.name} <${s.from_address}>: ${(err as Error).message}`);
    }
  }
  await closePool();
  if (failures > 0) process.exit(1);
  console.log(`[verify] all ${res.rows.length} sender(s) verified`);
}

main().catch((err) => {
  console.error("[verify] failed:", err);
  void closePool().finally(() => process.exit(1));
});
