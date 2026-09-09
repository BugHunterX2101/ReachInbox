"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { Attachment, ScheduleResponse, SenderDto } from "@reachinbox/shared-types";
import { api } from "@/lib/api-client";
import { Button, Input, Label, Select } from "@/components/ui/primitives";

interface Chip {
  email: string;
}

export function ComposeForm() {
  const router = useRouter();
  const { data: senderData } = useSWR("senders", () => api.senders());
  const senders: SenderDto[] = senderData?.items ?? [];

  const [senderId, setSenderId] = useState("");
  const [chips, setChips] = useState<Chip[]>([]);
  const [chipInput, setChipInput] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delaySeconds, setDelaySeconds] = useState("30");
  const [hourlyLimit, setHourlyLimit] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadResult, setUploadResult] = useState<{ uploadId: string; valid: number; invalid: number; samples: string[] } | null>(null);
  const [sendLater, setSendLater] = useState<string>(""); // datetime-local value; empty = send now
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ScheduleResponse | null>(null);
  const [showSendLater, setShowSendLater] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  const isSendLater = sendLater !== "";
  const ctaLabel = isSendLater ? "Send Later" : "Send";
  const isValid = useMemo(
    () => Boolean(senderId) && chips.length > 0 && subject.trim().length > 0 && body.trim().length > 0,
    [senderId, chips.length, subject, body]
  );

  function addChipFromInput() {
    const parts = chipInput.split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean);
    const next = [...chips];
    for (const p of parts) {
      const email = p.toLowerCase();
      if (email && !next.some((c) => c.email === email)) next.push({ email });
    }
    setChips(next);
    setChipInput("");
  }

  async function handleListUpload(file: File) {
    setError(null);
    try {
      const res = await api.uploadRecipients(file);
      setUploadResult({
        uploadId: res.uploadId,
        valid: res.validCount,
        invalid: res.invalidCount,
        samples: res.invalidSamples,
      });
      // Show parsed addresses as chips too (screenshot 7) — up to 50 for sanity.
      setChips((prev) => {
        const seen = new Set(prev.map((c) => c.email));
        const additions: Chip[] = res.recipients
          .filter((r: string) => !seen.has(r))
          .map((r: string) => ({ email: r }));
        return [...prev, ...additions].slice(0, 50);
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAttachment(file: File) {
    setError(null);
    try {
      const res = await api.uploadAttachment(file);
      setAttachments((prev) => [...prev, { filename: res.filename, storageUrl: res.storageUrl, contentType: res.contentType, sizeBytes: res.sizeBytes }]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit() {
    if (!isValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const startTime = isSendLater ? new Date(sendLater).toISOString() : new Date(Date.now() + 5000).toISOString();
      const payload = {
        senderId,
        subject: subject.trim(),
        body,
        // Large lists go by uploadId; small ones inline (mutually exclusive, §10.2).
        ...(uploadResult && chips.length > 50
          ? { recipientListUploadId: uploadResult.uploadId }
          : { recipients: chips.map((c) => c.email) }),
        startTime,
        delayBetweenSendsMs: Math.max(0, parseInt(delaySeconds || "0", 10)) * 1000,
        ...(hourlyLimit ? { hourlyLimit: parseInt(hourlyLimit, 10) } : {}),
        ...(attachments.length ? { attachments } : {}),
      };
      const res = await api.schedule(payload);
      setSuccess(res);
      setTimeout(() => router.push("/"), 1200);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Quick presets (screenshot 5): Tomorrow / Tomorrow 10:00 / 11:00 / 15:00
  function preset(dt: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const v = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    setSendLater(v);
    setShowSendLater(false);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      {success && (
        <div className="mb-4 rounded-xl border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-700">
          ✓ Batch scheduled — {success.requestedCount} email{success.requestedCount === 1 ? "" : "s"} queued
          {success.invalidCount > 0 && `, ${success.invalidCount} skipped (invalid)`}. Redirecting…
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Header row: title + state-driven CTA (screenshot 6) */}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-bold tracking-tight">New Email</h1>
        <Button onClick={submit} disabled={!isValid || busy} variant={isSendLater ? "outline" : "primary"}>
          {busy ? "Scheduling…" : ctaLabel}
        </Button>
      </div>

      <div className="space-y-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-card">
        {/* From */}
        <div>
          <Label htmlFor="from">From</Label>
          <Select id="from" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
            <option value="">Select a sender…</option>
            {senders.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.fromAddress} ({s.maxEmailsPerHour}/hr)
              </option>
            ))}
          </Select>
        </div>

        {/* To — chips + Upload List (screenshot 7) */}
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="to">To</Label>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mb-1 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-100"
            >
              ⬆ Upload List (CSV/TXT)
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleListUpload(f);
                e.target.value = "";
              }}
            />
          </div>
          <div
            className="flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2.5 py-2 cursor-text"
            onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
          >
            {chips.map((c) => (
              <span key={c.email} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-brand-700">
                {c.email}
                <button
                  type="button"
                  aria-label={`Remove ${c.email}`}
                  onClick={() => setChips((prev) => prev.filter((x) => x.email !== c.email))}
                  className="rounded-full px-1 text-brand-400 hover:bg-brand-100 hover:text-brand-700"
                >
                  ×
                </button>
              </span>
            ))}
            {chips.length > 12 && <span className="text-xs text-gray-400">+{chips.length - 12} more</span>}
            <input
              value={chipInput}
              onChange={(e) => setChipInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "," || e.key === ";") {
                  e.preventDefault();
                  addChipFromInput();
                } else if (e.key === "Backspace" && !chipInput && chips.length > 0) {
                  setChips((prev) => prev.slice(0, -1));
                }
              }}
              placeholder={chips.length === 0 ? "type addresses, or upload a list…" : ""}
              className="min-w-[200px] flex-1 border-0 bg-transparent text-sm outline-none"
            />
          </div>
          {uploadResult && (
            <p className="mt-1.5 text-xs text-gray-500">
              ✓ {uploadResult.valid} added, {uploadResult.invalid} skipped (invalid)
              {uploadResult.samples.length > 0 && (
                <span className="text-gray-400"> — e.g. {uploadResult.samples.slice(0, 3).join(", ")}</span>
              )}
            </p>
          )}
        </div>

        {/* Subject */}
        <div>
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </div>

        {/* Pacing inputs (screenshot 5): delay seconds + hourly limit */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="delay">Delay between 2 emails (seconds)</Label>
            <Input
              id="delay"
              type="number"
              min={0}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(e.target.value)}
              placeholder="00"
            />
          </div>
          <div>
            <Label htmlFor="cap">Hourly limit</Label>
            <Input
              id="cap"
              type="number"
              min={1}
              value={hourlyLimit}
              onChange={(e) => setHourlyLimit(e.target.value)}
              placeholder="00"
            />
          </div>
        </div>

        {/* Body — contentEditable rich text with a minimal formatting toolbar */}
        <div>
          <Label>Body</Label>
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <div className="flex items-center gap-1 border-b border-gray-100 bg-gray-50 px-2 py-1.5">
              <FormatButton label="B" onClick={() => document.execCommand("bold")} bold />
              <FormatButton label="I" onClick={() => document.execCommand("italic")} italic />
              <FormatButton label="U" onClick={() => document.execCommand("underline")} />
              <FormatButton label="”" onClick={() => document.execCommand("formatBlock", false, "blockquote")} />
              <FormatButton label="• List" onClick={() => document.execCommand("insertUnorderedList")} />
            </div>
            <div
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => setBody((e.target as HTMLDivElement).innerHTML)}
              className="min-h-[180px] px-4 py-3 text-sm outline-none"
              data-placeholder="Write your email…"
            />
          </div>
        </div>

        {/* Attachment tray (screenshots 5-6: paperclip + rendered cards) */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => attachRef.current?.click()}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              attachments.length > 0 ? "bg-brand-50 text-brand-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            📎 Attach file
          </button>
          <input
            ref={attachRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleAttachment(f);
              e.target.value = "";
            }}
          />
          {attachments.map((a, i) => (
            <span key={`${a.storageUrl}-${i}`} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1 text-xs">
              🖼 {a.filename}
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                className="text-gray-400 hover:text-gray-700"
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {/* Send Later row (screenshot 5): clock icon + popover with presets */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSendLater((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                isSendLater ? "bg-brand-50 text-brand-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              🕐 {isSendLater ? `Send at ${new Date(sendLater).toLocaleString()}` : "Send Later"}
            </button>
            {showSendLater && (
              <div className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-2xl border border-gray-100 bg-white p-4 shadow-lg">
                <p className="mb-2 text-sm font-semibold">Schedule for later</p>
                <Input
                  type="datetime-local"
                  value={sendLater}
                  onChange={(e) => setSendLater(e.target.value)}
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <PresetButton label="Tomorrow 9:00" onClick={() => preset(tomorrowAt(9))} />
                  <PresetButton label="Tomorrow 10:00" onClick={() => preset(tomorrowAt(10))} />
                  <PresetButton label="Tomorrow 11:00" onClick={() => preset(tomorrowAt(11))} />
                  <PresetButton label="Tomorrow 15:00" onClick={() => preset(tomorrowAt(15))} />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => { setSendLater(""); setShowSendLater(false); }}>
                    Cancel
                  </Button>
                  <Button variant="secondary" onClick={() => setShowSendLater(false)}>
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
          {isSendLater && (
            <button type="button" onClick={() => setSendLater("")} className="text-xs text-gray-400 hover:text-gray-600">
              Clear — send immediately instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FormatButton({ label, onClick, bold, italic }: { label: string; onClick: () => void; bold?: boolean; italic?: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-200 ${bold ? "font-bold" : ""} ${italic ? "italic" : ""}`}
    >
      {label}
    </button>
  );
}

function PresetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 transition hover:border-brand-300 hover:bg-brand-50"
    >
      {label}
    </button>
  );
}

function tomorrowAt(hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}
