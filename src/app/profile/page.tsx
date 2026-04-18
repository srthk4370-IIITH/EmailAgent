"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, BarChart3, BrainCircuit, CheckCircle2, Mail, RefreshCcw, RotateCcw, ShieldAlert, ShieldCheck, Unplug } from "lucide-react";
import { PageHeader } from "../../components/layout/PageHeader";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";

type ProfileSummary = {
  connected_email: string | null;
  services: {
    gmail: boolean;
    supabase: boolean;
    openai: boolean;
  };
  usage: {
    total_emails_processed: number;
    total_embeddings: number;
    sent_emails: number;
    embedded_sent_emails: number;
  };
  jobs: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  rag: {
    sampled_emails: number;
    avg_confidence: number;
    strong_confidence_rate: number;
    low_confidence_rate: number;
    conflict_rate: number;
    context_hit_rate: number;
    avg_context_items: number;
    trace_samples_14d: number;
    unknown_intent_rate: number;
    retrieval_failure_rate: number;
    usage_failure_rate: number;
    synthesis_failure_rate: number;
    top_intents: Array<{ intent: string; count: number }>;
  };
  embedding_integrity: {
    total_chunks: number;
    embedded_email_count: number;
    policy_valid_chunks: number;
    invalid_chunks: number;
    invalid_non_sent_chunks: number;
    invalid_untouched_app_chunks: number;
    invalid_unverified_sent_chunks: number;
    purity_score: number;
    invalid_samples: Array<{
      email_id: number;
      source: string;
      subject: string;
      updated_at: string;
      chunk_count: number;
      reason: string;
    }>;
  };
  workspace_gmail_connection: boolean;
  recent_failed_jobs?: { id: number; last_error: string; attempts: number; updated_at: string }[];
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function formatIntegrityReason(reason: string): string {
  if (reason === "non_sent_source") return "Non-sent source";
  if (reason === "untouched_app_generated") return "Untouched app send";
  if (reason === "unverified_sent_metadata") return "Missing sent metadata";
  return "Unknown";
}

export default function ProfilePage() {
  const [summary, setSummary] = useState<ProfileSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { collapsed: heroCollapsed, onScroll: onProfileScroll } = useScrollCollapse({ threshold: 72 });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/profile/summary", { credentials: "include" });
      const json = (await res.json()) as ProfileSummary;
      setSummary(json);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runAction(key: string, runner: () => Promise<string>) {
    setActionLoading(key);
    setNotice(null);
    try {
      const message = await runner();
      setNotice(message);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  }

  const health = useMemo(
    () =>
      summary
        ? [
            { label: "Gmail", ok: summary.services.gmail },
            { label: "Supabase", ok: summary.services.supabase },
            { label: "OpenAI", ok: summary.services.openai },
          ]
        : [],
    [summary],
  );

  const ragSummary = summary?.rag;
  const integritySummary = summary?.embedding_integrity;
  const ragConfidence = clamp01(ragSummary?.avg_confidence ?? 0);
  const ragCredibilityOk = ragConfidence >= 0.65;
  const integrityPurity = clamp01(integritySummary?.purity_score ?? 1);
  const integrityOk = integrityPurity >= 0.98;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[color:var(--surface-secondary)] px-4 py-4 md:px-8 md:py-6" onScroll={onProfileScroll}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <PageHeader
          title="Profile"
          subtitle="Connection health, memory ops, and safe maintenance in one minimal surface."
          collapsed={heroCollapsed}
          compactLabel="Workspace control"
          className="rounded-[20px] bg-[color:var(--surface-elevated)] shadow-sm"
          rightAction={
            <button
              type="button"
              onClick={() => void refresh()}
              className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs"
            >
              <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          }
        />

        <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <div className="rounded-[20px] bg-[color:var(--surface-elevated)] px-6 py-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="app-accent-bg flex h-10 w-10 items-center justify-center rounded-full">
                <Mail className="h-4 w-4" />
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">Active identity</div>
                <div className="mt-1 text-sm font-medium app-text-primary">{summary?.connected_email ?? "No active session"}</div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {health.map((item) => (
                <div key={item.label} className="flex items-center justify-between rounded-xl app-input px-3 py-2 text-sm">
                  <span className="app-text-secondary">{item.label}</span>
                  <StatusPill ok={item.ok} />
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[20px] bg-[color:var(--surface-elevated)] px-6 py-6 shadow-sm">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Processed" value={summary?.usage.total_emails_processed ?? 0} />
              <MetricCard label="Embeddings" value={summary?.usage.total_embeddings ?? 0} />
              <MetricCard label="Sent" value={summary?.usage.sent_emails ?? 0} />
              <MetricCard label="Queued" value={(summary?.jobs.pending ?? 0) + (summary?.jobs.processing ?? 0)} />
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <ActionCard
            title="Re-sync sent history"
            description="Import another Gmail sent batch and skip duplicates."
            actionLabel="Run"
            loading={actionLoading === "resync"}
            onClick={() =>
              runAction("resync", async () => {
                const res = await fetch("/api/sync/backfill", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ limit: 100 }),
                });
                const data = (await res.json()) as { inserted?: number; skipped?: number; error?: string };
                if (!res.ok) throw new Error(data.error || "Failed to re-sync Gmail");
                return `Imported ${data.inserted ?? 0} and skipped ${data.skipped ?? 0}.`;
              })
            }
            icon={<RefreshCcw className="h-4 w-4" />}
          />

          <ActionCard
            title="Re-index memory"
            description="Queue pending and failed memory jobs again."
            actionLabel="Queue"
            loading={actionLoading === "reindex"}
            onClick={() =>
              runAction("reindex", async () => {
                const res = await fetch("/api/profile/reindex", { method: "POST" });
                const data = (await res.json()) as { queued?: number; error?: string };
                if (!res.ok) throw new Error(data.error || "Failed to queue re-index jobs");
                return `Queued ${data.queued ?? 0} emails.`;
              })
            }
            icon={<RotateCcw className="h-4 w-4" />}
          />

          <ActionCard
            title="Disconnect guidance"
            description="Show current Gmail disconnect limitations for this workspace."
            actionLabel="Review"
            loading={actionLoading === "disconnect"}
            onClick={() =>
              runAction("disconnect", async () => {
                const res = await fetch("/api/profile/disconnect-gmail", { method: "POST" });
                const data = (await res.json()) as { message?: string };
                return data.message || "Disconnect guidance loaded.";
              })
            }
            icon={<Unplug className="h-4 w-4" />}
          />

          <ActionCard
            title="Repair memory integrity"
            description="Delete non-policy chunks so only sent/manual-or-edited memory remains retrievable."
            actionLabel="Repair"
            loading={actionLoading === "repair"}
            onClick={() =>
              runAction("repair", async () => {
                const res = await fetch("/api/profile/repair-embeddings", { method: "POST" });
                const data = (await res.json()) as {
                  removed_chunks?: number;
                  affected_emails?: number;
                  status?: string;
                  error?: string;
                };
                if (!res.ok) throw new Error(data.error || "Failed to repair embedding integrity");
                if ((data.removed_chunks ?? 0) === 0) {
                  return "Memory was already clean. No invalid chunks found.";
                }
                return `Removed ${data.removed_chunks ?? 0} invalid chunks across ${data.affected_emails ?? 0} emails.`;
              })
            }
            icon={<ShieldCheck className="h-4 w-4" />}
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-[20px] bg-[color:var(--surface-elevated)] px-6 py-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">
                <BrainCircuit className="h-4 w-4" />
                RAG credibility
              </div>
              <StatusPill ok={ragCredibilityOk} label={ragCredibilityOk ? "Strong" : "Needs tuning"} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <MetricCard label="Avg confidence" value={toPercent(ragConfidence)} />
              <MetricCard label="Context hit rate" value={toPercent(ragSummary?.context_hit_rate ?? 0)} />
              <MetricCard label="Low confidence" value={toPercent(ragSummary?.low_confidence_rate ?? 0)} />
              <MetricCard label="Conflicts" value={toPercent(ragSummary?.conflict_rate ?? 0)} />
            </div>

            <div className="mt-4 space-y-2">
              <RatioBar label="Unknown intent" value={ragSummary?.unknown_intent_rate ?? 0} tone="warn" />
              <RatioBar label="Retrieval failures" value={ragSummary?.retrieval_failure_rate ?? 0} tone="warn" />
              <RatioBar label="Usage failures" value={ragSummary?.usage_failure_rate ?? 0} tone="warn" />
              <RatioBar label="Synthesis failures" value={ragSummary?.synthesis_failure_rate ?? 0} tone="warn" />
            </div>

            <div className="mt-4 rounded-xl app-input px-4 py-3 text-xs app-text-secondary">
              <div>Inbound sample window: {ragSummary?.sampled_emails ?? 0} emails</div>
              <div className="mt-1">Trace window (14d): {ragSummary?.trace_samples_14d ?? 0} runs</div>
            </div>

            <div className="mt-4">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">
                <BarChart3 className="h-4 w-4" />
                Intent mix (14d)
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(ragSummary?.top_intents ?? []).length === 0 ? (
                  <span className="rounded-full app-input px-3 py-1 text-xs app-text-secondary">No trace activity yet</span>
                ) : (
                  (ragSummary?.top_intents ?? []).map((item) => (
                    <span key={`${item.intent}-${item.count}`} className="rounded-full app-input px-3 py-1 text-xs app-text-secondary">
                      {item.intent.replace(/_/g, " ")} ({item.count})
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="rounded-[20px] bg-[color:var(--surface-elevated)] px-6 py-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">
                <ShieldAlert className="h-4 w-4" />
                Embedding integrity
              </div>
              <StatusPill ok={integrityOk} label={integrityOk ? "Clean" : "Policy drift"} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <MetricCard label="Purity score" value={toPercent(integrityPurity)} />
              <MetricCard label="Embedded emails" value={integritySummary?.embedded_email_count ?? 0} />
              <MetricCard label="Valid chunks" value={integritySummary?.policy_valid_chunks ?? 0} />
              <MetricCard label="Invalid chunks" value={integritySummary?.invalid_chunks ?? 0} />
            </div>

            <div className="mt-4 space-y-2">
              <RatioBar
                label="Valid policy share"
                value={
                  (integritySummary?.total_chunks ?? 0) > 0
                    ? (integritySummary?.policy_valid_chunks ?? 0) / Math.max(1, integritySummary?.total_chunks ?? 1)
                    : 1
                }
                tone="good"
              />
              <RatioBar
                label="Non-sent chunks"
                value={
                  (integritySummary?.total_chunks ?? 0) > 0
                    ? (integritySummary?.invalid_non_sent_chunks ?? 0) / Math.max(1, integritySummary?.total_chunks ?? 1)
                    : 0
                }
                tone="warn"
              />
              <RatioBar
                label="Untouched app-generated"
                value={
                  (integritySummary?.total_chunks ?? 0) > 0
                    ? (integritySummary?.invalid_untouched_app_chunks ?? 0) / Math.max(1, integritySummary?.total_chunks ?? 1)
                    : 0
                }
                tone="warn"
              />
            </div>

            {(integritySummary?.invalid_samples ?? []).length > 0 && (
              <div className="mt-4 overflow-hidden rounded-xl border app-border">
                <table className="w-full text-left text-xs">
                  <thead className="app-input">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Reason</th>
                      <th className="px-3 py-2 font-semibold text-center">Chunks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y app-border">
                    {(integritySummary?.invalid_samples ?? []).map((sample) => (
                      <tr key={sample.email_id}>
                        <td className="max-w-[220px] truncate px-3 py-2 app-text-secondary" title={sample.subject}>
                          #{sample.email_id} - {sample.subject}
                        </td>
                        <td className="px-3 py-2 app-text-muted">{formatIntegrityReason(sample.reason)}</td>
                        <td className="px-3 py-2 text-center app-text-primary">{sample.chunk_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {summary?.recent_failed_jobs && summary.recent_failed_jobs.length > 0 && (
          <section className="rounded-[20px] bg-[color:var(--surface-elevated)] px-6 py-6 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] app-text-faint">Recent failed jobs</div>
            <div className="mt-3 overflow-hidden rounded-xl border app-border">
              <table className="w-full text-left text-xs">
                <thead className="app-input">
                  <tr>
                    <th className="px-4 py-2 font-semibold">ID</th>
                    <th className="px-4 py-2 font-semibold">Error</th>
                    <th className="px-4 py-2 font-semibold text-center">Retries</th>
                  </tr>
                </thead>
                <tbody className="divide-y app-border">
                  {summary.recent_failed_jobs.map((job) => (
                    <tr key={job.id}>
                      <td className="px-4 py-3 app-text-muted">{job.id}</td>
                      <td className="max-w-[380px] truncate px-4 py-3 app-text-secondary" title={job.last_error}>{job.last_error}</td>
                      <td className="px-4 py-3 text-center app-text-primary">{job.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {notice && (
          <section className="rounded-[16px] border app-border bg-[color:var(--surface-elevated)] px-4 py-3 text-sm">
            <div className="inline-flex items-start gap-2 app-text-secondary">
              <AlertTriangle className="mt-0.5 h-4 w-4 app-accent-text" />
              <span>{notice}</span>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
      style={{
        background: ok ? "var(--success-soft)" : "var(--warning-soft)",
        color: ok ? "var(--success)" : "var(--warning)",
      }}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {label ?? (ok ? "Ready" : "Check")}
    </span>
  );
}

function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl app-input px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.1em] app-text-faint">{label}</div>
      <div className="mt-2 text-2xl font-semibold app-text-primary">{value}</div>
    </div>
  );
}

function RatioBar({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "accent";
}) {
  const clamped = clamp01(value);
  const fillColor = tone === "good" ? "var(--success)" : tone === "warn" ? "var(--warning)" : "var(--accent)";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs app-text-secondary">
        <span>{label}</span>
        <span>{toPercent(clamped)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full app-input">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${Math.round(clamped * 100)}%`, background: fillColor }} />
      </div>
    </div>
  );
}

function ActionCard({
  title,
  description,
  actionLabel,
  loading,
  onClick,
  icon,
}: {
  title: string;
  description: string;
  actionLabel: string;
  loading: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-[20px] bg-[color:var(--surface-elevated)] px-5 py-5 shadow-sm">
      <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.1em] app-text-faint">{icon} Action</div>
      <div className="mt-3 text-lg font-semibold app-text-primary">{title}</div>
      <p className="mt-2 text-sm app-text-secondary">{description}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="app-button-primary mt-4 rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-40"
      >
        {loading ? "Working" : actionLabel}
      </button>
    </div>
  );
}
