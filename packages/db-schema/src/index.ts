import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(databaseUrl?: string): Pool {
  if (!pool) {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export type EmailStatus = "scheduled" | "processing" | "sent" | "failed";

export interface DbEmailJob {
  id: string;
  batch_id: string;
  tenant_id: string;
  sender_id: string;
  recipient: string;
  status: EmailStatus;
  bullmq_job_id: string;
  attempts: number;
  last_error: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  scheduled_at: Date;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbSender {
  id: string;
  tenant_id: string;
  name: string;
  from_address: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass_encrypted: string;
  max_emails_per_hour: number;
}

export { encryptSecret, decryptSecret } from "./crypto.js";
export { computeJobId } from "./jobId.js";
