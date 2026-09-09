"use client";

import { EmailList } from "@/components/emails/EmailList";

export default function SentPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-gray-100 bg-white px-5 py-3">
        <h1 className="text-lg font-bold tracking-tight">Sent</h1>
      </div>
      <EmailList
        tab="sent"
        emptyTitle="Nothing sent yet"
        emptyHint="Emails that finish sending (or fail) will show up here with their status."
      />
    </div>
  );
}
