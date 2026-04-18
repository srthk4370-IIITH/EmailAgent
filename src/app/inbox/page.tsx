"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  BellRing,
  ChevronDown,
  ExternalLink,
  Filter,
  Loader2,
  RefreshCcw,
  Search,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";

import { EmailList } from "../../components/email/EmailList";
import type { EmailListItem } from "../../components/email/EmailRow";
import { EmailMetadataPanel } from "../../components/email/EmailMetadataPanel";
import { ThreadDocument } from "../../components/email/ThreadDocument";
import { InlineErrorCard } from "../../components/errors/InlineErrorCard";
import { PageHeader } from "../../components/layout/PageHeader";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";
import type { AppError } from "../../lib/errorNormalizer";
import { fetchJsonWithAppError, toAppError } from "../../lib/fetchWithAppError";
import { getCategoryTone } from "../../lib/mailVisuals";

type StageView = "all" | "ready" | "generated" | "needs_review" | "drafted";
type ReadFilter = "all" | "unread" | "read";

type InboxListItem = EmailListItem;

type Detail = {
  id: number;
  gmail_id?: string | null;
  category?: string | null;
  decision?: string | null;
  state?: string | null;
  last_step?: string | null;
  raw_email?: {
    thread_id?: string | null;
  };
  logs?: Array<{ id: number; step?: string | null; error?: string | null }>;
};

type AccountOption = {
  id: number;
  email: string;
};

type RuntimeConfig = {
  global_mode?: "manual" | "assist" | "auto";
  category_colors?: Record<string, string>;
};

type ToastItem = {
  id: number;
  title: string;
  body: string;
  tone: "info" | "success" | "warning";
};

type InboxCachePayload = {
  emails: InboxListItem[];
  nextCursor: { date: number; id: number } | null;
  cachedAt: number;
};

const INBOX_CACHE_PREFIX = "inbox:list:v2";

const stages: Array<{ id: StageView; label: string; matcher: (email: InboxListItem) => boolean }> = [
  { id: "all", label: "All", matcher: () => true },
  { id: "ready", label: "Ready", matcher: (email) => String(email.state ?? "").toUpperCase().includes("READY") },
  { id: "generated", label: "Generated", matcher: (email) => String(email.state ?? "").toUpperCase().includes("GENERATED") },
  { id: "needs_review", label: "Needs review", matcher: (email) => String(email.state ?? "").toUpperCase().includes("REVIEW") },
  { id: "drafted", label: "Drafted", matcher: (email) => Boolean(email.draft?.id) },
];

function parseStage(raw: string | null): StageView {
  if (raw && stages.some((stage) => stage.id === raw)) return raw as StageView;
  return "all";
}

function dedupeEmailsById(items: InboxListItem[]) {
  const map = new Map<number, InboxListItem>();
  for (const item of items) map.set(item.id, item);
  return Array.from(map.values());
}

function buildGmailUrl(email: { thread_id?: string | null | undefined; gmail_id?: string | null | undefined }): string | null {
  const threadId = (email.thread_id ?? "").trim();
  if (threadId) {
    return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
  }

  const gmailId = (email.gmail_id ?? "").trim();
  if (gmailId) {
    return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(gmailId)}`;
  }

  return null;
}

function normalizeInboxItem(item: Partial<InboxListItem> & { id: number }): InboxListItem {
  const normalized: EmailListItem = {
    id: item.id,
    subject: item.subject ?? "(no subject)",
    state: item.state ?? "UNKNOWN",
    internal_date: item.internal_date ?? null,
    snippet: item.snippet ?? null,
    category: item.category ?? null,
  };

  if (item.from_email != null) normalized.from_email = item.from_email;
  if (item.gmail_id != null) normalized.gmail_id = item.gmail_id;
  if (item.thread_id != null) normalized.thread_id = item.thread_id;
  if (item.is_seen !== undefined) normalized.is_seen = item.is_seen;
  if (item.last_step != null) normalized.last_step = item.last_step;
  if (item.embedding_status != null) normalized.embedding_status = item.embedding_status;
  if (item.embedding_error != null) normalized.embedding_error = item.embedding_error;
  if (item.embedding_chunk_count != null) normalized.embedding_chunk_count = item.embedding_chunk_count;
  if (item.confidence != null) normalized.confidence = item.confidence;
  if (item.risk_score != null) normalized.risk_score = item.risk_score;
  if (item.risk_level != null) normalized.risk_level = item.risk_level;
  if (item.tone_consistency != null) normalized.tone_consistency = item.tone_consistency;
  if (item.rag_confidence != null) normalized.rag_confidence = item.rag_confidence;
  if (item.rag_strength != null) normalized.rag_strength = item.rag_strength;
  if (item.decision_reason != null) normalized.decision_reason = item.decision_reason;
  if (item.draft != null) normalized.draft = item.draft;

  return normalized;
}

function inboxCacheKey(accountId: number | null): string {
  return `${INBOX_CACHE_PREFIX}:${accountId ?? "all"}`;
}

function readInboxCache(accountId: number | null): InboxCachePayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(inboxCacheKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InboxCachePayload> | null;
    if (!parsed || !Array.isArray(parsed.emails)) return null;
    const emails = parsed.emails
      .map((item) => normalizeInboxItem(item as Partial<InboxListItem> & { id: number }))
      .filter((item) => Number.isFinite(item.id));
    return {
      emails,
      nextCursor:
        parsed.nextCursor && Number.isFinite(parsed.nextCursor.date) && Number.isFinite(parsed.nextCursor.id)
          ? { date: Number(parsed.nextCursor.date), id: Number(parsed.nextCursor.id) }
          : null,
      cachedAt: Number(parsed.cachedAt ?? Date.now()),
    };
  } catch {
    return null;
  }
}

function writeInboxCache(accountId: number | null, payload: InboxCachePayload): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(inboxCacheKey(accountId), JSON.stringify(payload));
  } catch {
    // Cache is best-effort only.
  }
}

function EmailDetailSkeleton() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 py-10 text-sm app-text-muted">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading thread...
    </div>
  );
}

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [emails, setEmails] = useState<InboxListItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [uiError, setUiError] = useState<AppError | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [stageView, setStageView] = useState<StageView>(() => parseStage(searchParams.get("view")));
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [generateDrawerOpen, setGenerateDrawerOpen] = useState(false);
  const [stageMenuOpen, setStageMenuOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [seenLogIds, setSeenLogIds] = useState<number[]>([]);
  const [nextCursor, setNextCursor] = useState<{ date: number; id: number } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { collapsed: heroCollapsed, handleScrollTop: handleListScrollTop } = useScrollCollapse({ threshold: 56 });

  const pushToast = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev.slice(-3), { id, ...toast }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 4500);
  }, []);

  const refreshAccounts = useCallback(async () => {
    const res = await fetch("/api/system/accounts", { credentials: "include" });
    const data = await res.json();
    const list = Array.isArray(data.accounts) ? (data.accounts as AccountOption[]) : [];
    setAccounts(list);

    const local = Number(localStorage.getItem("activeAccountId"));
    const chosen = Number.isFinite(local) && local > 0 ? local : Number.isFinite(data.activeAccountId) ? Number(data.activeAccountId) : list[0]?.id ?? null;
    if (chosen != null) setAccountId(chosen);
  }, []);

  const refreshRuntimeConfig = useCallback(async () => {
    const res = await fetch("/api/config", { credentials: "include" });
    const data = (await res.json().catch(() => null)) as RuntimeConfig | null;
    if (data && (data.global_mode === "manual" || data.global_mode === "assist" || data.global_mode === "auto")) {
      setRuntimeConfig(data);
    }
  }, []);

  const refreshList = useCallback(
    async (cursor?: { date: number; id: number }) => {
      const isInitial = !cursor;
      if (isInitial && !readInboxCache(accountId)) setListLoading(true);

      try {
        const url = new URL("/api/emails", window.location.origin);
        url.searchParams.set("filter", "inbox");
        if (accountId != null) url.searchParams.set("accountId", String(accountId));
        if (cursor) {
          url.searchParams.set("cursorDate", String(cursor.date));
          url.searchParams.set("cursorId", String(cursor.id));
        }
        url.searchParams.set("limit", "20");

        const json = await fetchJsonWithAppError<{ emails?: InboxListItem[]; nextCursor?: { date: number; id: number } | null }>(
          url.toString(),
          { credentials: "include" },
          { retries: 1 },
        );
        const incoming = (json.emails ?? []).map((item) => normalizeInboxItem(item as Partial<InboxListItem> & { id: number }));
        setEmails((prev) => {
          const next = cursor ? dedupeEmailsById([...prev, ...incoming]) : dedupeEmailsById(incoming);
          if (!cursor) {
            writeInboxCache(accountId, {
              emails: next,
              nextCursor: json.nextCursor ?? null,
              cachedAt: Date.now(),
            });
          }
          return next;
        });
        setNextCursor(json.nextCursor ?? null);
        setHasMore(Boolean(json.nextCursor));
        setUiError(null);
      } catch (error) {
        setUiError(toAppError(error));
      } finally {
        if (isInitial) setListLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    const cached = readInboxCache(accountId);
    if (!cached) return;
    setEmails(cached.emails);
    setNextCursor(cached.nextCursor);
    setHasMore(Boolean(cached.nextCursor));
    setListLoading(false);
  }, [accountId]);

  useEffect(() => {
    void refreshAccounts();
    void refreshRuntimeConfig();
    void refreshList();
  }, [refreshAccounts, refreshRuntimeConfig, refreshList]);

  useEffect(() => {
    function tick() {
      if (document.visibilityState !== "visible") return;
      void refreshList();
    }

    function onVisible() {
      if (document.visibilityState !== "visible") return;
      void refreshAccounts();
      void refreshRuntimeConfig();
      void refreshList();
    }

    const timer = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAccounts, refreshRuntimeConfig, refreshList]);

  useEffect(() => {
    function onAccountChange(event: Event) {
      const custom = event as CustomEvent<{ accountId?: number }>;
      const id = Number(custom.detail?.accountId ?? NaN);
      if (Number.isFinite(id) && id > 0) setAccountId(id);
    }

    window.addEventListener("active-account-changed", onAccountChange as EventListener);
    return () => window.removeEventListener("active-account-changed", onAccountChange as EventListener);
  }, []);

  useEffect(() => {
    const rawId = searchParams.get("id");
    const rawView = searchParams.get("view");
    setStageView(parseStage(rawView));
    if (rawId) {
      const parsed = Number(rawId);
      if (Number.isFinite(parsed)) setSelectedId(parsed);
    }
  }, [searchParams]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      const editable =
        target != null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (editable) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const detailCache = useMemo(() => new Map<number, Detail>(), []);

  const loadDetail = useCallback(
    async (id: number, background = false) => {
      if (!background) {
        const cached = detailCache.get(id);
        if (cached) {
          setDetail(cached);
          background = true;
        } else {
          setDetailLoading(true);
        }
      }

      try {
        const payload = await fetchJsonWithAppError<unknown>(`/api/emails/${id}`, { credentials: "include" }, { retries: 1 });
        if (typeof payload !== "object" || payload == null || !("id" in payload)) {
          throw new Error("Failed to load email detail");
        }
        const parsed = payload as Detail;
        detailCache.set(id, parsed);
        setDetail(parsed);
        setUiError(null);
      } catch (error) {
        if (!background) {
          setDetail(null);
          setUiError(toAppError(error));
        }
      } finally {
        if (!background) setDetailLoading(false);
      }
    },
    [detailCache],
  );

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (!detail?.logs?.length) return;
    const latest = detail.logs[detail.logs.length - 1];
    if (!latest || seenLogIds.includes(latest.id)) return;

    const step = latest.step ?? "";
    if (step === "auto_mode_approve" || step === "auto_ready_to_send") {
      pushToast({ title: "Auto mode advanced draft", body: "Draft moved to ready-to-send automatically.", tone: "info" });
    } else if (step === "send_skipped_dry_mode") {
      pushToast({ title: "Auto-send queued", body: "Email reached send stage, but dry mode prevented delivery.", tone: "success" });
    } else if (step === "send_blocked_risk_or_confidence" || step === "send_blocked_duplicate") {
      pushToast({ title: "Auto-send blocked", body: latest.error || "Safety checks blocked automatic send.", tone: "warning" });
    }

    setSeenLogIds((prev) => [...prev.slice(-99), latest.id]);
  }, [detail, pushToast, seenLogIds]);

  const activeAccount = useMemo(() => accounts.find((item) => item.id === accountId) ?? null, [accounts, accountId]);

  const filteredEmails = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const activeStage = stages.find((item) => item.id === stageView) ?? stages[0]!;
    let list = emails.filter((email) => activeStage.matcher(email));

    if (readFilter === "unread") {
      list = list.filter((email) => !email.is_seen);
    } else if (readFilter === "read") {
      list = list.filter((email) => Boolean(email.is_seen));
    }

    if (categoryFilter !== "all") {
      list = list.filter((email) => (email.category ?? "uncategorized") === categoryFilter);
    }

    if (normalized) {
      list = list.filter((email) =>
        [email.subject, email.from_email, email.snippet, email.category, email.state]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalized)),
      );
    }

    return list.sort((a, b) => {
      const ad = Number(a.internal_date ?? 0);
      const bd = Number(b.internal_date ?? 0);
      return (Number.isFinite(bd) ? bd : 0) - (Number.isFinite(ad) ? ad : 0);
    });
  }, [emails, stageView, readFilter, categoryFilter, query]);

  const categories = useMemo(
    () => ["all", ...new Set(filteredEmails.map((email) => email.category).filter((value): value is string => Boolean(value)).sort())],
    [filteredEmails],
  );

  const activeFilterLabel = useMemo(() => {
    const stageLabel = stages.find((stage) => stage.id === stageView)?.label ?? "All";
    const categoryLabel = categoryFilter === "all" ? "Any category" : categoryFilter;
    const readLabel = readFilter === "unread" ? "Unread" : readFilter === "read" ? "Read" : "Any read state";
    return `${stageLabel} · ${readLabel} · ${categoryLabel}`;
  }, [stageView, readFilter, categoryFilter]);

  async function runAction(key: string, fn: () => Promise<void>) {
    setActionLoading(key);
    setUiError(null);
    try {
      await fn();
      setUiError(null);
      void refreshList();
      if (selectedId != null) void loadDetail(selectedId, true);
    } catch (error) {
      setUiError(toAppError(error));
    } finally {
      setActionLoading(null);
    }
  }

  function openEmail(id: number) {
    setSelectedId(id);
    setContextOpen(false);
    void fetch(`/api/emails/${id}/seen`, { method: "PATCH", credentials: "include" })
      .then((res) => {
        if (!res.ok) return;
        setEmails((prev) => prev.map((email) => (email.id === id ? { ...email, is_seen: true } : email)));
      })
      .catch(() => {});
    const params = new URLSearchParams(searchParams.toString());
    params.set("id", String(id));
    params.set("view", stageView);
    router.replace(`/inbox?${params.toString()}`);
  }

  function closeThread() {
    setSelectedId(null);
    setDetail(null);
    setContextOpen(false);
    setGenerateDrawerOpen(false);
    setStageMenuOpen(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("id");
    router.replace(`/inbox?${params.toString()}`);
  }

  function toggleGenerateDrawer() {
    setGenerateDrawerOpen((value) => {
      const next = !value;
      if (next) setContextOpen(false);
      return next;
    });
  }

  function toggleContextDrawer() {
    setContextOpen((value) => {
      const next = !value;
      if (next) setGenerateDrawerOpen(false);
      return next;
    });
  }

  function setView(view: StageView) {
    setStageView(view);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    router.replace(`/inbox?${params.toString()}`);
  }

  function chooseCategory(category: string) {
    setCategoryFilter(category);
    setStageMenuOpen(false);
  }

  const autoModeActive = runtimeConfig?.global_mode === "auto" || detail?.decision === "auto";
  const detailGmailUrl = detail
    ? buildGmailUrl({
        thread_id: detail.raw_email?.thread_id ?? undefined,
        gmail_id: detail.gmail_id ?? undefined,
      })
    : null;

  if (selectedId != null) {
    return (
      <div className="relative h-full min-h-0 overflow-hidden bg-[color:var(--surface-secondary)]">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b app-border bg-[color:var(--surface-elevated)] px-4 py-3 md:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <button type="button" onClick={closeThread} className="app-button-secondary inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs">
                  <ArrowLeft className="h-4 w-4" />
                  Inbox
                </button>
                {activeAccount && <span className="app-chip max-w-[280px] truncate rounded-full px-3 py-1 text-[11px]">Sending as {activeAccount.email}</span>}
              </div>

              <div className="flex w-full items-center gap-2 overflow-x-auto md:w-auto md:flex-wrap">
                {autoModeActive && <span className="app-state-awaiting rounded-full px-3 py-1.5 text-[11px] font-medium">Auto mode active</span>}
                <button type="button" onClick={toggleGenerateDrawer} className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs ${generateDrawerOpen ? "app-button-primary" : "app-button-secondary"}`}>
                  <WandSparkles className="h-3.5 w-3.5" />
                  Generate
                </button>
                <button type="button" onClick={toggleContextDrawer} disabled={actionLoading != null || !detail} className={`rounded-full px-3 py-2 text-xs ${contextOpen ? "app-button-primary" : "app-button-secondary"}`}>
                  Context
                </button>
                {detailGmailUrl && (
                  <button
                    type="button"
                    onClick={() => window.open(detailGmailUrl, "_blank", "noopener,noreferrer")}
                    className="app-button-secondary inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Gmail
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    detail &&
                    void runAction(`archive-${detail.id}`, async () => {
                      await fetchJsonWithAppError(`/api/emails/${detail.id}/archive`, { method: "POST" }, { retries: 1 });
                      closeThread();
                    })
                  }
                  disabled={actionLoading != null || !detail}
                  className="app-button-secondary rounded-full px-3 py-2 text-xs"
                >
                  Archive
                </button>
              </div>
            </div>
            {uiError && (
              <div className="mt-3">
                <InlineErrorCard
                  error={uiError}
                  onRetry={async () => {
                    if (selectedId != null) {
                      await loadDetail(selectedId);
                    }
                  }}
                />
              </div>
            )}
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {detailLoading && !detail && <EmailDetailSkeleton />}
            {detail && <ThreadDocument detail={detail as never} />}

            {generateDrawerOpen && detail && (
              <aside className="absolute inset-y-0 right-0 z-30 w-full border-l app-border bg-[color:var(--surface-elevated)] shadow-xl md:max-w-[420px]">
                <div className="border-b app-border px-5 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.12em] app-text-faint">
                      <WandSparkles className="h-3.5 w-3.5" /> Generate Studio
                    </div>
                    <button type="button" className="app-button-secondary rounded-full p-2 md:hidden" onClick={() => setGenerateDrawerOpen(false)}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <h3 className="mt-2 text-lg font-semibold app-text-primary">Draft Controls</h3>
                  <p className="mt-1 text-xs app-text-muted">Generate a fresh draft with visible progress and current classification context.</p>
                </div>

                <div className="space-y-4 px-5 py-5">
                  <div className="rounded-xl app-input px-4 py-3 text-xs app-text-secondary">
                    <div>Category: {detail.category ?? "uncategorized"}</div>
                    <div className="mt-1">Decision: {detail.decision ?? "assist"}</div>
                    <div className="mt-1">Step: {detail.last_step?.replaceAll("_", " ") ?? detail.state?.replaceAll("_", " ") ?? "unknown"}</div>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      void runAction(`gen-${detail.id}`, async () => {
                        await fetchJsonWithAppError(`/api/emails/${detail.id}/generate-draft`, { method: "POST" }, { retries: 1 });
                        setGenerateDrawerOpen(false);
                      })
                    }
                    disabled={actionLoading != null}
                    className="app-button-primary inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
                  >
                    {actionLoading === `gen-${detail.id}` ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Generating draft
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Generate now
                      </>
                    )}
                  </button>
                </div>
              </aside>
            )}

            {contextOpen && detail && (
              <aside className={`absolute inset-y-0 right-0 z-20 w-full border-l app-border bg-[color:var(--surface-elevated)] shadow-xl md:max-w-md ${generateDrawerOpen ? "md:mr-[420px]" : ""}`}>
                <button type="button" className="absolute right-3 top-3 z-10 app-button-secondary rounded-full p-2 md:hidden" onClick={() => setContextOpen(false)}>
                  <X className="h-4 w-4" />
                </button>
                <EmailMetadataPanel detail={detail as never} title="Context and transparency" />
              </aside>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--surface-elevated)]">
      <PageHeader
        title="Inbox"
        subtitle="Minimal triage with inline decisions."
        collapsed={heroCollapsed}
        compactLabel="Inbox"
        rightAction={
          <button type="button" onClick={() => void refreshList()} className="app-button-secondary inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs">
            <RefreshCcw className={`h-4 w-4 ${listLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {!heroCollapsed && runtimeConfig?.global_mode === "auto" && (
        <div className="border-b app-border px-4 py-3 md:px-6">
          <div className="rounded-lg app-state-awaiting px-3 py-2 text-xs font-medium">
            Auto mode is enabled globally. Generated replies may advance to send flow automatically.
          </div>
        </div>
      )}

      {uiError && (
        <div className="px-4 pt-3 md:px-6">
          <InlineErrorCard
            error={uiError}
            onRetry={async () => {
              await refreshList();
              if (selectedId != null) {
                await loadDetail(selectedId, true);
              }
            }}
          />
        </div>
      )}

      <div className="sticky top-0 z-30 border-b app-border bg-[color:var(--surface-elevated)] px-4 py-4 shadow-sm md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="ml-auto flex w-full items-center gap-2 md:w-auto">
            {activeAccount && <span className="app-chip max-w-[220px] truncate rounded-full px-3 py-1 text-[11px]">{activeAccount.email}</span>}

            <div className="app-input flex w-full min-w-0 items-center gap-2 rounded-full px-3 py-2 md:min-w-[240px]">
              <Search className="h-4 w-4 app-text-faint" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sender, subject, text"
                className="w-full bg-transparent text-sm app-text-primary focus:outline-none"
              />
            </div>

            <div className="relative">
              <button type="button" onClick={() => setStageMenuOpen((value) => !value)} className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs ${stageMenuOpen ? "app-button-primary" : "app-button-secondary"}`}>
                <Filter className="h-3.5 w-3.5" />
                Stage
                <ChevronDown className="h-3.5 w-3.5" />
              </button>

              {stageMenuOpen && (
                <div className="app-popover absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[240px] rounded-[20px] p-3">
                  <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] app-text-faint">Stage filters</div>
                  <div className="space-y-2">
                    {stages.map((stage) => {
                      const active = stage.id === stageView;
                      const count = emails.filter(stage.matcher).length;
                      return (
                        <button
                          key={stage.id}
                          type="button"
                          onClick={() => {
                            setView(stage.id);
                            setStageMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium app-motion-fast ${active ? "app-accent-bg" : "app-hover-soft"}`}
                        >
                          <span>{stage.label}</span>
                          <span className="app-text-faint">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setReadFilter("all")}
              className={`rounded-full px-3 py-1 text-[11px] font-medium ${readFilter === "all" ? "app-button-primary" : "app-button-secondary"}`}
            >
              All mail
            </button>
            <button
              type="button"
              onClick={() => setReadFilter("unread")}
              className={`rounded-full px-3 py-1 text-[11px] font-medium ${readFilter === "unread" ? "app-button-primary" : "app-button-secondary"}`}
            >
              Unread
            </button>
            <button
              type="button"
              onClick={() => setReadFilter("read")}
              className={`rounded-full px-3 py-1 text-[11px] font-medium ${readFilter === "read" ? "app-button-primary" : "app-button-secondary"}`}
            >
              Read
            </button>
            {categories.map((category) => {
              const count = filteredEmails.filter((email) => (email.category ?? "uncategorized") === category).length;
              const active = categoryFilter === category;
              const label = category === "all" ? "All categories" : category;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => chooseCategory(active ? "all" : category)}
                  className={`max-w-[15rem] truncate rounded-full px-3 py-1 text-[11px] font-medium ${active ? "app-button-primary" : "app-category-token"}`}
                  style={category === "all" ? undefined : getCategoryTone(category, runtimeConfig?.category_colors)}
                >
                  {label} · {count}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full app-input px-3 py-1.5 text-xs app-text-muted">
          Current filter: <span className="font-medium app-text-secondary">{activeFilterLabel}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <EmailList
          emails={filteredEmails}
          selectedId={selectedId}
          {...(runtimeConfig?.category_colors ? { categoryColors: runtimeConfig.category_colors } : {})}
          onSelect={openEmail}
          onGenerate={(id: number) =>
            void runAction(`gen-${id}`, async () => {
              await fetchJsonWithAppError(`/api/emails/${id}/generate-draft`, { method: "POST" }, { retries: 1 });
            })
          }
          onSend={(id: number) =>
            void runAction(`send-${id}`, async () => {
              const email = emails.find((item) => item.id === id);
              const draftId = email?.draft?.id;
              if (!draftId) {
                openEmail(id);
                throw new Error("Open thread to review draft before sending.");
              }

              if (email?.state === "AWAITING_REVIEW") {
                await fetchJsonWithAppError(`/api/drafts/${draftId}/approve-send`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({}),
                }, { retries: 1 });
                pushToast({ title: "Reply queued", body: "Draft approved and moved to send pipeline.", tone: "success" });
                return;
              }

              await fetchJsonWithAppError("/api/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ draftId }),
              }, { retries: 1 });
              pushToast({ title: "Reply queued", body: "Draft moved to send pipeline.", tone: "success" });
            })
          }
          onArchive={(id: number) =>
            void runAction(`archive-${id}`, async () => {
              await fetchJsonWithAppError(`/api/emails/${id}/archive`, { method: "POST" }, { retries: 1 });
            })
          }
          onToggleSeen={(id: number) =>
            void runAction(`seen-${id}`, async () => {
              const row = emails.find((item) => item.id === id);
              const nextSeen = !(row?.is_seen ?? false);
              await fetchJsonWithAppError(
                `/api/emails/${id}/seen`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ isSeen: nextSeen }),
                },
                { retries: 1 },
              );
              setEmails((prev) => prev.map((item) => (item.id === id ? { ...item, is_seen: nextSeen } : item)));
            })
          }
          onOpenInGmail={(id: number) => {
            const row = emails.find((item) => item.id === id);
            if (!row) return;
            const target = buildGmailUrl(row);
            if (!target) return;
            window.open(target, "_blank", "noopener,noreferrer");
          }}
          actionLoading={actionLoading}
          onLoadMore={() => nextCursor && refreshList(nextCursor)}
          hasMore={hasMore}
          isLoading={listLoading}
          emptyMessage="No messages matched the current filters."
          onScrollPositionChange={handleListScrollTop}
        />
      </div>

      <div className="border-t app-border bg-[color:var(--surface-elevated)] px-4 py-3 md:px-6">
        <div className="inline-flex items-center gap-2 text-xs app-text-muted">
          <Sparkles className="h-3.5 w-3.5" />
          Open any message for thread mode. Gmail-like shortcuts: press / to jump to search.
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`pointer-events-auto rounded-xl border px-3 py-2 shadow-lg ${
                toast.tone === "success" ? "app-state-success" : toast.tone === "warning" ? "app-state-awaiting" : "app-state-ready"
              }`}
            >
              <div className="flex items-start gap-2">
                <BellRing className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold app-text-primary">{toast.title}</div>
                  <div className="mt-0.5 text-[11px] app-text-secondary">{toast.body}</div>
                </div>
                <button type="button" className="app-text-tertiary" onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
