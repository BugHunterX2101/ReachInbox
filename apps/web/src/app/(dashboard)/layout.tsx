"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { MeResponse } from "@reachinbox/shared-types";
import { api } from "@/lib/api-client";
import { Sidebar } from "@/components/shell/Sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: me, error, isLoading } = useSWR<MeResponse>("me", () => api.me());

  useEffect(() => {
    if (error) router.replace("/login");
  }, [error, router]);

  if (isLoading || !me) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="shimmer h-10 w-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
