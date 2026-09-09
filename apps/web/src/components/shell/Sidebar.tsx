"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import type { ReactNode } from "react";
import type { MeResponse, NavCounts } from "@reachinbox/shared-types";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/primitives";

interface NavItem {
  tab: string;
  label: string;
  count: number | undefined;
  icon: ReactNode;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useSWR<MeResponse>("me", () => api.me());
  const { data: counts, mutate: mutateCounts } = useSWR<NavCounts>("nav-counts", () =>
    api.navCounts(),
    { refreshInterval: 10_000 }
  );

  const items: NavItem[] = [
    { tab: "scheduled", label: "Scheduled", count: counts?.scheduled, icon: "🕐" },
    { tab: "sent", label: "Sent", count: counts?.sent, icon: "📤" },
  ];

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-gray-100 bg-white">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 font-bold text-white">
          R
        </div>
        <span className="text-lg font-bold tracking-tight">ReachInbox</span>
      </div>

      <div className="px-3">
        <Link href="/compose">
          <Button className="w-full">✏️ Compose New Email</Button>
        </Link>
      </div>

      <nav className="mt-6 flex-1 space-y-1 px-3">
        {items.map((item) => {
          const active =
            (item.tab === "scheduled" && pathname === "/") ||
            (item.tab === "sent" && pathname === "/sent");
          return (
            <Link
              key={item.tab}
              href={item.tab === "scheduled" ? "/" : "/sent"}
              className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium transition
                ${active ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-50"}`}
              onClick={() => void mutateCounts()}
            >
              <span className="flex items-center gap-2.5">
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </span>
              {typeof item.count === "number" && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold
                    ${active ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-500"}`}
                >
                  {item.count}
                </span>
              )}
            </Link>
          );
        })}

        <Link
          href="/settings"
          className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition
            ${pathname === "/settings" ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-50"}`}
        >
          <span aria-hidden="true">⚙️</span> Settings
        </Link>
        <a
          href="/admin/queues"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
        >
          <span aria-hidden="true">📊</span> Queue Dashboard
        </a>
      </nav>

      <div className="border-t border-gray-100 p-4">
        <div className="flex items-center gap-3">
          <Avatar url={me?.avatarUrl} name={me?.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{me?.name ?? "…"}</p>
            <p className="truncate text-xs text-gray-400">{me?.email ?? ""}</p>
          </div>
          <button
            title="Logout"
            aria-label="Logout"
            onClick={async () => {
              await api.logout();
              router.push("/login");
            }}
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

export function Avatar({ url, name }: { url?: string | null; name?: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name ?? "avatar"} className="h-9 w-9 rounded-full object-cover" />;
  }
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
      {(name ?? "?").slice(0, 1).toUpperCase()}
    </div>
  );
}
