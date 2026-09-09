import type { Attachment } from "@reachinbox/shared-types";

export type {
  Attachment,
  EmailStatus,
  EmailListItem,
  EmailListResponse,
  MeResponse,
  NavCounts,
  RecipientUploadResponse,
  ScheduleResponse,
  SenderDto,
  SlackStatusResponse,
  ApiError,
} from "@reachinbox/shared-types";

/** Matches the shared zod scheduleRequestSchema (§10.2). */
export interface ScheduleRequest {
  senderId: string;
  subject: string;
  body: string;
  recipients?: string[];
  recipientListUploadId?: string | null;
  startTime: string;
  delayBetweenSendsMs: number;
  hourlyLimit?: number;
  attachments?: Attachment[];
}

export interface QueueStats {
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
  };
  rate: { tenantCount: number; senderCount: number; window: string } | null;
}
