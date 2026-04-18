"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

type PanelLog = {
  id?: number;
  step: string;
  state: string;
  latency_ms?: number | null;
  error?: string | null;
  created_at?: string;
};

type EmailMetadataDetail = {
  source?: string;
  state: string;
  category?: string | null;
  decision?: string | null;
  decision_reason?: string | null;
  selected_model?: string | null;
  style_confidence?: number | null;
  clarification_mode?: boolean;
  risk_score?: number | null;
  risk_reasons?: string[];
  rag_confidence?: number | null;
  rag_conflict_detected?: boolean;
  rag_context?: Array<{
    subject?: string;
    topic?: string;
    answer?: string;
    distance?: number;
    email_id?: number;
  }>;
  cost_score?: number | null;
  cost_estimate_tokens?: number | null;
  priority_score?: number | null;
  next_best_action?: string | null;
  edited_count?: number;
  rejected_count?: number;
  regenerated_count?: number;
  accepted_count?: number;
  trace_id?: string | null;
  gmail_id?: string | null;
  last_step?: string | null;
  last_error?: string | null;
  review_outcome?: string | null;
  retry_count?: number | null;
  raw_email?: {
    from?: string;
    internal_date?: number | string | null;
    thread_id?: string;
    snippet?: string;
  };
  llm?: {
    prompt_version?: string | null;
    tokens_in?: number | null;
    tokens_out?: number | null;
    latency_ms?: number | null;
  };
  logs?: PanelLog[];
  embedding_status?: string;
  embedding_error?: string | null | undefined;
  embedding_chunk_count?: number;
};

function formatFieldLabel(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  return value.replaceAll("_", " ");
}

function formatDate(value?: string | number | null): string {
  if (!value) return "Unavailable";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function EmailMetadataPanel({
  detail,
  title = "Metadata and logs",
}: {
  detail: EmailMetadataDetail;
  title?: string;
}) {
  const [inspectMode, setInspectMode] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div className="border-b app-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold app-text-primary">{title}</h3>
            <p className="mt-1 text-xs app-text-muted">Workflow and message context. Technical telemetry stays in Inspect mode.</p>
          </div>
          <button
            type="button"
            onClick={() => setInspectMode((value) => !value)}
            className="app-button-secondary inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
          >
            {inspectMode ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {inspectMode ? "Exit Inspect" : "Inspect"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-5 pb-6">
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetaStat label="Workflow state" value={formatFieldLabel(detail.state)} />
            <MetaStat label="Category" value={formatFieldLabel(detail.category)} />
            <MetaStat label="Decision" value={formatFieldLabel(detail.decision)} />
            <MetaStat label="Risk score" value={detail.risk_score != null ? detail.risk_score.toFixed(2) : "Unavailable"} />
            <MetaStat label="Memory" value={detail.embedding_status ? formatFieldLabel(detail.embedding_status) : "Not indexed"} />
            <MetaStat label="RAG confidence" value={detail.rag_confidence != null ? detail.rag_confidence.toFixed(2) : "Unavailable"} />
            <MetaStat label="Chunks" value={String(detail.embedding_chunk_count ?? 0)} />
            <MetaStat label="Review" value={formatFieldLabel(detail.review_outcome)} />
            <MetaStat label="Retries" value={String(detail.retry_count ?? 0)} />
          </section>

          {(detail.decision_reason || detail.rag_conflict_detected) && (
            <section className="rounded-[18px] app-input-strong px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Decision assistance</div>
              <div className="mt-3 space-y-2 text-sm leading-6 app-text-secondary">
                {detail.decision_reason && <p>{detail.decision_reason}</p>}
                {detail.rag_conflict_detected && <p>Context conflict detected: review suggested sources before send.</p>}
              </div>
            </section>
          )}

          <section className="rounded-[18px] app-input-strong px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Why this response</div>
            <div className="mt-3 space-y-2 text-sm leading-6 app-text-secondary">
              <p>{detail.decision_reason ?? "Decision reason unavailable."}</p>
              <p>RAG confidence: {detail.rag_confidence != null ? detail.rag_confidence.toFixed(2) : "Unavailable"}</p>
              <p>RAG sources: {Array.isArray(detail.rag_context) ? detail.rag_context.length : 0}</p>
            </div>
          </section>

          <section className="rounded-[18px] app-input-strong px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">System thinking</div>
            <div className="mt-3 space-y-2 text-sm leading-6 app-text-secondary">
              <p>Risk level: {detail.risk_score != null ? detail.risk_score.toFixed(2) : "Unavailable"}</p>
              <p>Model used: {detail.selected_model ?? "Unavailable"}</p>
              <p>Style confidence: {detail.style_confidence != null ? detail.style_confidence.toFixed(2) : "Unavailable"}</p>
              <p>Clarification loop: {detail.clarification_mode ? "active" : "inactive"}</p>
            </div>
          </section>

          <section className="rounded-[18px] app-input-strong px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Next best action</div>
            <div className="mt-3 text-sm leading-6 app-text-secondary">
              {detail.next_best_action === "edit"
                ? "Edit this response before sending."
                : detail.next_best_action === "send"
                ? "Safe to send after final review."
                : detail.next_best_action === "regenerate"
                ? "Regenerate with clearer intent/context."
                : "Inspect logs and context before acting."}
            </div>
          </section>

          {(detail.last_error || detail.embedding_error) && (
            <section className="rounded-[18px] app-input-strong px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Attention</div>
              <div className="mt-3 space-y-3 text-sm leading-6 app-text-secondary">
                {detail.embedding_error && <p><span className="font-medium app-text-primary">Embedding:</span> {detail.embedding_error}</p>}
                {detail.last_error && <p><span className="font-medium app-text-primary">Pipeline:</span> {detail.last_error}</p>}
              </div>
            </section>
          )}

          <section className="grid gap-3 xl:grid-cols-2">
            <MetaBlock
              title="Message details"
              rows={[
                ["Source", formatFieldLabel(detail.source)],
                ["Thread ID", detail.raw_email?.thread_id ?? "Unavailable"],
                ["From", detail.raw_email?.from ?? "Unavailable"],
                ["Received", formatDate(detail.raw_email?.internal_date ?? null)],
                ["Snippet", detail.raw_email?.snippet ?? "Unavailable"],
              ]}
            />
            <MetaBlock
              title="Delivery posture"
              rows={[
                ["Risk", formatFieldLabel(detail.last_error ? "attention" : "normal")],
                ["Priority", detail.priority_score != null ? detail.priority_score.toFixed(2) : "Unavailable"],
                ["Cost score", detail.cost_score != null ? detail.cost_score.toFixed(2) : "Unavailable"],
                ["Estimated tokens", detail.cost_estimate_tokens != null ? String(detail.cost_estimate_tokens) : "Unavailable"],
                ["Memory status", detail.embedding_status ? formatFieldLabel(detail.embedding_status) : "Not indexed"],
                ["Retries", String(detail.retry_count ?? 0)],
                ["Review", formatFieldLabel(detail.review_outcome)],
                ["Edited", String(detail.edited_count ?? 0)],
                ["Rejected", String(detail.rejected_count ?? 0)],
                ["Regenerated", String(detail.regenerated_count ?? 0)],
                ["Accepted", String(detail.accepted_count ?? 0)],
              ]}
            />
          </section>

          {Array.isArray(detail.rag_context) && detail.rag_context.length > 0 && (
            <section className="rounded-[18px] app-input-strong px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">RAG explainability</div>
              <div className="mt-3 space-y-3">
                {detail.rag_context.slice(0, 3).map((item, index) => (
                  <div key={`${item.email_id ?? index}-${index}`} className="rounded-xl app-input px-3 py-3">
                    <div className="text-xs font-semibold app-text-primary">{item.subject || item.topic || "Source context"}</div>
                    <div className="mt-1 text-xs app-text-muted">
                      Source email #{item.email_id ?? "unknown"} {typeof item.distance === "number" ? `• distance ${item.distance.toFixed(2)}` : ""}
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm app-text-secondary">{item.answer ?? ""}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {inspectMode && (
            <section className="rounded-[18px] border app-border bg-[color:var(--surface-elevated)] px-4 py-4 app-motion-medium shadow-sm">
              <div className="text-xs font-semibold tracking-[0.1em] app-text-muted">Inspect telemetry</div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                <MetaBlock
                  title="Trace"
                  rows={[
                    ["Trace ID", detail.trace_id ?? "Unavailable"],
                    ["Gmail ID", detail.gmail_id ?? "Unavailable"],
                    ["Last step", formatFieldLabel(detail.last_step)],
                  ]}
                />
                <MetaBlock
                  title="LLM metrics"
                  rows={[
                    ["Prompt version", detail.llm?.prompt_version ?? "Unavailable"],
                    ["Tokens in", String(detail.llm?.tokens_in ?? 0)],
                    ["Tokens out", String(detail.llm?.tokens_out ?? 0)],
                    ["Latency", detail.llm?.latency_ms ? `${detail.llm.latency_ms} ms` : "Unavailable"],
                  ]}
                />
              </div>

              <div className="mt-4 space-y-3">
                <div className="text-xs font-semibold tracking-[0.1em] app-text-muted">Recent logs ({detail.logs?.length ?? 0})</div>
                {detail.logs && detail.logs.length > 0 ? (
                  detail.logs.slice(-8).reverse().map((log, index) => (
                    <article key={log.id ?? `${log.step}-${index}`} className="rounded-2xl app-input px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium app-text-primary">{formatFieldLabel(log.step)}</div>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs app-text-muted">
                            <span>{formatFieldLabel(log.state)}</span>
                            {typeof log.latency_ms === "number" && log.latency_ms > 0 && <span>{log.latency_ms} ms</span>}
                            {log.created_at && <span>{formatDate(log.created_at)}</span>}
                          </div>
                          {log.error && <div className="mt-3 rounded border app-state-error px-2 py-1 text-sm leading-6">{log.error}</div>}
                        </div>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed app-border px-4 py-8 text-center text-sm app-text-muted">
                    No logs were recorded for this email yet.
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] app-input-strong px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      <div className="mt-3 text-sm font-medium app-text-primary">{value}</div>
    </div>
  );
}

function MetaBlock({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-[18px] app-input-strong px-4 py-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{title}</div>
      <div className="mt-4 space-y-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
            <div className="break-words text-sm leading-6 app-text-secondary">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
