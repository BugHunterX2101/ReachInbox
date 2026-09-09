import type { EmailStatus } from "@reachinbox/shared-types";

/**
 * Three required visual states (§9.4): scheduled (amber, clock), sent (gray),
 * failed (red) — plus processing (blue) so the Scheduled view can show
 * in-flight sends without lying about them.
 */
const STYLES: Record<EmailStatus, { pill: string; label: string; icon: string }> = {
  scheduled: { pill: "bg-amber-50 text-amber-700 border-amber-200", label: "Scheduled", icon: "🕐" },
  processing: { pill: "bg-blue-50 text-blue-700 border-blue-200", label: "Processing", icon: "↻" },
  sent: { pill: "bg-gray-100 text-gray-600 border-gray-200", label: "Sent", icon: "✓" },
  failed: { pill: "bg-red-50 text-red-700 border-red-200", label: "Failed", icon: "!" },
};

export function StatusPill({ status, time }: { status: EmailStatus; time?: string | null }) {
  const s = STYLES[status] ?? STYLES.scheduled;
  const text =
    status === "scheduled" && time
      ? formatPillTime(time)
      : status === "sent" && time
        ? formatPillTime(time)
        : s.label;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${s.pill}`}
    >
      <span aria-hidden="true">{s.icon}</span>
      {text}
    </span>
  );
}

function formatPillTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
