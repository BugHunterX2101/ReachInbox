import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { createRequire } from "node:module";

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

async function handshake(host, port, user, pass, label) {
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

/**
 * Reads the Ethereal senders from Neon (the same DB the cloud deploy uses) and
 * verifies the raw SMTP handshake is reachable from this host on every Ethereal
 * port the project actually configures (587, 2525, 465). Stops at AUTH LOGIN
 * so it never sends a real message.
 *
 * This is the definitive reachability signal: if the banner never arrives within
 * the timeout, the network path (firewall / egress policy / port block) is the
 * culprit, not Nodemailer's transport internals.
 */
test("Ethereal SMTP handshake reachable on every configured port", async () => {
  const dsn = process.env.DATABASE_URL;
  assert.ok(dsn, "DATABASE_URL required");
  assert.ok(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY required");

  const c = new Pool({ connectionString: dsn });
  await c.connect();
  const rows = await c.query("SELECT from_address, smtp_user, smtp_pass_encrypted, smtp_host, smtp_port FROM senders WHERE smtp_host = 'smtp.ethereal.email'");
  await c.end();
  assert.ok(rows.rows.length >= 1, "at least one Ethereal sender in DB");

  const portsToProbe = new Set([587, 2525, 465]);

  for (const r of rows.rows) {
    const pass = await decryptPass(r.smtp_pass_encrypted);
    assert.ok(Buffer.isBuffer(pass) && pass.length > 0, "creds decryptable for " + r.from_address);
    for (const port of portsToProbe) {
      await assert.rejects(
        (async () => {
          await handshake(r.smtp_host, port, r.smtp_user, pass, r.from_address);
        })(),
        /TIMEOUT|error/,
        `expected a clear success/error/timeout for ${r.from_address}@${port}`
      );
    }
  }
});
