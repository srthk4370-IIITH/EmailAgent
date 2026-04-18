"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCcw, Search, WandSparkles, XCircle } from "lucide-react";

import { badgeForState } from "../../lib/uiBadges";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";

type Row = {
  id: number;
  subject: string;
  state: string;
  from_email: string;
  decision: string | null;
  review_outcome: string | null;
  internal_date: number | null;
  snippet: string | null;
};

function formatTime(ms: number | null): string {
  if (ms == null) return "Unknown";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "Unknown";
  }
}

export default function RejectedPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const { collapsed: heroCollapsed, onScroll: onRejectedScroll } = useScrollCollapse({ threshold: 72 });

  const load = useCallback(async () => {
    const res = await fetch("/api/emails?filter=rejected", { credentials: "include" });
    const json = (await res.json()) as { emails?: Row[] };
    setRows(json.emails ?? []);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [load]);

  async function handleGenerateDraft(emailId: number) {
    setUiError(null);
    setActionLoadingId(emailId);
    try {
      const res = await fetch(`/api/emails/${emailId}/generate-draft`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = typeof data?.error === "string" ? data.error : "Generate draft failed";
        throw new Error(msg);
      }
      await load();
    } catch (err) {
      setUiError(err instanceof Error ? err.message : "Generate draft failed");
    } finally {
      setActionLoadingId(null);
    }
  }

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.subject, row.from_email, row.snippet, row.state, row.decision]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [query, rows]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" onScroll={onRejectedScroll}>
      {!heroCollapsed && (
        <section className="panel-surface rounded-[18px] px-5 py-5 md:px-6 md:py-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-accent-text">Rejected queue</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">Keep rejected conversations visible and recoverable.</h1>
            <p className="mt-4 text-sm leading-7 app-text-secondary">
              Nothing disappears after rejection. Search the queue, inspect earlier outcomes, and regenerate drafts when needed.
            </p>
          </div>
          <div className="app-input-strong rounded-[18px] px-5 py-5">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Rejected items</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">{filteredRows.length}</div>
          </div>
        </div>
        </section>
      )}

      <section className="panel-surface rounded-[24px] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="app-input flex flex-1 items-center gap-3 rounded-full px-4 py-3">
            <Search className="h-4 w-4 app-text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search rejected items"
              className="w-full bg-transparent text-sm app-text-primary focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm font-medium transition"
          >
            <RefreshCcw className="h-4 w-4 app-accent-text" />
            Refresh
          </button>
        </div>
      </section>

      <section className="panel-surface rounded-[24px] p-5">
        <div className="space-y-4">
          {filteredRows.length === 0 && (
            <div className="rounded-[18px] border border-dashed app-border px-6 py-16 text-center app-text-muted">
              No rejected items match your search.
            </div>
          )}
          {filteredRows.map((row) => (
            <article key={row.id} className="app-input rounded-[20px] px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-medium app-text-primary">{row.subject || "(no subject)"}</div>
                  <div className="mt-1 text-sm app-text-muted">{row.from_email}</div>
                  <div className="mt-1 text-xs app-text-muted">{formatTime(row.internal_date)}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${badgeForState(row.state)}`}>{row.state}</span>
                  <span className="rounded-full app-state-error px-3 py-1 text-xs font-medium">Rejected</span>
                </div>
              </div>

              {row.snippet && (
                <p className="app-input-strong mt-4 rounded-[18px] px-4 py-4 text-sm leading-7 app-text-secondary">
                  {row.snippet}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => router.push(`/inbox?id=${row.id}&view=all`)}
                  className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition"
                >
                  Open thread
                </button>

                {row.state === "READY_TO_GENERATE" && row.decision === "manual" && (
                  <button
                    type="button"
                    disabled={actionLoadingId === row.id}
                    onClick={() => void handleGenerateDraft(row.id)}
                    className="app-action-warning inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition disabled:opacity-40"
                  >
                    <WandSparkles className="h-4 w-4" />
                    {actionLoadingId === row.id ? "Generating..." : "Generate draft"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>

        {uiError && (
          <div className="mt-4 rounded-lg app-state-error border p-4 text-sm">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4" />
              {uiError}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
