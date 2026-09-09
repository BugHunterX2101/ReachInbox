import { z } from "zod";

export { parseRecipients, normalizeEmail, isValidEmail, formatDelay } from "./recipients.js";

// ---------------------------------------------------------------------------
// Domain enums / statuses
// ---------------------------------------------------------------------------

/** Exact status enum from PRD §11 — nothing added speculatively. */
export const EMAIL_STATUSES = ["scheduled", "processing", "sent", "failed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const SENT_VIEW_STATUSES = ["sent", "failed"] as const;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const emailAddress = z.string().trim().toLowerCase().refine((v) => EMAIL_RE.test(v), {
  message: "is not a valid email address",
});

// ---------------------------------------------------------------------------
// POST /api/emails/schedule (§10.2)
// ---------------------------------------------------------------------------

export const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  storageUrl: z.string().url().max(2048),
  contentType: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const scheduleRequestSchema = z
  .object({
    senderId: z.string().uuid(),
    subject: z.string().trim().min(1, "subject is required").max(998),
    body: z.string().trim().min(1, "body is required"),
    /** Direct entry (chip input) — mutually exclusive with recipientListUploadId. */
    recipients: z.array(emailAddress).max(10_000).optional(),
    /** Uploaded CSV/text list id — mutually exclusive with recipients. */
    recipientListUploadId: z.string().uuid().nullable().optional(),
    startTime: z.string().datetime({ offset: true }),
    delayBetweenSendsMs: z.number().int().min(0).max(3_600_000),
    /** Optional per-batch hourly cap; falls back to sender/tenant defaults (§6.3). */
    hourlyLimit: z.number().int().min(1).max(100_000).optional(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.recipients?.length) !== Boolean(v.recipientListUploadId), {
    message: "provide either recipients or recipientListUploadId, not both",
  });

export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;

export interface ScheduleResponse {
  batchId: string;
  requestedCount: number;
  invalidCount: number;
  invalidSamples: string[];
}

// ---------------------------------------------------------------------------
// GET /api/emails/scheduled | /api/emails/sent (§10.3)
// ---------------------------------------------------------------------------

export interface EmailListItem {
  id: string;
  batchId: string;
  recipient: string;
  senderEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  error: string | null;
  attempts: number;
  /** Only populated by the detail endpoint (screenshot 4's read view). */
  body?: string;
}

export interface EmailListResponse {
  items: EmailListItem[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------------------
// GET /api/me (§10.4)
// ---------------------------------------------------------------------------

export interface MeResponse {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

// ---------------------------------------------------------------------------
// Senders (for Compose's FromSelect)
// ---------------------------------------------------------------------------

export interface SenderDto {
  id: string;
  name: string;
  fromAddress: string;
  maxEmailsPerHour: number;
}

// ---------------------------------------------------------------------------
// Slack integration
// ---------------------------------------------------------------------------

export interface SlackStatusResponse {
  connected: boolean;
  connectedAt: string | null;
  teamName: string | null;
}

// ---------------------------------------------------------------------------
// CSV/text recipient upload (FR-30 parsed-count feedback)
// ---------------------------------------------------------------------------

export interface RecipientUploadResponse {
  uploadId: string;
  validCount: number;
  invalidCount: number;
  invalidSamples: string[];
  recipients: string[];
}

// ---------------------------------------------------------------------------
// Nav counts for the sidebar badges
// ---------------------------------------------------------------------------

export interface NavCounts {
  scheduled: number;
  sent: number;
}

// ---------------------------------------------------------------------------
// Error envelope (§10) — every non-2xx response uses this shape
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
