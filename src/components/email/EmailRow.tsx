import React, { useMemo, useState } from "react";
import { Archive, ExternalLink, Loader2, Mail, MailOpen, Send, Sparkles } from "lucide-react";
import { getCategoryTone, getStateVisual } from "../../lib/mailVisuals";

function formatRelativeTime(raw: number | string | null): string {
  if (raw == null) return "Pending";
  const ms = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return "Pending";
  const now = Date.now();
  const diff = now - ms;
  if (!Number.isFinite(diff) || diff < 0) return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export type EmailListItem = {
  id: number;
  subject: string;
  from_email?: string;
  gmail_id?: string;
  thread_id?: string;
  snippet?: string | null;
  state: string;
  category?: string | null;
  decision?: string | null;
  is_seen?: boolean;
  internal_date: number | string | null;
  last_step?: string | null;
  embedding_status?: string;
  embedding_error?: string | null;
  embedding_chunk_count?: number;
  confidence?: number | null;
  risk_score?: number | null;
  risk_level?: "low" | "medium" | "high";
  tone_consistency?: number;
  rag_confidence?: number | null;
  rag_strength?: "strong" | "weak" | "none";
  decision_reason?: string | null;
  draft?: { id?: number } | null;
};

type EmailRowProps = {
  email: EmailListItem;
  isSelected: boolean;
  categoryColors?: Record<string, string> | undefined;
  onClick: () => void;
  onGenerate: (id: number) => void;
  onSend: (id: number) => void;
  onArchive: (id: number) => void;
  onToggleSeen: (id: number) => void;
  onOpenInGmail: (id: number) => void;
  actionLoading: string | null;
  showActions?: boolean;
};

export const EmailRow = React.memo(function EmailRow({
  email,
  isSelected,
  categoryColors,
  onClick,
  onGenerate,
  onSend,
  onArchive,
  onToggleSeen,
  onOpenInGmail,
  actionLoading,
  showActions = true,
}: EmailRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isGenerating = actionLoading === `gen-${email.id}`;
  const isSending = actionLoading === `send-${email.id}`;
  const hasAIContext = email.state === "READY_TO_GENERATE" || email.state === "AWAITING_REVIEW" || email.draft;
  const isUnseen =
    typeof email.is_seen === "boolean"
      ? !email.is_seen
      : email.state === "INGESTED" ||
        email.state === "PROCESSING" ||
        email.state === "CLASSIFIED" ||
        email.state === "READY_TO_GENERATE";
  const canSend = (email.state === "READY_TO_SEND" || email.state === "AWAITING_REVIEW") && Boolean(email.draft?.id);
  const hasGmailLink = Boolean(email.thread_id || email.gmail_id);

  const categoryBorderStyle = useMemo(() => {
    if (!email.category) return { backgroundColor: "var(--accent-primary)" };
    return {
      ...getCategoryTone(email.category, categoryColors),
      backgroundColor: "var(--cat-color)",
    };
  }, [email.category, categoryColors]);

  const stateVisual = getStateVisual(email.state);
  const decisionLabel = email.decision === "auto" ? "Auto" : email.decision === "assist" ? "Assist" : email.decision === "manual" ? "Manual" : null;

  const onRowKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onRowKeyDown}
      className={`group relative min-h-[106px] overflow-hidden border-b app-border px-4 py-3 text-left app-motion-fast cursor-pointer ${
        isSelected
          ? "bg-[color:color-mix(in_srgb,var(--accent-primary) 12%,var(--surface-elevated) 88%)]"
          : isUnseen
            ? "bg-[color:color-mix(in_srgb,var(--accent-primary) 3%,var(--surface-elevated) 97%)] hover:bg-[color:color-mix(in_srgb,var(--accent-primary) 5%,var(--surface-secondary) 95%)]"
            : "bg-transparent hover:bg-[color:var(--surface-secondary)]"
      }`}
    >
      {/* Left accent border for AI-context emails */}
      {hasAIContext && (
        <div className="absolute left-0 top-0 bottom-0 w-1" style={categoryBorderStyle} />
      )}

      {/* Main Content Grid - Compact layout */}
      <div className="flex min-w-0 items-start gap-3 pl-2">
        {isUnseen && <div className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent-primary-strong)]" />}
        {/* From + Subject + Preview */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {/* From (bold if unread-like state) */}
          <div className={`truncate text-[14px] ${isUnseen ? "font-medium app-text-primary" : "font-medium app-text-secondary"}`}>
            {email.from_email && email.from_email !== "Unknown sender" ? (
              email.from_email
            ) : (
              <span className="italic app-text-tertiary">Unknown sender</span>
            )}
          </div>
          
          {/* Subject + Category on same line */}
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <div className={`truncate text-[13px] ${isUnseen ? "font-medium app-text-primary" : "font-medium app-text-primary"}`}>
              {email.subject || "(no subject)"}
            </div>
            {email.category && (
              <span
                className="app-category-token max-w-[11rem] shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={getCategoryTone(email.category, categoryColors)}
              >
                {email.category}
              </span>
            )}
          </div>

          {/* Preview */}
          <div className="mt-0.5 truncate text-[12px] app-text-tertiary">
            {email.snippet || "No preview available."}
          </div>

          {email.decision_reason && (
            <div className="mt-1 truncate text-[11px] font-medium app-text-muted">
              {email.decision_reason.includes("Low RAG confidence")
                ? "Low confidence: edit before sending"
                : email.decision_reason}
            </div>
          )}
        </div>

        {/* Right side: Time + State + Actions */}
        <div className="ml-2 flex shrink-0 items-start gap-1.5 sm:items-center sm:gap-2">
          {/* Time */}
          <div className={`text-[12px] whitespace-nowrap ${isUnseen ? "font-medium app-text-tertiary" : "app-text-faint"}`}>
            {formatRelativeTime(email.internal_date)}
          </div>

          {/* State Badge */}
          <span className={`max-w-[110px] truncate text-[11px] px-2 py-0.5 rounded-full font-medium ${stateVisual.className} shrink-0`}>
            {stateVisual.label}
          </span>
          {decisionLabel && (
            <span className={`hidden xl:inline-flex text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
              decisionLabel === "Auto"
                ? "bg-emerald-500/12 text-emerald-600"
                : decisionLabel === "Assist"
                ? "bg-amber-500/12 text-amber-600"
                : "bg-slate-500/12 text-slate-600"
            }`}>
              {decisionLabel}
            </span>
          )}

          {showActions && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((value) => !value);
              }}
              className="app-focus-ring lg:hidden shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-[color:var(--surface-secondary)] opacity-50 hover:opacity-100 transition-opacity"
            >
              ⋯
            </button>
          )}

          {showActions && menuOpen && (
            <div className="app-popover absolute right-2 top-10 z-30 w-40 rounded-xl p-1 lg:hidden">
              <button
                type="button"
                disabled={actionLoading != null}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  if (canSend) onSend(email.id);
                  else onGenerate(email.id);
                }}
                className="app-focus-ring block w-full rounded-lg px-2 py-1.5 text-left text-[11px] app-hover-soft"
              >
                {canSend ? "Send" : "Generate"}
              </button>
              <button
                type="button"
                disabled={actionLoading != null}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onArchive(email.id);
                }}
                className="app-focus-ring block w-full rounded-lg px-2 py-1.5 text-left text-[11px] app-hover-soft"
              >
                Archive
              </button>
              <button
                type="button"
                disabled={actionLoading != null}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onToggleSeen(email.id);
                }}
                className="app-focus-ring block w-full rounded-lg px-2 py-1.5 text-left text-[11px] app-hover-soft"
              >
                {isUnseen ? "Mark read" : "Mark unread"}
              </button>
              {hasGmailLink && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    onOpenInGmail(email.id);
                  }}
                  className="app-focus-ring block w-full rounded-lg px-2 py-1.5 text-left text-[11px] app-hover-soft"
                >
                  Open in Gmail
                </button>
              )}
            </div>
          )}

          {showActions && (
          <div className="hidden lg:flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (canSend) onSend(email.id);
                else onGenerate(email.id);
              }}
              disabled={actionLoading != null}
              title={canSend ? "Send draft" : "Generate draft"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--border-primary)] bg-[color:var(--surface-layer-2,var(--surface-secondary))] hover:bg-[color:var(--surface-secondary)] app-motion-fast"
            >
              {isGenerating || isSending ? (
                <span className="inline-flex items-center gap-0.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                </span>
              ) : (
                <>
                  {canSend ? <Send className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                </>
              )}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onArchive(email.id);
              }}
              disabled={actionLoading != null}
              title="Archive"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--border-primary)] bg-[color:var(--surface-layer-2,var(--surface-secondary))] hover:bg-[color:var(--surface-secondary)] app-motion-fast"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleSeen(email.id);
              }}
              disabled={actionLoading != null}
              title={isUnseen ? "Mark read" : "Mark unread"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--border-primary)] bg-[color:var(--surface-layer-2,var(--surface-secondary))] hover:bg-[color:var(--surface-secondary)] app-motion-fast"
            >
              {isUnseen ? <MailOpen className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
            </button>
            {hasGmailLink && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenInGmail(email.id);
                }}
                title="Open in Gmail"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--border-primary)] bg-[color:var(--surface-layer-2,var(--surface-secondary))] hover:bg-[color:var(--surface-secondary)] app-motion-fast"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
});
