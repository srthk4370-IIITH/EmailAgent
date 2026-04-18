"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Database, RefreshCcw, Search } from "lucide-react";

import { EmailList } from "../../components/email/EmailList";
import { EmailMetadataPanel } from "../../components/email/EmailMetadataPanel";
import { EmbeddingViewer, type EmbeddingChunk } from "../../components/email/EmbeddingViewer";
import { QuickReply } from "../../components/email/QuickReply";
import { PageHeader } from "../../components/layout/PageHeader";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";
import type { DetailProps } from "../../components/email/ThreadView";
import type { EmailListItem } from "../../components/email/EmailRow";

type SentTab = "message" | "memory" | "metadata";

type EmbeddingResponse = {
  embeddings?: EmbeddingChunk[];
  count?: number;
  status?: string;
  error?: string | null;
};

type SentDetail = DetailProps & {
  source?: string;
  trace_id?: string | null;
  gmail_id?: string | null;
  last_step?: string | null;
  last_error?: string | null;
  review_outcome?: string | null;
  retry_count?: number | null;
  embedding_status?: string;
  embedding_error?: string | null;
  embedding_chunk_count?: number;
  llm?: {
    prompt_version?: string | null;
    tokens_in?: number | null;
    tokens_out?: number | null;
    latency_ms?: number | null;
  };
  logs?: Array<{ id: number; step: string; state: string; latency_ms: number; error: string | null; created_at: string }>;
};

export default function SentPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [emails, setEmails] = useState<EmailListItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [chunks, setChunks] = useState<EmbeddingChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [embeddingSummary, setEmbeddingSummary] = useState<{ status: string; error?: string | null; count: number }>({
    status: "pending",
    error: null,
    count: 0,
  });
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SentTab>("message");
  const { collapsed: listHeaderCollapsed, handleScrollTop: handleSentListScroll } = useScrollCollapse({ threshold: 56 });

  const loadList = useCallback(async () => {
    const res = await fetch("/api/emails?filter=sent", { credentials: "include" });
    const json = (await res.json()) as { emails?: EmailListItem[] };
    setEmails(json.emails ?? []);
  }, []);

  useEffect(() => {
    void loadList();
    const rawId = searchParams.get("id");
    if (rawId) {
      const parsed = Number(rawId);
      if (Number.isFinite(parsed)) setSelectedId(parsed);
    }
    const timer = setInterval(() => void loadList(), 10000);
    return () => clearInterval(timer);
  }, [loadList, searchParams]);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    setChunksLoading(true);
    try {
      const [resDetail, resChunks] = await Promise.all([
        fetch(`/api/emails/${id}`, { credentials: "include" }),
        fetch(`/api/emails/${id}/embeddings`, { credentials: "include" }),
      ]);
      setDetail((await resDetail.json()) as SentDetail);
      const jsonChunks = (await resChunks.json()) as EmbeddingResponse;
      setChunks(jsonChunks.embeddings ?? []);
      setEmbeddingSummary({
        status: jsonChunks.status ?? "pending",
        error: jsonChunks.error ?? null,
        count: jsonChunks.count ?? 0,
      });
    } catch {
      setDetail(null);
      setChunks([]);
      setEmbeddingSummary({ status: "pending", error: null, count: 0 });
    } finally {
      setDetailLoading(false);
      setChunksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      setChunks([]);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const filteredEmails = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return emails;
    return emails.filter((email) =>
      [email.subject, email.from_email, email.snippet, email.embedding_status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
  }, [emails, query]);

  useEffect(() => {
    if (filteredEmails.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId != null && filteredEmails.some((email) => email.id === selectedId)) return;
    setSelectedId(filteredEmails[0]!.id);
  }, [filteredEmails, selectedId]);

  function openEmail(id: number) {
    setSelectedId(id);
    router.replace(`/sent?id=${id}`);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-[320px_minmax(0,1fr)]">
      <section className="panel-surface flex min-h-0 flex-col overflow-hidden rounded-[24px]">
        <PageHeader
          title="Sent"
          subtitle="Review outbound mail and inspect indexed memory."
          collapsed={listHeaderCollapsed}
          compactLabel="Sent"
          rightAction={
            <button
              type="button"
              onClick={() => void loadList()}
              className="app-button-secondary rounded-full p-2.5 transition"
            >
              <RefreshCcw className="h-4 w-4" />
            </button>
          }
        />

        <div className="border-b app-border px-4 py-3">
          <div className="app-input flex items-center gap-3 rounded-full px-4 py-2.5">
            <Search className="h-4 w-4 app-text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sent mail"
              className="w-full bg-transparent text-sm app-text-primary focus:outline-none"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <EmailList
            emails={filteredEmails}
            selectedId={selectedId}
            onSelect={openEmail}
            showActions={false}
            emptyMessage="No sent mail matched your search."
            onScrollPositionChange={handleSentListScroll}
          />
        </div>
      </section>

      <section className="panel-surface flex min-h-0 flex-col overflow-hidden rounded-[24px]">
        {!selectedId && (
          <SentEmpty title="Select a sent message" body="Open a sent email to review the message and inspect its indexed memory chunks." />
        )}

        {selectedId != null && (
          <>
            <div className="border-b app-border px-5 py-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTab("message")}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    tab === "message" ? "app-button-primary" : "app-button-secondary"
                  }`}
                >
                  Message
                </button>
                <button
                  type="button"
                  onClick={() => setTab("memory")}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
                    tab === "memory" ? "app-button-primary" : "app-button-secondary"
                  }`}
                >
                  <Database className="h-4 w-4" />
                  Memory
                </button>
                <button
                  type="button"
                  onClick={() => setTab("metadata")}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    tab === "metadata" ? "app-button-primary" : "app-button-secondary"
                  }`}
                >
                  Metadata
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden app-bg-soft">
              {detailLoading && <SentEmpty title="Loading" body="Fetching sent message details and memory chunks." />}
              {!detailLoading && tab === "message" && detail && <SentConversationView detail={detail} />}
              {!detailLoading && tab === "memory" && (
                <EmbeddingViewer
                  status={embeddingSummary.status}
                  error={embeddingSummary.error}
                  chunks={chunks}
                  chunkCount={embeddingSummary.count}
                  loading={chunksLoading}
                />
              )}
              {!detailLoading && tab === "metadata" && detail && (
                <EmailMetadataPanel
                  detail={{
                    ...detail,
                    embedding_status: embeddingSummary.status,
                    embedding_error: embeddingSummary.error ?? detail.embedding_error,
                    embedding_chunk_count: embeddingSummary.count,
                  }}
                  title="Sent metadata"
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SentConversationView({ detail }: { detail: SentDetail }) {
  const ordered = [...(detail.thread_messages ?? [])].sort((a, b) => {
    const aDate = typeof a.internal_date === "number" ? a.internal_date : Number(a.internal_date ?? 0);
    const bDate = typeof b.internal_date === "number" ? b.internal_date : Number(b.internal_date ?? 0);
    return (Number.isFinite(aDate) ? aDate : 0) - (Number.isFinite(bDate) ? bDate : 0);
  });

  const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

  const sentBody = normalizeText(detail.reply ?? detail.draft?.edited_body ?? detail.draft?.generated_body ?? detail.body ?? "");
  const sentText = detail.reply ?? detail.draft?.edited_body ?? detail.draft?.generated_body ?? detail.body;
  const sentTime = detail.raw_email?.internal_date ?? null;

  const uniqueMessages = ordered.filter((message, index, all) => {
    const key = `${normalizeText(message.from)}\n${normalizeText(message.subject)}\n${normalizeText(message.body)}\n${message.internal_date ?? "null"}`;
    return all.findIndex((candidate) => {
      const otherKey = `${normalizeText(candidate.from)}\n${normalizeText(candidate.subject)}\n${normalizeText(candidate.body)}\n${candidate.internal_date ?? "null"}`;
      return otherKey === key;
    }) === index;
  });

  const receivedMessages = uniqueMessages
    .filter((message) => normalizeText(message.body) !== sentBody)
    .sort((a, b) => {
      const aDate = typeof a.internal_date === "number" ? a.internal_date : Number(a.internal_date ?? 0);
      const bDate = typeof b.internal_date === "number" ? b.internal_date : Number(b.internal_date ?? 0);
      return (Number.isFinite(aDate) ? aDate : 0) - (Number.isFinite(bDate) ? bDate : 0);
    });

  const sentMessage = sentText
    ? {
        from: "Me",
        internal_date: sentTime,
        body: sentText,
        subject: detail.subject,
      }
    : null;

  const recipientCandidate = [...receivedMessages]
    .reverse()
    .find((message) => /@/.test(message.from))?.from
    ?? [...receivedMessages].reverse().find((message) => message.from.trim().length > 0)?.from
    ?? detail.raw_email?.from
    ?? "";

  const replySeed = detail.draft?.edited_body ?? detail.draft?.generated_body ?? detail.reply ?? "";

  return (
    <div className="h-full overflow-y-auto px-5 py-5 md:px-7 md:py-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header className="rounded-xl border app-border bg-[color:var(--surface-elevated)] px-5 py-4">
          <h2 className="text-xl font-semibold app-text-primary">{detail.subject || "(no subject)"}</h2>
          <p className="mt-1 text-sm app-text-muted">Thread view for sent conversation with quick follow-up reply.</p>
        </header>

        <section className="space-y-4">
          <div className="rounded-xl border app-input-strong px-4 py-3">
            <div className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] app-text-faint">
              Received messages
            </div>
            {receivedMessages.length > 0 ? (
              <div className="space-y-3">
                {receivedMessages.map((message, index) => (
                  <article key={`${message.internal_date}-${index}`} className="rounded-lg border app-input-strong px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] app-text-faint">Received message</div>
                      <div className="text-[11px] app-text-faint">
                        {message.internal_date ? new Date(Number(message.internal_date)).toLocaleString() : "Unknown time"}
                      </div>
                    </div>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap app-text-secondary">{message.body}</div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="text-sm app-text-muted">No received messages were found in this thread.</div>
            )}
          </div>

          {sentMessage && (
            <article className="rounded-xl border border-[color:var(--accent-primary-strong)] bg-[color:color-mix(in_srgb,var(--accent-primary) 10%,var(--surface-elevated) 90%)] px-4 py-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] app-text-primary">
                  My sent message
                </div>
                <div className="text-[11px] app-text-faint">
                  {sentTime ? new Date(Number(sentTime)).toLocaleString() : "Unknown time"}
                </div>
              </div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap app-text-secondary">{sentMessage.body}</div>
            </article>
          )}
        </section>

        <QuickReply
          emailId={detail.id}
          threadId={detail.raw_email?.thread_id ?? ""}
          subject={detail.subject}
          to={recipientCandidate}
          initialText={replySeed}
        />
      </div>
    </div>
  );
}

function SentEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full app-accent-bg">
        <Database className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-xl font-semibold app-text-primary">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed app-text-muted">{body}</p>
    </div>
  );
}
