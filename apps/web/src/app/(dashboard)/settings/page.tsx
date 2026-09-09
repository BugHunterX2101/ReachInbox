"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { SlackStatusResponse } from "@reachinbox/shared-types";
import type { QueueStats } from "@/lib/types";
import { api } from "@/lib/api-client";
import { Button, SkeletonRows } from "@/components/ui/primitives";

export default function SettingsPage() {
  const { data: slack, mutate: mutateSlack } = useSWR<SlackStatusResponse>("slack", () =>
    api.slackStatus()
  );
  const { data: stats } = useSWR<QueueStats>("queue-stats", () => api.queueStats(), {
    refreshInterval: 10_000,
  });
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("slack");
    if (s === "connected") {
      setFlash("Slack connected — rate-limit alerts will now arrive in your workspace.");
      void mutateSlack();
    } else if (s === "state_mismatch" || s === "missing_code") {
      setFlash("Slack connection failed — please try again.");
    }
  }, [mutateSlack]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <h1 className="text-lg font-bold tracking-tight">Settings</h1>

        {flash && (
          <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {flash}
          </div>
        )}

        {/* Slack integration card (FR-22–FR-25) */}
        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Slack notifications</h2>
              <p className="mt-1 text-sm text-gray-500">
                Get pinged in Slack the instant a sender hits its hourly cap. Affected emails are
                deferred to the next hour window — never dropped.
              </p>
            </div>
            {!slack ? (
              <div className="shimmer h-9 w-28 rounded-xl" />
            ) : slack.connected ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  await api.slackDisconnect();
                  void mutateSlack();
                }}
              >
                Disconnect
              </Button>
            ) : (
              <a href="/api/integrations/slack/connect">
                <Button>Connect Slack</Button>
              </a>
            )}
          </div>
          {slack?.connected && (
            <p className="mt-3 text-xs text-gray-400">
              Connected {slack.connectedAt ? new Date(slack.connectedAt).toLocaleString() : ""}. Alerts
              fire even if you connect mid-session — the token is read at notify time.
            </p>
          )}
        </div>

        {/* Live queue + rate window card */}
        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-card">
          <h2 className="font-semibold">Live queue &amp; rate window</h2>
          <p className="mt-1 text-sm text-gray-500">
            Same numbers Bull Board shows, plus this hour&apos;s Redis rate counters. The full live
            dashboard is at{" "}
            <a href="/admin/queues" target="_blank" rel="noreferrer" className="text-brand-700 underline">
              /admin/queues
            </a>
            .
          </p>
          {!stats ? (
            <SkeletonRows rows={2} />
          ) : (
            <div className="mt-4 grid grid-cols-5 gap-3 text-center">
              {[
                ["Waiting", stats.queue.waiting],
                ["Active", stats.queue.active],
                ["Delayed", stats.queue.delayed],
                ["Completed", stats.queue.completed],
                ["Failed", stats.queue.failed],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-xl bg-gray-50 px-2 py-3">
                  <p className="text-xl font-bold">{value as number}</p>
                  <p className="text-xs text-gray-400">{label as string}</p>
                </div>
              ))}
            </div>
          )}
          {stats?.rate && (
            <p className="mt-3 text-xs text-gray-400">
              This hour — tenant counter: {stats.rate.tenantCount}, first sender counter:{" "}
              {stats.rate.senderCount} (window {stats.rate.window})
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
