import { getPool } from "@reachinbox/db-schema";
import type { EmailListResponse, EmailListItem, EmailStatus } from "@reachinbox/shared-types";
import {
  searchEmailJobs,
  getEmailJobDoc,
  type EsHit,
} from "@reachinbox/search";

type SortOrder = "asc" | "desc";

export interface ListParams {
  tenantId: string;
  statuses: string[];
  q?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
  sortOrder: SortOrder;
}

function toListItem(hit: EsHit, body?: string): EmailListItem {
  return {
    id: hit.id,
    batchId: hit.batchId,
    recipient: hit.recipient,
    senderEmail: hit.senderEmail,
    subject: hit.subject,
    status: hit.status as EmailStatus,
    scheduledAt: hit.scheduledAt,
    sentAt: hit.sentAt,
    error: hit.error,
    attempts: hit.attempts,
    body,
  };
}

/**
 * ES-first list (FR-27, FR-28). On any ES error the query falls back to
 * Postgres (§7.3) — the dashboard degrades, never breaks.
 */
export async function listEmails(p: ListParams): Promise<EmailListResponse> {
  try {
    const esResult = await searchEmailJobs({
      tenantId: p.tenantId,
      status: p.statuses,
      q: p.q,
      from: p.from,
      to: p.to,
      page: p.page,
      pageSize: p.pageSize,
      sortField: "scheduledAt",
      sortOrder: p.sortOrder,
    });
    return {
      items: esResult.items.map((h) => toListItem(h)),
      page: p.page,
      pageSize: p.pageSize,
      total: esResult.total,
    };
  } catch (esErr) {
    console.warn("[query] ES unavailable, falling back to Postgres:", (esErr as Error).message);
    return listEmailsFromPostgres(p);
  }
}

async function listEmailsFromPostgres(p: ListParams): Promise<EmailListResponse> {
  const pool = getPool();
  const conditions: string[] = [`ej.tenant_id = $1`, `ej.status = ANY($2)`];
  const params: unknown[] = [p.tenantId, p.statuses];
  let idx = 3;

  if (p.q) {
    conditions.push(`(ej.recipient ILIKE $${idx} OR b.subject ILIKE $${idx})`);
    params.push(`%${p.q}%`);
    idx++;
  }
  if (p.from) {
    conditions.push(`ej.scheduled_at >= $${idx}`);
    params.push(p.from);
    idx++;
  }
  if (p.to) {
    conditions.push(`ej.scheduled_at <= $${idx}`);
    params.push(p.to);
    idx++;
  }

  const where = conditions.join(" AND ");
  const offset = (p.page - 1) * p.pageSize;
  const order = p.sortOrder === "asc" ? "ASC" : "DESC";

  const countQ = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM email_jobs ej JOIN batches b ON b.id = ej.batch_id
     WHERE ${where}`,
    params
  );

  const rows = await pool.query(
    `SELECT ej.id, ej.batch_id, ej.recipient, s.from_address AS sender_email,
            b.subject, ej.status, ej.scheduled_at, ej.sent_at, ej.last_error, ej.attempts
     FROM email_jobs ej
     JOIN batches b ON b.id = ej.batch_id
     JOIN senders s ON s.id = ej.sender_id
     WHERE ${where}
     ORDER BY ej.scheduled_at ${order}
     LIMIT ${p.pageSize} OFFSET ${offset}`,
    params
  );

  return {
    items: rows.rows.map((r) => ({
      id: r["id"] as string,
      batchId: r["batch_id"] as string,
      recipient: r["recipient"] as string,
      senderEmail: r["sender_email"] as string,
      subject: r["subject"] as string,
      status: r["status"] as EmailStatus,
      scheduledAt: new Date(r["scheduled_at"]).toISOString(),
      sentAt: r["sent_at"] ? new Date(r["sent_at"]).toISOString() : null,
      error: (r["last_error"] as string | null) ?? null,
      attempts: Number(r["attempts"] ?? 0),
    })),
    page: p.page,
    pageSize: p.pageSize,
    total: parseInt(countQ.rows[0]?.count ?? "0", 10),
  };
}

/** Detail: ES first, Postgres fallback. Includes body for the read view. */
export async function getEmailDetail(tenantId: string, id: string): Promise<EmailListItem | null> {
  const fallback = async (): Promise<EmailListItem | null> => {
    const pool = getPool();
    const rows = await pool.query(
      `SELECT ej.id, ej.batch_id, ej.recipient, s.from_address AS sender_email,
              b.subject, b.body, ej.status, ej.scheduled_at, ej.sent_at, ej.last_error, ej.attempts
       FROM email_jobs ej
       JOIN batches b ON b.id = ej.batch_id
       JOIN senders s ON s.id = ej.sender_id
       WHERE ej.id = $1 AND ej.tenant_id = $2`,
      [id, tenantId]
    );
    if (rows.rows.length === 0) return null;
    const r = rows.rows[0];
    return {
      id: r["id"] as string,
      batchId: r["batch_id"] as string,
      recipient: r["recipient"] as string,
      senderEmail: r["sender_email"] as string,
      subject: r["subject"] as string,
      body: r["body"] as string,
      status: r["status"] as EmailStatus,
      scheduledAt: new Date(r["scheduled_at"]).toISOString(),
      sentAt: r["sent_at"] ? new Date(r["sent_at"]).toISOString() : null,
      error: (r["last_error"] as string | null) ?? null,
      attempts: Number(r["attempts"] ?? 0),
    };
  };

  try {
    const doc = await getEmailJobDoc(id);
    if (doc && doc.tenantId === tenantId) {
      // ES doc has no body — fetch it from Postgres for the read view.
      const pg = await fallback();
      if (!pg) return toListItem(doc);
      return { ...pg, ...doc, status: pg.status, body: pg.body };
    }
  } catch {
    // fall through to Postgres
  }
  return fallback();
}
