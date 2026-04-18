"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Edit3, Loader2, Search, Send, XCircle } from "lucide-react";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";
import { InlineErrorCard } from "../../components/errors/InlineErrorCard";
import type { AppError } from "../../lib/errorNormalizer";
import { fetchJsonWithAppError, toAppError } from "../../lib/fetchWithAppError";

type Draft = {
  id: number;
  email_id: number;
  reply: string;
  edited_body: string | null;
  status: string;
  email_subject: string | null;
  email_from: string | null;
};

export default function DraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [query, setQuery] = useState("");
  const { collapsed: heroCollapsed, onScroll: onDraftsScroll } = useScrollCollapse({ threshold: 72 });

  const load = useCallback(async () => {
    try {
      const data = await fetchJsonWithAppError<{ drafts?: Draft[] }>("/api/drafts?active=1", { credentials: "include" }, { retries: 1 });
      setDrafts(data.drafts ?? []);
      setError(null);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function saveEdit(id: number) {
    setBusy(id);
    try {
      await fetchJsonWithAppError(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ edited_body: editText }),
      });
      setEditId(null);
      setError(null);
      await load();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(null);
    }
  }

  async function approve(id: number) {
    setBusy(id);
    try {
      await fetchJsonWithAppError(`/api/drafts/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      setError(null);
      await load();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: number) {
    setBusy(id);
    try {
      await fetchJsonWithAppError(`/api/drafts/${id}/reject`, { method: "POST", credentials: "include" });
      setError(null);
      await load();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(null);
    }
  }

  const filteredDrafts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter((draft) =>
      [draft.email_subject, draft.email_from, draft.reply, draft.edited_body, draft.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [drafts, query]);

  const pending = filteredDrafts.filter((draft) => draft.status === "pending");
  const approved = filteredDrafts.filter((draft) => draft.status === "approved");

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" onScroll={onDraftsScroll}>
      {error && (
        <InlineErrorCard
          error={error}
          onRetry={async () => {
            await load();
          }}
        />
      )}

      {!heroCollapsed && (
        <section className="panel-surface rounded-[18px] px-5 py-5 md:px-6 md:py-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-accent-text">Draft review</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">Keep review fast, calm, and fully controllable.</h1>
            <p className="mt-4 text-sm leading-7 app-text-secondary">
              Edit generated replies, approve ready drafts, and reject anything that should not be sent.
            </p>
          </div>
          <div className="grid min-w-[260px] gap-3 sm:grid-cols-2">
            <StatCard label="Pending" value={pending.length} />
            <StatCard label="Approved" value={approved.length} />
          </div>
        </div>
        </section>
      )}

      <section className="panel-surface rounded-[24px] p-4">
        <div className="app-input flex items-center gap-3 rounded-full px-4 py-3">
          <Search className="h-4 w-4 app-text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search drafts"
            className="w-full bg-transparent text-sm app-text-primary focus:outline-none"
          />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="panel-surface rounded-[24px] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Pending queue</div>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight app-text-primary">Drafts waiting for review</h2>
            </div>
            {loading && <Loader2 className="h-5 w-5 animate-spin app-accent-text" />}
          </div>

          <div className="mt-5 grid gap-4">
            {pending.length === 0 && !loading && <EmptyPanel title="No pending drafts" body="New drafts will appear here when generation completes." />}
            {pending.map((draft) => (
              <article key={draft.id} className="app-input rounded-[20px] px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-base font-medium app-text-primary">{draft.email_subject ?? `Email #${draft.email_id}`}</div>
                    <div className="mt-1 truncate text-sm app-text-muted">
                      {draft.email_from ? draft.email_from : <span className="italic">Unknown sender</span>}
                    </div>
                  </div>
                  <span className="rounded-full app-state-awaiting px-3 py-1 text-xs font-medium">Pending</span>
                </div>

                {editId === draft.id ? (
                  <textarea
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                    rows={10}
                    className="app-input-strong app-focus-ring mt-4 w-full rounded-[18px] px-4 py-3 text-sm leading-7 app-text-secondary"
                  />
                ) : (
                  <p className="app-input-strong mt-4 whitespace-pre-wrap rounded-[18px] px-4 py-4 text-sm leading-7 app-text-secondary">
                    {draft.edited_body ?? draft.reply}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  {editId === draft.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy === draft.id}
                        onClick={() => void saveEdit(draft.id)}
                        className="app-button-primary rounded-full px-4 py-2.5 text-sm font-medium transition disabled:opacity-40"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditId(null)}
                        className="app-button-secondary rounded-full px-4 py-2.5 text-sm font-medium transition"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditId(draft.id);
                        setEditText(draft.edited_body ?? draft.reply);
                      }}
                      className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition"
                    >
                      <Edit3 className="h-4 w-4 app-accent-text" />
                      Edit
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busy === draft.id || editId === draft.id}
                    onClick={() => void approve(draft.id)}
                    className="app-button-success app-action-approve inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition disabled:opacity-40"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Approve
                  </button>

                  <button
                    type="button"
                    disabled={busy === draft.id || editId === draft.id}
                    onClick={() => void reject(draft.id)}
                    className="app-button-danger app-action-reject inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition disabled:opacity-40"
                  >
                    <XCircle className="h-4 w-4" />
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="panel-surface rounded-[24px] p-5">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Approved</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight app-text-primary">Ready to send</h2>

          <div className="mt-5 space-y-3">
            {approved.length === 0 && !loading && <EmptyPanel title="No approved drafts" body="Approved drafts will appear here before they leave the queue." />}
            {approved.map((draft) => (
              <div key={draft.id} className="app-input rounded-[18px] px-4 py-4">
                <div className="text-sm font-medium app-text-primary">{draft.email_subject ?? `Email #${draft.email_id}`}</div>
                <div className="mt-1 text-xs app-text-muted">
                  {draft.email_from ? draft.email_from : <span className="italic">Unknown sender</span>}
                </div>
                <div className="mt-3 inline-flex items-center gap-2 rounded-full app-state-ready px-3 py-1 text-xs font-medium">
                  <Send className="h-3.5 w-3.5" />
                  Approved
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="app-input-strong rounded-[18px] px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">{value}</div>
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[18px] border border-dashed app-border px-5 py-10 text-center">
      <div className="text-base font-medium app-text-primary">{title}</div>
      <div className="mt-2 text-sm leading-6 app-text-muted">{body}</div>
    </div>
  );
}
