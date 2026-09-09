import type {
  EmailListResponse,
  MeResponse,
  NavCounts,
  RecipientUploadResponse,
  ScheduleRequest,
  ScheduleResponse,
  SenderDto,
  SlackStatusResponse,
  EmailListItem,
  QueueStats,
} from "./types";

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let code = "INTERNAL_ERROR";
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiClientError(code, message, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => request<MeResponse>("/api/auth/me"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout"),

  listEmails: (
    tab: "scheduled" | "sent",
    params: { q?: string; status?: string; page?: number; pageSize?: number; sort?: string }
  ) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (params.status) sp.set("status", params.status);
    if (params.page) sp.set("page", String(params.page));
    if (params.pageSize) sp.set("pageSize", String(params.pageSize));
    if (params.sort) sp.set("sort", params.sort);
    return request<EmailListResponse>(`/api/emails/${tab}?${sp.toString()}`);
  },

  navCounts: () => request<NavCounts>("/api/emails/nav-counts"),
  queueStats: () => request<QueueStats>("/api/emails/queue-stats"),

  uploadRecipients: async (file: File): Promise<RecipientUploadResponse> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/emails/upload-recipients", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new ApiClientError("VALIDATION_ERROR", body?.error?.message ?? "upload failed", res.status);
    }
    return (await res.json()) as RecipientUploadResponse;
  },

  uploadAttachment: async (file: File): Promise<{ filename: string; storageUrl: string; contentType?: string; sizeBytes?: number }> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/attachments", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new ApiClientError("VALIDATION_ERROR", body?.error?.message ?? "upload failed", res.status);
    }
    return (await res.json()) as { filename: string; storageUrl: string; contentType?: string; sizeBytes?: number };
  },

  schedule: (body: ScheduleRequest) =>
    request<ScheduleResponse>("/api/emails/schedule", { method: "POST", body: JSON.stringify(body) }),

  senders: () => request<{ items: SenderDto[] }>("/api/emails/senders"),

  slackStatus: () => request<SlackStatusResponse>("/api/integrations/slack"),
  slackDisconnect: () => request<{ ok: boolean }>("/api/integrations/slack", { method: "DELETE" }),

  emailDetail: (id: string) => request<EmailListItem>(`/api/emails/${id}`),
};
