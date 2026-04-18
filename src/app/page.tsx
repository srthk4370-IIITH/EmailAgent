"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, MailPlus, Sparkles, WandSparkles } from "lucide-react";
import { useScrollCollapse } from "../components/layout/useScrollCollapse";

type EmailRow = {
  id: number;
  subject: string;
  state: string;
  review_outcome?: string | null;
  category?: string | null;
  source?: string;
  is_seen?: boolean;
};

type SystemCheck = {
  pipeline_ok: boolean;
  gmail_sync_ok: boolean;
  duplicates: number;
  stuck_emails: number;
  last_processed_at: string | null;
  setup_required?: boolean;
  db_connected: boolean;
  primary_user_ok: boolean;
  gmail_token_ok: boolean;
};

type Config = {
  global_mode: string;
  send_mode: string;
  threshold: number;
};

type ConnectionStatus = {
  ok: boolean;
  error: string | null;
  cause?: string | null;
  fix?: string | null;
  lastCheckedAt?: string;
};

type SyncStatus = {
  counts: {
    pending: number;
    embedded: number;
    failed: number;
  };
  totalSent: number;
  estimatedPendingChunks: number;
  sync_running: boolean;
};

type DashboardCachePayload = {
  emails?: EmailRow[];
  config?: Config | null;
  health?: SystemCheck | null;
  syncStatus?: SyncStatus | null;
  connections?: Record<string, ConnectionStatus>;
};

const DASHBOARD_CACHE_KEY = "dashboard:home:v2";

function readDashboardCache(): DashboardCachePayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as DashboardCachePayload) ?? null;
  } catch {
    return null;
  }
}

function writeDashboardCache(payload: DashboardCachePayload): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({ ...payload, cachedAt: Date.now() }));
  } catch {
    // Cache is best-effort only.
  }
}

function formatLastProcessed(iso: string | null): string {
  if (!iso) return "Waiting for activity";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function DashboardPage() {
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [health, setHealth] = useState<SystemCheck | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [remindLater, setRemindLater] = useState(false);
  const [connections, setConnections] = useState<Record<string, ConnectionStatus>>({});
  const { collapsed: heroCollapsed, onScroll: onDashboardScroll } = useScrollCollapse({ threshold: 72 });

  useEffect(() => {
    const cached = readDashboardCache();
    if (!cached) return;
    if (Array.isArray(cached.emails)) setEmails(cached.emails);
    if (cached.config) setConfig(cached.config);
    if (cached.health) setHealth(cached.health);
    if (cached.syncStatus) setSyncStatus(cached.syncStatus);
    if (cached.connections) setConnections(cached.connections);
  }, []);

  const refresh = useCallback(async () => {
    const [emailsRes, configRes, healthRes, syncRes] = await Promise.all([
      fetch("/api/emails?filter=all", { credentials: "include" }),
      fetch("/api/config", { credentials: "include" }),
      fetch("/api/system/check", { credentials: "include" }),
      fetch("/api/sync/status", { credentials: "include" }),
    ]);

    const connectionsRes = await fetch("/api/system/connections", { credentials: "include" });

    const emailsJson = (await emailsRes.json()) as { emails?: EmailRow[] };
    const configJson = (await configRes.json()) as Config;
    const nextEmails = emailsJson.emails ?? [];
    setEmails(nextEmails);
    setConfig(configJson);
    let nextSyncStatus: SyncStatus | null = null;
    let nextConnections: Record<string, ConnectionStatus> = {};
    let nextHealth: SystemCheck | null = null;

    if (syncRes.ok) {
      nextSyncStatus = (await syncRes.json()) as SyncStatus;
      setSyncStatus(nextSyncStatus);
    }
    if (connectionsRes.ok) {
      nextConnections = (await connectionsRes.json()) as Record<string, ConnectionStatus>;
      setConnections(nextConnections);
    }
    if (healthRes.ok) {
      nextHealth = (await healthRes.json()) as SystemCheck;
      setHealth(nextHealth);
    }

    writeDashboardCache({
      emails: nextEmails,
      config: configJson,
      health: nextHealth,
      syncStatus: nextSyncStatus,
      connections: nextConnections,
    });
  }, []);

  const retryConnections = useCallback(async () => {
    const res = await fetch("/api/system/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: ["db", "openai", "gmail"] }),
      credentials: "include",
    });
    if (res.ok) {
      setConnections((await res.json()) as Record<string, ConnectionStatus>);
    }
  }, []);

  useEffect(() => {
    void refresh();

    function tick() {
      if (document.visibilityState !== "visible") return;
      void refresh();
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }

    const timer = setInterval(tick, 10000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const counts = useMemo(() => {
    const byState = new Map<string, number>();
    for (const email of emails) byState.set(email.state, (byState.get(email.state) ?? 0) + 1);
    return {
      unreadInbox: emails.filter((email) => email.source === "inbox" && email.is_seen === false).length,
      generated: byState.get("GENERATED") ?? 0,
      readyToGenerate: byState.get("READY_TO_GENERATE") ?? 0,
      errors: emails.filter((email) => email.state.startsWith("ERROR") || email.state === "DEAD").length,
    };
  }, [emails]);

  const recent = useMemo(() => emails.slice(0, 8), [emails]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" onScroll={onDashboardScroll}>
      {!heroCollapsed && health?.setup_required && !remindLater && (
        <section className="rounded-lg app-state-awaiting border px-5 py-5 mb-2">
          <div className="flex flex-col gap-6">
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full app-state-awaiting">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-xl font-bold app-text-primary tracking-tight">Identity Setup Required</h2>
                  <p className="text-sm app-text-primary mt-1 max-w-xl leading-relaxed">
                    Background synchronization and RAG memory require a connected Google identity. 
                    Please complete the following steps to activate your workspace.
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setRemindLater(true)}
                className="text-xs font-semibold uppercase tracking-wider app-accent-text hover:opacity-70 transition"
              >
                Remind me later
              </button>
            </div>
            
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <SetupStep 
                label="Step 1: Database" 
                ok={health.db_connected} 
                text="PostgreSQL + Vector connected"
              />
              <SetupStep 
                label="Step 2: Google Identity" 
                ok={health.primary_user_ok} 
                text="Create primary user record"
                href="/api/auth/google?prompt=consent%20select_account"
                actionText="Sign in with Google"
              />
              <SetupStep 
                label="Step 3: Gmail Access" 
                ok={health.gmail_token_ok} 
                text="Enable background sync"
                href="/api/auth/google?prompt=consent%20select_account"
                actionText="Authorize Gmail"
              />
            </div>
          </div>
        </section>
      )}

      {!heroCollapsed && (
        <section className="panel-surface rounded-[20px] px-5 py-5 md:px-6 md:py-6">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] app-accent-text">
              <Sparkles className="h-3.5 w-3.5" />
              Mail workspace
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight app-text-primary">
              A calmer control surface for your inbox, drafts, sent memory, and sync system.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 app-text-secondary">
              Everything important stays in the UI: triage incoming mail, review drafts, inspect sent-memory retrieval,
              and monitor pipeline health without dropping into the terminal.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/compose" className="app-button-primary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition">
                <MailPlus className="h-4 w-4" />
                Compose
              </Link>
              <Link href="/inbox?view=ready" className="app-button-secondary inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition">
                <WandSparkles className="h-4 w-4 app-accent-text" />
                Ready to generate
              </Link>
            </div>
          </div>

          <div className="grid min-w-[300px] gap-3 sm:grid-cols-2">
            <InfoCard label="Reasoning mode" value={config?.global_mode ?? "assist"} />
            <InfoCard label="Send mode" value={config?.send_mode ?? "dry"} />
            <InfoCard label="Confidence" value={config ? `${Math.round(config.threshold * 100)}%` : "70%"} />
            <InfoCard label="Last activity" value={formatLastProcessed(health?.last_processed_at ?? null)} />
          </div>
        </div>
        </section>
      )}

      <section className="grid gap-3 lg:grid-cols-4">
        <MetricPanel title="Inbox" value={counts.unreadInbox} href="/inbox" subtitle="unopened" />
        <MetricPanel title="Generated" value={counts.generated} href="/drafts" subtitle="generated mails" />
        <MetricPanel title="Ready to generate" value={counts.readyToGenerate} href="/inbox?view=ready" subtitle="mail waiting in queue" />
        <MetricPanel title="Embeds" value={syncStatus?.counts.embedded ?? 0} href="/logs" subtitle="embedded mails" />
      </section>

      {Object.keys(connections).length > 0 && (
        <section className="panel-surface rounded-[16px] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Connections</div>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight app-text-primary">Live dependency status with fixes.</h2>
            </div>
            <button
              type="button"
              onClick={() => void retryConnections()}
              className="app-button-secondary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium"
            >
              Retry checks
            </button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {Object.entries(connections).map(([name, status]) => (
              <div key={name} className="rounded-[18px] app-input-strong px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{name}</div>
                <div className="mt-2 text-sm font-medium app-text-primary">{status.ok ? "Connected" : status.error}</div>
                {!status.ok && (
                  <div className="mt-2 text-xs app-text-muted">
                    <div>Cause: {status.cause ?? "unknown"}</div>
                    <div>Fix: {status.fix ?? "retry checks"}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="panel-surface rounded-[16px] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Queues</div>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight app-text-primary">Focus on the next useful lane.</h2>
            </div>
            <Link href="/inbox" className="inline-flex items-center gap-2 text-sm font-medium app-accent-text hover:opacity-70">
              Open inbox
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-5 grid gap-3">
            <QueueLink title="Ready to generate" body="Messages classified and waiting for manual generation." href="/inbox?view=ready_to_generate" count={counts.readyToGenerate} />
            <QueueLink title="Generated" body="Drafts already generated and ready for review." href="/drafts" count={counts.generated} />
            <QueueLink title="Embeds" body="Outbound emails already embedded for retrieval." href="/logs" count={syncStatus?.counts.embedded ?? 0} />
          </div>
        </div>

        <div className="panel-surface rounded-[16px] p-5">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Health</div>
          <div className="mt-4 space-y-3">
            <HealthRow label="Pipeline" ok={health?.pipeline_ok ?? false} good="Healthy" bad="Needs attention" />
            <HealthRow label="Gmail sync" ok={health?.gmail_sync_ok ?? false} good="Connected" bad="Disconnected" />
            <InfoCard label="Potential duplicates" value={String(health?.duplicates ?? 0)} />
            <InfoCard label="Stuck emails" value={String(health?.stuck_emails ?? 0)} />
            <InfoCard label="Errors" value={String(counts.errors)} />
          </div>
        </div>
      </section>

      <section className="panel-surface rounded-[16px] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">Recent activity</div>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight app-text-primary">Latest movement across the mailbox.</h2>
          </div>
          <Link href="/logs" className="text-sm font-medium app-accent-text hover:opacity-70">
            Open logs
          </Link>
        </div>

        <div className="mt-5 space-y-3">
          {recent.length === 0 && (
            <div className="rounded-[20px] border border-dashed app-border px-6 py-16 text-center app-text-muted">
              No activity has been recorded yet.
            </div>
          )}
          {recent.map((email) => (
            <Link
              key={email.id}
              href={email.source === "sent" || email.state === "SENT" ? `/sent?id=${email.id}` : `/inbox?id=${email.id}`}
              className="app-input-strong app-hover-soft flex items-center justify-between gap-4 rounded-[18px] px-4 py-4 transition"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium app-text-primary">{email.subject || "(no subject)"}</div>
                <div className="mt-1 text-xs app-text-muted">
                  {email.category ?? "uncategorized"} {email.review_outcome === "rejected" ? "• rejected" : ""}
                </div>
              </div>
              <div className="text-xs font-medium app-text-muted">{email.state.replaceAll("_", " ")}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
 
function SetupStep({ label, ok, text, href, actionText }: { label: string; ok: boolean; text: string; href?: string; actionText?: string }) {
  const content = (
    <>
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] app-accent-text/80 mb-1">{label}</div>
      <div className="flex items-center gap-3">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 app-state-success shrink-0" />
        ) : (
          <div className="h-4 w-4 rounded-full border-2 border-dashed border-[color:var(--color-warning)] shrink-0" />
        )}
        <div className={`text-xs font-medium ${ok ? 'app-text-tertiary' : 'app-text-primary'}`}>{text}</div>
      </div>
      {!ok && href && (
        <div className="mt-3">
          <span className="inline-flex items-center gap-1 text-[11px] font-bold app-accent-text hover:opacity-70 transition">
            {actionText}
            <ArrowRight className="h-3 w-3" />
          </span>
        </div>
      )}
    </>
  );

  if (!ok && href) {
    return (
      <Link href={href} className="flex flex-col rounded-2xl bg-white border border-amber-200 p-4 shadow-sm hover:border-amber-400 transition">
        {content}
      </Link>
    );
  }

  return (
    <div className={`flex flex-col rounded-lg border p-4 ${ok ? 'bg-[color:var(--accent-soft)] border-[color:var(--accent-primary)]/30' : 'bg-[color:var(--surface-secondary)] border-[color:var(--border-soft)]'}`}>
      {content}
    </div>
  );
}

function MetricPanel({ title, value, href, subtitle }: { title: string; value: number; href: string; subtitle?: string }) {
  return (
    <Link href={href} className="panel-surface app-hover-soft rounded-[22px] px-5 py-5 transition">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{title}</div>
      <div className="mt-3 text-3xl font-semibold tracking-tight app-text-primary">{value}</div>
      {subtitle && <div className="mt-2 text-xs app-text-muted">{subtitle}</div>}
    </Link>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] app-input-strong px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-muted">{label}</div>
      <div className="mt-2 text-sm font-medium app-text-primary">{value}</div>
    </div>
  );
}

function QueueLink({ title, body, href, count }: { title: string; body: string; href: string; count: number }) {
  return (
    <Link href={href} className="app-input-strong app-hover-soft rounded-[18px] px-5 py-4 transition">
      <div className="flex items-center justify-between gap-3">
        <div className="text-base font-medium app-text-primary">{title}</div>
        <div className="text-sm font-semibold app-accent-text">{count}</div>
      </div>
      <div className="mt-2 text-sm leading-6 app-text-secondary">{body}</div>
    </Link>
  );
}

function HealthRow({ label, ok, good, bad }: { label: string; ok: boolean; good: string; bad: string }) {
  return (
    <div className="app-input-strong flex items-center justify-between rounded-lg px-4 py-4">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.18em] app-text-tertiary">{label}</div>
        <div className="mt-1 text-sm font-medium app-text-primary">{ok ? good : bad}</div>
      </div>
      {ok ? <CheckCircle2 className="h-5 w-5 app-state-success" /> : <AlertTriangle className="h-5 w-5 app-state-awaiting" />}
    </div>
  );
}
