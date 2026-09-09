"use client";

import { use } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { EmailListItem } from "@reachinbox/shared-types";
import { api } from "@/lib/api-client";
import { Button, ErrorBanner, SkeletonRows } from "@/components/ui/primitives";
import { StatusPill } from "@/components/emails/StatusPill";

export default function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, isLoading } = useSWR<EmailListItem>(`email-${id}`, () => api.emailDetail(id));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      {/* DetailHeader (screenshot 4): back + read-only actions */}
      <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3">
        <Link href="/">
          <Button variant="ghost">← Back</Button>
        </Link>
        <div className="flex-1" />
        <Button variant="ghost" title="Star (coming soon)" disabled>
          ☆
        </Button>
        <Button variant="ghost" title="Archive (coming soon)" disabled>
          🗄
        </Button>
        <Button variant="ghost" title="Delete (coming soon)" disabled>
          🗑
        </Button>
      </div>

      {isLoading && <SkeletonRows rows={3} />}
      {error && <ErrorBanner message={(error as Error).message} />}
      {data && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-8">
            <h1 className="text-xl font-bold tracking-tight">{data.subject}</h1>
            <div className="mt-1.5">
              <StatusPill status={data.status} time={data.sentAt ?? data.scheduledAt} />
            </div>

            <div className="mt-6 flex items-center gap-3 rounded-2xl border border-gray-100 bg-gray-50/60 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700">
                {data.senderEmail.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold">{data.senderEmail}</p>
                <p className="text-gray-500">
                  to <span className="font-medium text-gray-700">{data.recipient}</span>
                </p>
              </div>
              <div className="text-right text-xs text-gray-400">
                <p>Scheduled {new Date(data.scheduledAt).toLocaleString()}</p>
                {data.sentAt && <p>Sent {new Date(data.sentAt).toLocaleString()}</p>}
                {data.attempts > 1 && <p>Attempts: {data.attempts}</p>}
              </div>
            </div>

            {data.error && (
              <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                <span className="font-medium">Failure reason:</span> {data.error}
              </div>
            )}

            <div
              className="mt-6 max-w-none text-sm leading-relaxed text-gray-800 [&_a]:text-brand-700 [&_blockquote]:border-l-4 [&_blockquote]:border-brand-200 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600 [&_strong]:font-semibold"
              // Body is our own composed HTML from the rich-text editor,
              // rendered read-only per screenshot 4.
              dangerouslySetInnerHTML={{ __html: data.body ?? "" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
