"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  Sparkles,
  Zap,
  XCircle,
} from "lucide-react";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { RagExplainability } from "./RagExplainability";

type DraftApi = {
  status: string;
  generated_body: string;
  edited_body: string | null;
  is_fallback?: boolean;
  id?: number;
};

export type AIPanelProps = {
  emailId: number;
  accountLabel?: string | null;
  state: string;
  decision: string | null;
  confidence?: number | null;
  reply: string | null;
  draft: (DraftApi & { id: number }) | null;
  rag_context?: any[];
  actionLoading: string | null;
  uiError: string | null;
  onAction: (key: string, actionFn: () => Promise<void>) => Promise<void>;
  onRefresh: () => void;
};

export function AIPanel({
  emailId,
  accountLabel,
  state,
  decision,
  confidence,
  reply,
  draft,
  rag_context,
  actionLoading,
  uiError,
  onAction,
  onRefresh,
}: AIPanelProps) {
  const draftId = draft?.id;
  const [sendSuccess, setSendSuccess] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftText, setDraftText] = useState("");

  // Convert confidence to semantic level
  const confidencePct = typeof confidence === "number" ? Math.round(confidence * 100) : null;
  const confidenceLevel = useMemo(() => {
    if (confidencePct == null) return { label: "Neutral", class: "app-confidence-medium", color: "var(--color-warning)" };
    if (confidencePct >= 75) return { label: "High", class: "app-confidence-high", color: "var(--color-success)" };
    if (confidencePct >= 45) return { label: "Medium", class: "app-confidence-medium", color: "var(--color-warning)" };
    return { label: "Low", class: "app-confidence-low", color: "var(--color-danger)" };
  }, [confidencePct]);

  useEffect(() => {
    setDraftText(reply ?? draft?.edited_body ?? draft?.generated_body ?? "");
  }, [reply, draft?.edited_body, draft?.generated_body, draftId]);

  async function handleApproveAndSend() {
    await onAction("approve", async () => {
      if (!draftId) throw new Error("Missing draft context");
      const approveRes = await fetch(`/api/drafts/${draftId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId, edited_body: draftText }),
      });
      const approveJson = await approveRes.json().catch(() => ({}));
      if (!approveRes.ok) throw new Error(approveJson.error || "Approve failed");
      if (approveJson.needs_regeneration) throw new Error("Draft needs regeneration");

      const sendRes = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId }),
      });
      if (!sendRes.ok) throw new Error("Send failed");
    });

    setSendSuccess(true);
    window.setTimeout(() => setSendSuccess(false), 1000);
  }

  async function saveDraft() {
    await onAction("save-draft", async () => {
      if (!draftId) throw new Error("Missing draft context");
      setSavingDraft(true);
      try {
        const res = await fetch(`/api/drafts/${draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edited_body: draftText }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Save failed");
      } finally {
        setSavingDraft(false);
      }
    });
  }

  const draftBody = draftText.trim();

  return (
    <div className="flex flex-col gap-4">
      {/* Error state */}
      {uiError && (
        <div className="app-state-error rounded-lg px-4 py-3 text-sm border">
          {uiError}
        </div>
      )}

      {/* AI Draft Card - Inline Design */}
      <div className="rounded-lg border-l-4 p-5 app-state-ready" style={{ borderLeftColor: confidenceLevel.color }}>
        {/* Header: Sparkle + Title + Confidence */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0" style={{ color: "var(--accent-primary)" }} />
            <div>
              <div className="font-semibold text-[13px] app-text-primary mb-1.5">
                Proposed Reply (AI-Assisted)
              </div>
              <ConfidenceIndicator 
                confidence={confidence ?? null} 
                mode={decision === "auto" ? "auto" : "assist"} 
              />
            </div>
          </div>
          <button 
            onClick={onRefresh} 
            className="app-button-secondary rounded-lg p-1.5 shrink-0 app-motion-fast hover:bg-[color:var(--surface-secondary)]"
            title="Regenerate reply"
          >
            <RefreshCcw className="h-4 w-4" />
          </button>
        </div>

        {/* Editable Draft Text */}
        {draftBody ? (
          <div className="mt-4">
            <textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              className="w-full min-h-[140px] resize-y rounded-lg border app-input px-3 py-3 text-[13px] leading-relaxed app-focus-ring"
              placeholder="Draft reply text..."
            />
            {draft?.is_fallback && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] app-state-awaiting">
                <AlertTriangle className="h-3.5 w-3.5" />
                Fallback generation
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed app-border px-4 py-6 text-center text-sm app-text-tertiary">
            No draft generated yet.
          </div>
        )}

        <RagExplainability contextItems={rag_context ?? []} />

        {/* Action Buttons */}
        <div className="mt-4 flex gap-2 flex-wrap">
          {state === "READY_TO_GENERATE" && decision === "manual" && (
            <button
              onClick={() =>
                void onAction("gen", async () => {
                  const res = await fetch(`/api/emails/${emailId}/generate-draft`, { method: "POST" });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || "Generate failed");
                })
              }
              disabled={actionLoading != null}
              className="app-button-primary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold app-motion-fast disabled:opacity-50"
            >
              {actionLoading === "gen" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {actionLoading === "gen" ? "Generating..." : "Generate Draft"}
            </button>
          )}

          {state === "AWAITING_REVIEW" && (
            <>
              <button
                onClick={() => void handleApproveAndSend()}
                disabled={actionLoading != null}
                className="app-button-primary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold app-motion-fast disabled:opacity-50"
              >
                {actionLoading === "approve" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : sendSuccess ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Sent!
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4" />
                    Send
                  </>
                )}
              </button>

              <button
                onClick={() => void saveDraft()}
                disabled={actionLoading != null || savingDraft}
                className="app-button-secondary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium app-motion-fast disabled:opacity-50"
              >
                {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                {savingDraft && "Saving..."}
              </button>

              <button
                onClick={() =>
                  void onAction("reject", async () => {
                    if (!draftId) throw new Error("Missing draft context");
                    const res = await fetch(`/api/drafts/${draftId}/reject`, { method: "POST" });
                    if (!res.ok) throw new Error("Reject failed");
                  })
                }
                disabled={actionLoading != null}
                className="app-button-secondary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium app-motion-fast disabled:opacity-50"
                title="Reject this draft"
              >
                {actionLoading === "reject" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
              </button>
            </>
          )}
        </div>

        {accountLabel && (
          <div className="mt-3 text-[11px] app-text-tertiary">
            Sending as <span className="font-medium">{accountLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}
