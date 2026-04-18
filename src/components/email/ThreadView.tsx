"use client";

import React, { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";

import { InlineStatusBar } from "./InlineStatusBar";
import { QuickReply } from "./QuickReply";
import { getCategoryTone, getStateVisual } from "../../lib/mailVisuals";

function formatTime(raw: number | string | null): string {
  if (raw == null) return "Unknown time";
  const ms = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return "Unknown time";
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export type DetailProps = {
  id: number;
  subject: string;
  state: string;
  body: string;
  raw_email?: { from?: string; internal_date?: number | string | null; thread_id?: string; subject?: string };
  decision: string | null;
  confidence?: number | null;
  risk_level?: "low" | "medium" | "high";
  rag_strength?: "strong" | "weak" | "none";
  tone_consistency?: number;
  reply?: string | null;
  draft?: { generated_body?: string; edited_body?: string | null } | null;
  thread_messages: Array<{ from: string; internal_date: number | string | null; body: string; subject: string; snippet?: string }>;
  category?: string | null;
};

export function ThreadView({ detail }: { detail: DetailProps }) {
  const threadFrom = detail.thread_messages.find((m) => (m.from ?? "").trim().length > 0)?.from;
  const safeFrom = (detail.raw_email?.from ?? "").trim() || (threadFrom ?? "").trim() || "Unknown sender";
  const safeThreadId = detail.raw_email?.thread_id ?? "";
  const safeInternalDate = detail.raw_email?.internal_date ?? null;

  const [replied, setReplied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const draftText = detail.draft?.edited_body ?? detail.draft?.generated_body ?? detail.reply ?? "";
  const isAutoFlow = detail.decision === "auto";
  const stateVisual = getStateVisual(detail.state);
  const orderedThreadMessages = [...detail.thread_messages].sort((a, b) => {
    const aDate = typeof a.internal_date === "number" ? a.internal_date : Number(a.internal_date ?? 0);
    const bDate = typeof b.internal_date === "number" ? b.internal_date : Number(b.internal_date ?? 0);
    return (Number.isFinite(aDate) ? aDate : 0) - (Number.isFinite(bDate) ? bDate : 0);
  });

  function isCurrentMessage(message: DetailProps["thread_messages"][number]): boolean {
    const messageDate = typeof message.internal_date === "number" ? message.internal_date : Number(message.internal_date ?? 0);
    const safeDate = typeof safeInternalDate === "number" ? safeInternalDate : Number(safeInternalDate ?? 0);
    return (
      message.body === detail.body &&
      (message.from ?? "").trim() === safeFrom &&
      (Number.isFinite(messageDate) && Number.isFinite(safeDate) ? messageDate === safeDate : true)
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4 md:px-8 md:py-6">
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <InlineStatusBar
          state={detail.state}
          category={detail.category}
          confidence={detail.confidence ?? null}
          className="-mx-4 md:-mx-8"
        />

        {/* Thread Header - Minimal */}
        <header className="border-b app-border pb-4">
          <h1 className="text-2xl font-semibold app-text-primary">{detail.subject || "(no subject)"}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
            <span className="max-w-full break-all font-medium app-text-primary">{safeFrom}</span>
            <span className="app-text-faint">•</span>
            <span className="app-text-tertiary">{formatTime(safeInternalDate)}</span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${stateVisual.className}`}>State: {stateVisual.label}</span>
            {detail.category && (
              <span className="app-category-token rounded-full px-2.5 py-1 text-[11px] font-medium" style={getCategoryTone(detail.category)}>
                {detail.category}
              </span>
            )}
          </div>
        </header>

        {/* Original Email Body */}
        <section className="app-card-interactive rounded-lg border app-border p-4 bg-[color:var(--surface-elevated)]">
          <div className="break-words text-[14px] leading-relaxed whitespace-pre-wrap app-text-secondary">
            {detail.body}
          </div>
        </section>

        {isAutoFlow && (
          <section className="app-card-interactive rounded-lg border app-state-awaiting px-4 py-3 text-[13px]">
            <div className="inline-flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              Auto Mode Active
            </div>
            <div className="mt-1 app-text-secondary">
              This thread is set to auto flow. Review and edit quickly, as it can move to send without manual approve in auto mode.
            </div>
          </section>
        )}

        {/* Quick Reply Composer */}
        <QuickReply
          emailId={detail.id}
          threadId={safeThreadId}
          subject={detail.subject}
          to={safeFrom}
          initialText={draftText}
          onSuccess={() => setReplied(true)}
        />

        {/* Success Message */}
        {replied && (
          <div className="app-state-success rounded-lg px-4 py-3 text-sm border">
            ✓ Reply sent successfully.
          </div>
        )}

        {/* Thread History (Collapsible) */}
        {orderedThreadMessages.length > 0 && (
          <section className="app-card-interactive rounded-lg border app-border overflow-hidden">
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-[color:var(--surface-secondary)] app-motion-base"
            >
              <div>
                <div className="text-sm font-semibold app-text-primary">Earlier messages in thread</div>
                <div className="mt-1 text-[12px] app-text-tertiary">{orderedThreadMessages.length} message{orderedThreadMessages.length !== 1 ? "s" : ""}</div>
              </div>
              <ChevronDown className={`h-4 w-4 shrink-0 app-motion-fast ${historyOpen ? "rotate-180" : ""}`} />
            </button>

            {historyOpen && (
              <div className="border-t app-border px-5 py-4 bg-[color:var(--surface-secondary)]">
                <div className="space-y-3">
                  {orderedThreadMessages.map((message, index) => (
                    <article key={`${message.internal_date}-${index}`} className="rounded-lg bg-[color:var(--surface-elevated)] p-4 border app-border">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium app-text-primary">
                          <span className="truncate">{message.from}</span>
                          {isCurrentMessage(message) && (
                            <span className="rounded-full app-state-ready px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]">Original message</span>
                          )}
                        </div>
                        <div className="text-[11px] app-text-faint">{formatTime(message.internal_date)}</div>
                      </div>
                      <div className="break-words text-[13px] leading-relaxed whitespace-pre-wrap app-text-secondary">{message.body}</div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </article>
    </div>
  );
}
