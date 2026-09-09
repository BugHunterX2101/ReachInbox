/**
 * SMTP failure taxonomy (§6.4): only transient failures consume the retry
 * ladder; permanent failures go straight to `failed` via job.discard().
 */

const TRANSIENT_CODES = new Set([421, 450, 451, 452]);
const PERMANENT_CODES = new Set([550, 551, 553, 554]);

export interface ClassifiedFailure {
  transient: boolean;
  code: number | null;
  message: string;
}

/** Extract the numeric SMTP code from a message like "450 busy" or nodemailer errors. */
export function extractSmtpCode(message: string): number | null {
  const m = message.match(/\b([45]\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

export function classifySmtpFailure(err: unknown): ClassifiedFailure {
  const e = err as { responseCode?: number; code?: string; message?: string };
  const message = e?.message ?? String(err);
  const code = typeof e?.responseCode === "number" ? e.responseCode : extractSmtpCode(message);

  // Nodemailer transport-level failures: usually connection problems (transient)
  const transportCode = e?.code ?? "";
  const connectionish =
    ["ECONNECTION", "ECONNRESET", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNTIMEOUT"].some((c) =>
      transportCode.startsWith(c.replace("ECONNECTION", "ECONN"))
    ) ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(
      transportCode
    );

  if (code !== null && PERMANENT_CODES.has(code)) {
    return { transient: false, code, message };
  }
  if (code !== null && TRANSIENT_CODES.has(code)) {
    return { transient: true, code, message };
  }
  if (connectionish) {
    return { transient: true, code, message };
  }
  // Authentication/config errors (535, EAUTH) are permanent — retrying can't fix them.
  if (code !== null && code >= 500) {
    return { transient: false, code, message };
  }
  if (transportCode === "EAUTH" || transportCode === "EAUTHFAILED") {
    return { transient: false, code, message };
  }
  // Default: treat unknown as transient so the ladder is exhausted before failing.
  return { transient: true, code, message };
}
