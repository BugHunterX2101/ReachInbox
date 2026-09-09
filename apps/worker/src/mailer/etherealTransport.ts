import nodemailer, { type Transporter } from "nodemailer";
import { decryptSecret, type DbSender } from "@reachinbox/db-schema";

/**
 * Mail transport interface (FR-13 + Maintainability NFR): worker logic depends
 * on this interface only, so swapping Ethereal → SES/SendGrid touches this
 * module, not the worker.
 */
export interface MailTransport {
  send(params: {
    from: string;
    to: string;
    subject: string;
    html: string;
    attachments?: Array<{ filename: string; path: string; contentType?: string }>;
  }): Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;
  close(): void;
}

export function createEtherealTransport(sender: DbSender): MailTransport {
  const transporter: Transporter = nodemailer.createTransport({
    host: sender.smtp_host,
    port: sender.smtp_port,
    secure: sender.smtp_port === 465,
    auth: {
      user: sender.smtp_user,
      pass: decryptSecret(sender.smtp_pass_encrypted),
    },
  });

  return {
    async send(params) {
      const info = await transporter.sendMail({
        from: `"${sender.name}" <${sender.from_address}>`,
        to: params.to,
        subject: params.subject,
        html: params.html,
        attachments: params.attachments,
      });
      return {
        messageId: info.messageId,
        accepted: (info.accepted ?? []).map((a: string | { address: string }) =>
          typeof a === "string" ? a : a.address
        ),
        rejected: (info.rejected ?? []).map((a: string | { address: string }) =>
          typeof a === "string" ? a : a.address
        ),
      };
    },
    close() {
      transporter.close();
    },
  };
}

export { nodemailer };
