#!/usr/bin/env node
/**
 * Minimal SMTP reachability probe — speaks raw SMTP by hand so the result is
 * unambiguous and doesn't depend on Nodemailer or any workspace package.
 *
 * Reads the Ethereal senders directly from the same Neon DB the deployed API
 * reads from, then probes each Ethereal port down to the AUTH LOGIN exchange.
 *
 * Usage: DATABASE_URL=… ENCRYPTION_KEY=… node scripts/smtp-probe.mjs
 */
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __require = createRequire(import.meta.url);
const Pool = __require("pg").Pool;
const nodeCrypto = await import("node:crypto");

async function decryptPass(value) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 64 hex chars");
  const raw = Buffer.from(value, "base64");
  const tag = raw.subarray(16, 32);
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(32);
  const dc = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  dc.setAuthTag(tag);
  return Buffer.concat([dc.update(ct), dc.final()]).toString("utf8");
}

async function probe({ host, port, user, pass, label }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let dispose = () => {};
    const s = net.createConnection({ port, host });
    s.on("connect", () => {
      const banner = s.read(4096)?.toString().trim() ?? "(no data)";
      if (!banner.startsWith("220")) {
        dispose();
        return reject(new Error(`[${label} ${host}:${port}] no 220 banner: ${banner}`));
      }
      console.log(`[${label} ${host}:${port}] banner ${Date.now() - t0}ms: ${banner.slice(0, 90)}`);

      s.write("EHLO probe.local\r\n");
      const ehlo = s.read(4096)?.toString().trim() ?? "(no data)";
      console.log(`[${label} ${host}:${port}] EHLO: ${ehlo.slice(0, 90)}`);

      if (port !== 465) {
        s.write("STARTTLS\r\n");
        const st = s.read(4096)?.toString().trim() ?? "(no data)";
        console.log(`[${label} ${host}:${port}] STARTTLS: ${st}`);
        if (st.startsWith("220")) {
          console.log(`[${label} ${host}:${port}] STARTTLS offered — TLS handshake would follow (we stop here)`);
          dispose();
          return resolve();
        }
      }

      s.write("AUTH LOGIN\r\n");
      const challenge = s.read(4096)?.toString().trim() ?? "(no data)";
      console.log(`[${label} ${host}:${port}] AUTH LOGIN challenge: ${challenge}`);

      const uenc = Buffer.from(`\0${user}`).toString("base64");
      s.write(`${uenc}\r\n`);
      const userResp = s.read(4096)?.toString().trim() ?? "(no data)";
      console.log(`[${label} ${host}:${port}] after user: ${userResp}`);

      const penc = Buffer.from(`\0${pass}`).toString("base64");
      s.write(`${penc}\r\n`);
      const passResp = s.read(4096)?.toString().trim() ?? "(no data)";
      console.log(`[${label} ${host}:${port}] after pass: ${passResp}`);

      s.write("QUIT\r\n");
      s.end();
      dispose = () => { try { s.destroy(); } catch {} };
      return resolve();
    });

    s.on("error", (err) => {
      if (dispose) dispose();
      reject(new Error(`[${label} ${host}:${port}] after ${Date.now() - t0}ms: ${err.message}`));
    });

    s.on("timeout", () => {
      if (dispose) dispose();
      reject(new Error(`[${label} ${host}:${port}] TIMEOUT after 9000ms`));
    });

    s.setTimeout(9000);
  });
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error("DATABASE_URL required");

  const c = new Pool({ connectionString: dsn });
  await c.connect();
  const rows = await c.query("SELECT from_address, smtp_user, smtp_pass_encrypted, smtp_host, smtp_port FROM senders WHERE smtp_host = 'smtp.ethereal.email'");
  await c.end();

  if (rows.rows.length === 0) {
    console.log("no Ethereal senders in this DB");
    return;
  }

  for (const r of rows.rows) {
    const pass = await decryptPass(r.smtp_pass_encrypted);
    const label = `probe ${r.from_address}`;
    console.log(`\n=== ${label} ===`);
    for (const port of [587, 2525, 465]) {
      await probe({ host: r.smtp_host, port, user: r.smtp_user, pass, label });
    }
  }
}

main().catch((err) => {
  console.error("probe crashed:", err?.stack?.split("\n")[0] ?? err);
  process.exitCode = 1;
});
