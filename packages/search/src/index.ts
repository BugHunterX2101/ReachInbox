import { Client } from "@elastic/elasticsearch";

export const EMAIL_JOBS_INDEX = "email_jobs";

let client: Client | null = null;

function getClient(): Client {
  if (!client) {
    const url = process.env.ELASTICSEARCH_URL;
    if (!url) throw new Error("ELASTICSEARCH_URL is not set");
    client = new Client({ node: url });
  }
  return client;
}

/** §7.1 index mapping — recipient/subject analyzed, ids/status keywords, dates. */
const INDEX_MAPPING = {
  properties: {
    id: { type: "keyword" },
    batchId: { type: "keyword" },
    tenantId: { type: "keyword" },
    senderId: { type: "keyword" },
    senderEmail: { type: "keyword" },
    recipient: { type: "text", fields: { raw: { type: "keyword" } } },
    subject: { type: "text" },
    status: { type: "keyword" },
    scheduledAt: { type: "date" },
    sentAt: { type: "date" },
    createdAt: { type: "date" },
    error: { type: "text" },
    attempts: { type: "integer" },
  },
} as const;

export async function ensureEmailJobsIndex(): Promise<boolean> {
  const es = getClient();
  const exists = await es.indices.exists({ index: EMAIL_JOBS_INDEX });
  if (exists) return false;
  await es.indices.create({
    index: EMAIL_JOBS_INDEX,
    mappings: { properties: { ...INDEX_MAPPING.properties } },
  });
  return true;
}

export interface EmailJobDoc {
  id: string;
  batchId: string;
  tenantId: string;
  senderId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  status: string;
  scheduledAt: Date | string;
  sentAt: Date | string | null;
  createdAt: Date | string;
  error: string | null;
  attempts: number;
}

/**
 * Idempotent upsert by job id — replaying the same index job twice just
 * overwrites with the same data (§7.2).
 */
export async function indexEmailJob(doc: EmailJobDoc): Promise<void> {
  const es = getClient();
  await es.index({
    index: EMAIL_JOBS_INDEX,
    id: doc.id,
    document: doc,
    refresh: false,
  });
}

export interface SearchParams {
  tenantId: string;
  status: string[];
  q?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
  sortField: "scheduledAt";
  sortOrder: "asc" | "desc";
}

/** §7.5 example query — tenantId filter is mandatory (never client-supplied without session). */
function buildQuery(p: SearchParams): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [
    { term: { tenantId: p.tenantId } },
    { terms: { status: p.status } },
  ];
  if (p.from || p.to) {
    const range: Record<string, string> = {};
    if (p.from) range.gte = p.from;
    if (p.to) range.lte = p.to;
    filter.push({ range: { scheduledAt: range } });
  }
  const must: Record<string, unknown>[] = [];
  if (p.q) {
    must.push({
      multi_match: { query: p.q, fields: ["subject", "recipient"], fuzziness: "AUTO" },
    });
  }
  return {
    bool: {
      filter,
      must,
    },
  };
}

export interface EsHit {
  id: string;
  batchId: string;
  tenantId: string;
  senderId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  error: string | null;
  attempts: number;
}

function mapHit(source: Record<string, unknown>): EsHit {
  return {
    id: String(source["id"] ?? ""),
    batchId: String(source["batchId"] ?? ""),
    tenantId: String(source["tenantId"] ?? ""),
    senderId: String(source["senderId"] ?? ""),
    senderEmail: String(source["senderEmail"] ?? ""),
    recipient: String(source["recipient"] ?? ""),
    subject: String(source["subject"] ?? ""),
    status: String(source["status"] ?? ""),
    scheduledAt: String(source["scheduledAt"] ?? ""),
    sentAt: source["sentAt"] ? String(source["sentAt"]) : null,
    error: source["error"] ? String(source["error"]) : null,
    attempts: Number(source["attempts"] ?? 0),
  };
}

/**
 * ES-first list query. Throws on ES errors — callers (Query Module) catch and
 * fall back to Postgres per §7.3.
 */
export async function searchEmailJobs(
  p: SearchParams
): Promise<{ items: EsHit[]; total: number }> {
  const es = getClient();
  const resp = await es.search({
    index: EMAIL_JOBS_INDEX,
    query: buildQuery(p),
    sort: [{ [p.sortField]: { order: p.sortOrder } }],
    from: (p.page - 1) * p.pageSize,
    size: p.pageSize,
    track_total_hits: true,
  });
  const total =
    typeof resp.hits.total === "number"
      ? resp.hits.total
      : (resp.hits.total?.value ?? 0);
  const items = resp.hits.hits.map((h) => mapHit(h._source as Record<string, unknown>));
  return { items, total };
}

/** Single-doc fetch — used by the detail route (ES-first). */
export async function getEmailJobDoc(id: string): Promise<EsHit | null> {
  const es = getClient();
  try {
    const resp = await es.get({ index: EMAIL_JOBS_INDEX, id }, { ignore: [404] });
    if (!resp || resp.found === false || !resp._source) return null;
    return mapHit(resp._source as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function closeElasticsearch(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
