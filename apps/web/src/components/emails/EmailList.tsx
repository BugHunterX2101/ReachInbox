"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { EmailListResponse } from "@reachinbox/shared-types";
import { api } from "@/lib/api-client";
import { Button, EmptyState, ErrorBanner, Input, SkeletonRows } from "@/components/ui/primitives";
import { StatusPill } from "./StatusPill";

export interface EmailListProps {
  tab: "scheduled" | "sent";
  emptyTitle: string;
  emptyHint?: string;
  emptyAction?: React.ReactNode;
  action?: React.ReactNode;
}

const PAGE_SIZE = 25;

export function EmailList({ tab, emptyTitle, emptyHint, emptyAction, action }: EmailListProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  const key = `emails-${tab}-${query}-${statusFilter}-${page}`;
  const { data, error, isLoading, mutate } = useSWR<EmailListResponse>(
    key,
    () =>
      api.listEmails(tab, {
        q: query || undefined,
        status: tab === "sent" ? statusFilter : undefined,
        page,
        pageSize: PAGE_SIZE,
        sort: tab === "scheduled" ? "asc" : "desc",
      }),
    { refreshInterval: 10_000 }
  );

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* TopBar (screenshot 2): search + filter + refresh */}
      <div className="flex items-center gap-2 border-b border-gray-100 bg-white px-5 py-3">
        <form
          className="relative flex-1 max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
            setPage(1);
          }}
        >
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab === "scheduled" ? "Search scheduled emails…" : "Search sent emails…"}
            className="pl-9"
          />
        </form>

        {tab === "sent" && (
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`rounded-xl border px-3 py-2 text-sm transition ${
              showFilters ? "border-brand-300 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
            title="Filter by status"
          >
            ⚑ Filter
          </button>
        )}
        <button
          onClick={() => void mutate()}
          className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {showFilters && (
        <div className="flex gap-2 border-b border-gray-100 bg-white px-5 py-2">
          {[
            { v: "all", label: "All" },
            { v: "sent", label: "Sent" },
            { v: "failed", label: "Failed" },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => {
                setStatusFilter(opt.v);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                statusFilter === opt.v ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* List pane — skeleton rows while loading (never a bare spinner, §9.4) */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-white">
        {isLoading && <SkeletonRows rows={6} />}
        {error && <ErrorBanner message={(error as Error).message} onRetry={() => void mutate()} />}
        {!isLoading && !error && data && data.items.length === 0 && (
          <EmptyState
            title={query ? "No results" : emptyTitle}
            hint={query ? `Nothing matches “${query}”.` : emptyHint}
            action={emptyAction ?? action}
          />
        )}
        {!isLoading && !error && data && data.items.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {data.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/emails/${item.id}`}
                  className="flex items-center gap-4 px-5 py-4 transition hover:bg-gray-50"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">
                    {item.recipient.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-500">
                      To: <span className="font-medium text-gray-800">{item.recipient}</span>
                    </p>
                    <p className="truncate text-sm font-semibold text-gray-900">{item.subject}</p>
                    {item.status === "failed" && item.error && (
                      <p className="truncate text-xs text-red-500">{item.error}</p>
                    )}
                  </div>
                  <StatusPill status={item.status} time={tab === "scheduled" ? item.scheduledAt : item.sentAt} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pagination */}
      {data && data.items.length > 0 && (
        <div className="flex items-center justify-between border-t border-gray-100 bg-white px-5 py-2.5 text-sm text-gray-500">
          <span>
            {total} email{total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </Button>
            <span className="text-xs">
              Page {page} / {totalPages}
            </span>
            <Button variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
