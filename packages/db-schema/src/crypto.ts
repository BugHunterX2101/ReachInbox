import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (SMTP passwords, Slack tokens).
 * Key: ENCRYPTION_KEY env (64 hex chars = 32 bytes). Never stored in the DB.
 * Output format: iv(16B) | tag(16B) | ciphertext, base64.
 */
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
