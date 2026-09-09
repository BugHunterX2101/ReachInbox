import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { getPool } from "@reachinbox/db-schema";
import { parseRecipients } from "@reachinbox/shared-types";
import { requireAuth, type AuthedRequest } from "../../middleware/requireAuth.js";
import { validateBody, getValidatedBody } from "../../middleware/validateBody.js";
import { scheduleRequestSchema } from "@reachinbox/shared-types";
import { scheduleBatch } from "./schedule.service.js";
import { ApiError } from "../../middleware/errorHandler.js";

export const scheduleRouter: Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/emails/schedule (FR-4, FR-5, FR-6)
scheduleRouter.post(
  "/schedule",
  requireAuth,
  validateBody(scheduleRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const body = getValidatedBody<typeof scheduleRequestSchema._output>(req);
      const result = await scheduleBatch(user.tenantId, user.id, body);
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/emails/upload-recipients — parse a CSV/text list (FR-30).
 * Returns the parsed-count feedback (valid/invalid/duplicates) plus an uploadId
 * Compose can pass to /schedule as recipientListUploadId.
 */
scheduleRouter.post(
  "/upload-recipients",
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const file = req.file;
      const rawText =
        file?.buffer.toString("utf8") ??
        (typeof req.body?.["text"] === "string" ? (req.body["text"] as string) : "");
      if (!rawText.trim()) {
        throw new ApiError("VALIDATION_ERROR", "attach a CSV/text file or send a text field");
      }

      const parsed = parseRecipients(rawText);
      const pool = getPool();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO recipient_uploads (tenant_id, filename, valid_count, invalid_count, invalid_samples, recipients)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          user.tenantId,
          file?.originalname ?? "pasted-text",
          parsed.valid.length,
          parsed.invalid.length,
          JSON.stringify(parsed.invalid.slice(0, 50)),
          JSON.stringify(parsed.valid),
        ]
      );

      res.status(201).json({
        uploadId: inserted.rows[0].id,
        validCount: parsed.valid.length,
        invalidCount: parsed.invalid.length,
        invalidSamples: parsed.invalid.slice(0, 20),
        recipients: parsed.valid.slice(0, 200),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/emails/senders — sender dropdown for Compose (FR-14)
scheduleRouter.get(
  "/senders",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthedRequest).user!;
      const pool = getPool();
      const result = await pool.query<{ id: string; name: string; from_address: string; max_emails_per_hour: number }>(
        `SELECT id, name, from_address, max_emails_per_hour FROM senders WHERE tenant_id = $1 ORDER BY created_at ASC`,
        [user.tenantId]
      );
      res.json({
        items: result.rows.map((s) => ({
          id: s.id,
          name: s.name,
          fromAddress: s.from_address,
          maxEmailsPerHour: s.max_emails_per_hour,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);
