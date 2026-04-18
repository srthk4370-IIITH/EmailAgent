"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCcw, Search, TerminalSquare } from "lucide-react";
import { useScrollCollapse } from "../../components/layout/useScrollCollapse";

type ActivityLog = {
  id: number;
  trace_id: string;
  gmail_id: string | null;
  step: string;
  state: string;
  latency_ms: number;
  error: string | null;
  meta: unknown;
  created_at: string;
  email_id?: number | null;
  subject?: string;
  source?: string;
  embedding_status?: string;
};

type TraceLookupResponse = {
  logs?: unknown[];
  resolved_trace_id?: string | null;
  candidates?: string[];
  matched_by?: string;
  hint?: string;
};

const ACTIVITY_CACHE_KEY = "logs:activity:v2";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function readCachedActivity(): ActivityLog[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(ACTIVITY_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { logs?: ActivityLog[] } | null;
    return Array.isArray(parsed?.logs) ? parsed.logs : [];
  } catch {
    return [];
  }
}

function writeCachedActivity(logs: ActivityLog[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      ACTIVITY_CACHE_KEY,
      JSON.stringify({ logs: logs.slice(0, 240), cachedAt: Date.now() }),
    );
  } catch {
    // Cache is best-effort only.
  }
}

export default function LogsPage() {
  const [tab, setTab] = useState<"activity" | "trace">("activity");
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [traceId, setTraceId] = useState("");
  const [traceLogs, setTraceLogs] = useState<unknown[] | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceMeta, setTraceMeta] = useState<{
    resolvedTraceId: string | null;
    candidates: string[];
    matchedBy: string;
    hint?: string;
  } | null>(null);
  const { collapsed: heroCollapsed, onScroll: onLogsScroll, setCollapsed: setHeroCollapsed } = useScrollCollapse({ threshold: 72 });

  const loadActivity = useCallback(async () => {
    if (logs.length === 0) setLoading(true);
    try {
      const res = await fetch("/api/logs/activity?limit=140", { credentials: "include" });
      const json = (await res.json()) as { logs?: ActivityLog[] };
      const nextLogs = Array.isArray(json.logs) ? json.logs : [];
      setLogs(nextLogs);
      writeCachedActivity(nextLogs);
    } finally {
      setLoading(false);
    }
  }, [logs.length]);

  useEffect(() => {
    const cached = readCachedActivity();
    if (cached.length > 0) {
      setLogs(cached);
    }
  }, []);

  useEffect(() => {
    if (tab !== "activity") return;
    void loadActivity();

    function tick() {
      if (document.visibilityState !== "visible") return;
      void loadActivity();
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        void loadActivity();
      }
    }

    const timer = setInterval(tick, 7000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, loadActivity]);

  useEffect(() => {
    setHeroCollapsed(false);
  }, [tab, setHeroCollapsed]);

  const loadTrace = useCallback(
    async (overrideTraceId?: string) => {
      const lookupInput = (overrideTraceId ?? traceId).trim();
      if (!lookupInput) {
        setTraceError("Enter a trace id or Gmail id.");
        setTraceLogs(null);
        setTraceMeta(null);
        return;
      }

      setTraceError(null);
      try {
        const res = await fetch(`/api/logs?trace_id=${encodeURIComponent(lookupInput)}`, { credentials: "include" });
        const data = (await res.json()) as TraceLookupResponse;
        const foundLogs = Array.isArray(data.logs) ? data.logs : [];

        setTraceLogs(foundLogs);
        setTraceMeta({
          resolvedTraceId: data.resolved_trace_id ?? null,
          candidates: Array.isArray(data.candidates) ? data.candidates : [],
          matchedBy: data.matched_by ?? "none",
          ...(data.hint ? { hint: data.hint } : {}),
        });

        if (foundLogs.length === 0) {
          setTraceError(data.hint ?? "No logs found for that lookup value.");
        } else if (data.resolved_trace_id && data.resolved_trace_id !== lookupInput) {
          setTraceId(data.resolved_trace_id);
        }
      } catch {
        setTraceError("Failed to load logs.");
        setTraceLogs(null);
        setTraceMeta(null);
      }
    },
    [traceId],
  );

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((log) =>
      [log.step, log.state, log.subject, log.trace_id, log.error, log.embedding_status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [logs, query]);

  const metrics = useMemo(
    () => ({
      total: logs.length,
      errors: logs.filter((log) => Boolean(log.error)).length,
      embedding: logs.filter((log) => log.step.includes("EMBED")).length,
    }),
    [logs],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!heroCollapsed && (
        <section className="panel-surface rounded-[18px] px-5 py-5 md:px-6 md:py-6">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-3xl">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-accent-text">Observability</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">Audit the pipeline without leaving the app.</h1>
              <p className="mt-4 text-sm leading-7 app-text-secondary">
                Search recent activity, inspect failures, and load full traces from the same page.
              </p>
            </div>
            <div className="grid min-w-[280px] gap-3 sm:grid-cols-3">
              <MetricCard label="Events" value={metrics.total} />
              <MetricCard label="Errors" value={metrics.errors} />
              <MetricCard label="Embedding" value={metrics.embedding} />
            </div>
          </div>
        </section>
      )}

      <section className="panel-surface mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px]">
        <div className="border-b app-border px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>Activity</TabButton>
              <TabButton active={tab === "trace"} onClick={() => setTab("trace")}>Trace lookup</TabButton>
            </div>
            {tab === "activity" && (
              <button
                type="button"
                onClick={() => void loadActivity()}
                disabled={loading}
                className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-40"
              >
                <RefreshCcw className={`h-4 w-4 app-accent-text ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            )}
          </div>
        </div>

        {tab === "activity" && (
          <>
            <div className="border-b app-border px-5 py-4">
              <div className="app-input flex items-center gap-3 rounded-full px-4 py-3">
                <Search className="h-4 w-4 app-text-faint" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search step, trace, subject, state, error"
                  className="w-full bg-transparent text-sm app-text-primary focus:outline-none"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4" onScroll={onLogsScroll}>
              <div className="space-y-3">
                {filteredLogs.length === 0 && (
                  <div className="rounded-[18px] border border-dashed app-border px-6 py-16 text-center app-text-muted">
                    No activity matched your filters.
                  </div>
                )}
                {filteredLogs.map((log) => {
                  const destination =
                    typeof log.email_id === "number"
                      ? log.source === "sent" || log.state === "SENT"
                        ? `/sent?id=${log.email_id}`
                        : `/inbox?id=${log.email_id}`
                      : null;

                  const cardBody = (
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium app-text-primary">{log.subject || "System process"}</div>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs app-text-muted">
                          <span>{log.step}</span>
                          <span>{log.state}</span>
                          {log.trace_id && <span>{log.trace_id}</span>}
                          {log.latency_ms > 0 && <span>{log.latency_ms}ms</span>}
                          {log.embedding_status && log.embedding_status !== "pending" && <span>{log.embedding_status}</span>}
                          {destination && <span>Open message</span>}
                        </div>
                        {log.error && (
                          <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {log.error}
                          </div>
                        )}
                      </div>
                      <div className="text-xs app-text-muted">{formatTime(log.created_at)}</div>
                    </div>
                  );

                  if (destination) {
                    return (
                      <Link key={log.id} href={destination} className="app-input app-hover-soft block rounded-[18px] px-4 py-4">
                        {cardBody}
                      </Link>
                    );
                  }

                  return (
                    <button
                      key={log.id}
                      type="button"
                      onClick={() => {
                        setTab("trace");
                        setTraceId(log.trace_id);
                        void loadTrace(log.trace_id);
                      }}
                      className="app-input app-hover-soft block w-full rounded-[18px] px-4 py-4 text-left"
                    >
                      {cardBody}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {tab === "trace" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-5">
            <div className="flex min-h-0 max-w-4xl flex-1 flex-col space-y-4">
              <div className="app-input rounded-[18px] px-4 py-4">
                <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">
                  <TerminalSquare className="h-3.5 w-3.5 app-accent-text" />
                  Trace explorer
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <input
                    value={traceId}
                    onChange={(event) => setTraceId(event.target.value)}
                    placeholder="Paste trace_id or Gmail id"
                    className="app-input-strong app-focus-ring min-w-[280px] flex-1 rounded-full px-4 py-3 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void loadTrace()}
                    className="app-button-primary rounded-full px-5 py-3 text-sm font-medium transition"
                  >
                    Load trace
                  </button>
                </div>

                {traceMeta && (
                  <div className="mt-3 text-xs app-text-muted">
                    {traceMeta.resolvedTraceId && (
                      <div>
                        Matched by {traceMeta.matchedBy}. Active trace: <span className="font-medium app-text-primary">{traceMeta.resolvedTraceId}</span>
                      </div>
                    )}
                    {traceMeta.candidates.length > 1 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {traceMeta.candidates.map((candidate) => (
                          <button
                            key={candidate}
                            type="button"
                            onClick={() => {
                              setTraceId(candidate);
                              void loadTrace(candidate);
                            }}
                            className="app-chip rounded-full px-2.5 py-1 text-[11px]"
                          >
                            {candidate}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {traceError && <div className="rounded-[18px] border border-red-200 bg-red-50 p-4 text-sm text-red-700">{traceError}</div>}

              {traceLogs && (
                <pre className="min-h-0 flex-1 overflow-auto rounded-[18px] app-input-strong p-5 text-xs leading-6 app-text-secondary" onScroll={onLogsScroll}>
                  {JSON.stringify(traceLogs, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
        active ? "app-button-primary" : "app-button-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="app-input-strong rounded-[18px] px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">{value}</div>
    </div>
  );
}
