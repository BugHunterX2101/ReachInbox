"use client";

import Link from "next/link";
import { EmailList } from "@/components/emails/EmailList";
import { Button } from "@/components/ui/primitives";

export default function ScheduledPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-5 py-3">
        <h1 className="text-lg font-bold tracking-tight">Scheduled</h1>
        <Link href="/compose">
          <Button variant="outline">+ New Batch</Button>
        </Link>
      </div>
      <EmailList
        tab="scheduled"
        emptyTitle="Nothing scheduled yet"
        emptyHint="Compose your first email batch and it will appear here, paced and throttled like a human sender."
        action={
          <Link href="/compose">
            <Button>Compose New Email</Button>
          </Link>
        }
      />
    </div>
  );
}
