import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { getPool } from "@reachinbox/db-schema";
import { SENT_VIEW_STATUSES } from "@reachinbox/shared-types";
import { requireAuth, type AuthedRequest } from "../../middleware/requireAuth.js";
import { listEmails, getEmailDetail } from "./query.service.js";
import { getQueueCounts, peekRateLimitCounters, getQueueConnection } from "@reachinbox/queues";
import { ApiError } from "../../middleware/errorHandler.js";

export const queryRouter: Router = Router();

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["all", ...SENT_VIEW_STATUSES]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["asc", "desc"]).default("asc"),
});

function parseListQuery(req: Request) {
  const parsed = listQuerySchema.safeParse(req.query);
  return parsed.success ? parsed.data : listQuerySchema.parse({});
}

// GET /api/emails/scheduled (FR-31)
queryRouter.get(
  "/scheduled",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const q = parseListQuery(req);
      const result = await listEmails({
        tenantId: user.tenantId,
        statuses: ["scheduled", "processing"],
        q: q.q,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
        sortOrder: q.sort,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/emails/sent (FR-32) — status filter: all | sent | failed
queryRouter.get(
  "/sent",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const q = parseListQuery(req);
      const statuses = q.status && q.status !== "all" ? [q.status] : [...SENT_VIEW_STATUSES];
      const result = await listEmails({
        tenantId: user.tenantId,
        statuses,
        q: q.q,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
        sortOrder: q.sort,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/emails/nav-counts — sidebar badges (screenshot 2)
queryRouter.get(
  "/nav-counts",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const pool = getPool();
      const result = await pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM email_jobs
         WHERE tenant_id = $1 AND status IN ('scheduled', 'processing', 'sent')
         GROUP BY status`,
        [user.tenantId]
      );
      const counts: Record<string, number> = {};
      for (const row of result.rows) counts[row.status] = parseInt(row.count, 10);
      res.json({
        scheduled: (counts["scheduled"] ?? 0) + (counts["processing"] ?? 0),
        sent: counts["sent"] ?? 0,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/emails/queue-stats — Bull Board companion numbers + rate counters
queryRouter.get(
  "/queue-stats",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const pool = getPool();
      const counts = await getQueueCounts();

      let rate: { tenantCount: number; senderCount: number; window: string } | null = null;
      const sender = await pool.query<{ id: string }>(
        `SELECT id FROM senders WHERE tenant_id = $1 LIMIT 1`,
        [user.tenantId]
      );
      if (sender.rows.length > 0) {
        rate = await peekRateLimitCounters(getQueueConnection(), {
          tenantId: user.tenantId,
          senderId: sender.rows[0].id,
        });
      }
      res.json({ queue: counts, rate });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/emails/:id — detail view (screenshot 4)
queryRouter.get(
  "/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const detail = await getEmailDetail(user.tenantId, req.params["id"] ?? "");
      if (!detail) {
        throw new ApiError("NOT_FOUND", "email not found");
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  }
);
